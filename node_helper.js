"use strict";

process.on("unhandledRejection", (reason) => {
  console.error("[MMM-SpotifySonos] Unhandled rejection:", reason && reason.message || reason);
});

const path         = require("path");
const fs           = require("fs");
const https        = require("https");
const http         = require("http");
const { execSync } = require("child_process");

const NodeHelper = require(path.resolve(__dirname, "../../js/node_helper.js"));
const Sonos      = require(path.join(__dirname, "sonos.js"));

const TOKEN_FILE = path.join(__dirname, ".token.json");

// ── Fetch wrapper (tries node-fetch, falls back to native http/https) ─────────
let _fetch;
try {
  _fetch = require(path.join(__dirname, "node_modules", "node-fetch"));
  if (_fetch && _fetch.default) _fetch = _fetch.default;
} catch (e) {
  _fetch = (reqUrl, opts = {}) => new Promise((resolve, reject) => {
    const parsed  = new URL(reqUrl);
    const isHttps = parsed.protocol === "https:";
    const lib     = isHttps ? https : http;
    const req = lib.request({
      hostname:           parsed.hostname,
      port:               parsed.port || (isHttps ? 443 : 80),
      path:               parsed.pathname + parsed.search,
      method:             opts.method || "GET",
      headers:            opts.headers || {},
      rejectUnauthorized: false
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({
        ok:   res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        json: () => Promise.resolve(JSON.parse(data)),
        text: () => Promise.resolve(data)
      }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── NodeHelper ────────────────────────────────────────────────────────────────
module.exports = NodeHelper.create({

  start() {
    this.config             = null;
    this.accessToken        = null;
    this.refreshToken       = null;
    this.tokenExpiry        = 0;
    this._authServerRunning = false;
    this.sonosGroups          = [];   // current group topology
    this._discoveryDone       = false;
    this._groupPollTimer      = null;
    this._activeGroupId       = null;   // derived from _activeCoordinatorIp each refresh
    this._activeCoordinatorIp = null;   // STABLE: physical IP of playing coordinator
    this._uriCache            = {};     // ip → {uri, meta} saved before pause
    this._loadToken();
    console.log("[MMM-SpotifySonos] node_helper started");
  },

  // ── Socket notifications ──────────────────────────────────────────────────
  async socketNotificationReceived(notification, payload) {
    switch (notification) {

      case "INIT":
        this.config = payload;
        if (!this.accessToken && !this.refreshToken) this._startAuthServer();
        await this._sonosDiscover();
        break;

      case "GET_SPOTIFY":
        await this._spotifyState();
        break;

      case "PLAY":
        // Try UPnP on active group first, Spotify API as fallback
        if (this._activeGroupId) {
          const g = this._findGroup(this._activeGroupId);
          if (g) { await Sonos.sonosPlay(g.coordinator.ip, g.coordinator.port); break; }
        }
        await this._spotifyCmd("PUT", "me/player/play");
        break;

      case "PAUSE":
        if (this._activeGroupId) {
          const g = this._findGroup(this._activeGroupId);
          if (g) { await Sonos.sonosPause(g.coordinator.ip, g.coordinator.port); break; }
        }
        await this._spotifyCmd("PUT", "me/player/pause");
        break;

      case "NEXT":
        if (this._activeGroupId) {
          const g = this._findGroup(this._activeGroupId);
          if (g) { await Sonos.sonosNext(g.coordinator.ip, g.coordinator.port); break; }
        }
        await this._spotifyCmd("POST", "me/player/next");
        break;

      case "PREV":
        if (this._activeGroupId) {
          const g = this._findGroup(this._activeGroupId);
          if (g) { await Sonos.sonosPrev(g.coordinator.ip, g.coordinator.port); break; }
        }
        await this._spotifyCmd("POST", "me/player/previous");
        break;

      case "GET_ZONES":
        if (!this._discoveryDone) await this._sonosDiscover();
        else this._sendGroups();
        break;

      case "SONOS_PLAY": {
        const group = this._findGroup(payload.groupId);
        if (!group) {
          console.warn(`[MMM-SpotifySonos] SONOS_PLAY: group not found for id="${payload.groupId}"`);
          break;
        }

        const prevGroup = payload.prevGroupId && payload.prevGroupId !== payload.groupId
                       ? this._findGroup(payload.prevGroupId)
                       : null;

        // ── Fast path: try UPnP Play directly ────────────────────────────────
        // Always try Play first — it works instantly if the room has a queue.
        // Only fall into take-over if Play returns an error (empty queue / 500).
        if (prevGroup) {
          // Save URI before pausing so we can restore it on next switch back
          const prevMedia = await Sonos.getMediaInfo(prevGroup.coordinator.ip, prevGroup.coordinator.port);
          if (prevMedia.uri && !prevMedia.uri.startsWith("x-rincon:")) {
            this._uriCache[prevGroup.coordinator.ip] = { uri: prevMedia.uri, meta: prevMedia.meta, uuid: prevGroup.coordinatorUuid };
            console.log(`[MMM-SpotifySonos] Cached URI for "${prevGroup.name}": ${prevMedia.uri.substring(0,50)}`);
          }
          console.log(`[MMM-SpotifySonos] Fast switch: pausing "${prevGroup.name}"`);
          await Sonos.sonosPause(prevGroup.coordinator.ip, prevGroup.coordinator.port);
        }
        // Restore cached URI if available (saved before last pause of this room)
        const cachedMedia = this._uriCache[group.coordinator.ip];
        if (cachedMedia) {
          let restoreUri = cachedMedia.uri;
          // Rewrite VLI UUID to current coordinator UUID
          if (restoreUri.startsWith("x-sonos-vli:") && group.coordinatorUuid) {
            const parts = restoreUri.split(":");
            if (parts.length >= 3) { parts[1] = group.coordinatorUuid; restoreUri = parts.join(":"); }
          }
          console.log(`[MMM-SpotifySonos] Restoring cached URI for "${group.name}": ${restoreUri.substring(0,60)}`);
          await Sonos.setAVTransportURI(group.coordinator.ip, group.coordinator.port, restoreUri, cachedMedia.meta);
          delete this._uriCache[group.coordinator.ip];
        }

        console.log(`[MMM-SpotifySonos] Fast play: "${group.name}" via UPnP → ${group.coordinator.ip}`);
        let playRes = await Sonos.sonosPlay(group.coordinator.ip, group.coordinator.port);

        if (playRes && playRes.status !== 200) {
          // Play failed — try Seek to track 1 then Play (resets queue pointer)
          console.log(`[MMM-SpotifySonos] Play returned ${playRes.status}, trying seek+play`);
          await Sonos.seek(group.coordinator.ip, group.coordinator.port, 1, "0:00:00");
          playRes = await Sonos.sonosPlay(group.coordinator.ip, group.coordinator.port);
        }

        if (playRes && playRes.status === 200) {
          // ✓ Success — room has content and is now playing
          this._setActive(group.coordinator.ip, group.id);
          this.sendSocketNotification("PLAYBACK_MOVED", { activeGroupId: this._activeGroupId, isPlaying: true });
          await this._refreshGroups();
          this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: this._activeGroupId });
          break;
        }

        // Both Play and Seek+Play failed — need to transfer the stream
        console.log(`[MMM-SpotifySonos] UPnP Play failed (status ${playRes ? playRes.status : "?"}), trying take-over`);

        // ── Spotify Connect path ──────────────────────────────────────────────
        const deviceId = await this._spotifyDeviceId(group.name);
        if (deviceId) {
          console.log(`[MMM-SpotifySonos] Switching to "${group.name}" via Spotify API`);
          await this._spotifyTransfer(deviceId, true);
          this._setActive(group.coordinator.ip, group.id);
          this.sendSocketNotification("PLAYBACK_MOVED", { activeGroupId: this._activeGroupId, isPlaying: true });
          this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: this._activeGroupId });
          break;
        }

        // ── Direct URI transfer (fast — no group join/leave needed) ───────────
        // If we have the source URI cached or can fetch it from prevGroup,
        // rewrite the VLI UUID for the target device and play directly.
        if (prevGroup) {
          const srcMedia = this._uriCache[prevGroup.coordinator.ip]
                        || await Sonos.getMediaInfo(prevGroup.coordinator.ip, prevGroup.coordinator.port);

          if (srcMedia && srcMedia.uri && srcMedia.uri.startsWith("x-sonos-vli:")) {
            // Rewrite source UUID → target UUID so the target owns the session
            const parts = srcMedia.uri.split(":");
            if (parts.length >= 3) {
              parts[1] = group.coordinatorUuid;
              const targetUri = parts.join(":");
              console.log(`[MMM-SpotifySonos] Direct URI transfer to "${group.name}": ${targetUri.substring(0, 60)}`);
              await Sonos.setAVTransportURI(
                group.coordinator.ip, group.coordinator.port,
                targetUri, srcMedia.meta || ""
              );
              const directPlay = await Sonos.sonosPlay(group.coordinator.ip, group.coordinator.port);
              if (directPlay && directPlay.status === 200) {
                // Cache the new URI for this device
                this._uriCache[group.coordinator.ip] = { uri: targetUri, meta: srcMedia.meta || "" };
                delete this._uriCache[prevGroup.coordinator.ip];
                this._setActive(group.coordinator.ip, group.id);
                this.sendSocketNotification("PLAYBACK_MOVED", { activeGroupId: this._activeGroupId, isPlaying: true });
                await this._refreshGroups();
                this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: this._activeGroupId });
                break;
              }
              console.log(`[MMM-SpotifySonos] Direct URI transfer failed (${directPlay ? directPlay.status : "?"}), falling back to group take-over`);
            }
          }
        }

        // ── Group take-over: join target with source, then detach source ──────
        if (prevGroup) {
          console.log(`[MMM-SpotifySonos] Take over: joining "${group.name}" into "${prevGroup.name}"`);

          // Step 1: note source media info for logging (stream continues automatically after promotion)
          const sourceMedia = await Sonos.getMediaInfo(
            prevGroup.coordinator.ip, prevGroup.coordinator.port
          );

          // Step 2: join target to source group — both play in sync
          await Sonos.sonosJoinGroup(
            group.coordinator.ip, group.coordinator.port,
            prevGroup.coordinatorUuid
          );
          await new Promise(r => setTimeout(r, 1500));

          // Step 3: source coordinator leaves — target is promoted to coordinator
          console.log(`[MMM-SpotifySonos] "${prevGroup.name}" leaving group`);
          await Sonos.sonosLeaveGroup(prevGroup.coordinator.ip, prevGroup.coordinator.port);
          await new Promise(r => setTimeout(r, 1200));

          // Step 4: pause source (now standalone)
          await Sonos.sonosPause(prevGroup.coordinator.ip, prevGroup.coordinator.port);

          // Step 5: restore the Spotify URI on the target so it can pause/play independently.
          // x-sonos-vli:<srcUUID>:N,spotify:... is the Spotify session URI.
          // We rewrite the UUID to point to the TARGET device, making it self-sufficient.
          // Format: x-sonos-vli:<UUID>:<session>,<spotifyContext>
          let uriToRestore = sourceMedia.uri;
          if (uriToRestore && uriToRestore.startsWith("x-sonos-vli:") && group.coordinatorUuid) {
            // Replace source device UUID with target device UUID in the VLI URI
            const parts = uriToRestore.split(":");
            // parts[0] = "x-sonos-vli", parts[1] = "<srcUUID>", rest = session+spotify
            if (parts.length >= 3) {
              parts[1] = group.coordinatorUuid;
              uriToRestore = parts.join(":");
            }
          }
          console.log(`[MMM-SpotifySonos] Restoring URI on "${group.name}": ${uriToRestore.substring(0,70)}`);
          if (uriToRestore && !uriToRestore.startsWith("x-rincon:")) {
            await Sonos.setAVTransportURI(
              group.coordinator.ip, group.coordinator.port,
              uriToRestore, sourceMedia.meta
            );
          }
          await Sonos.sonosPlay(group.coordinator.ip, group.coordinator.port);

          await this._refreshGroups();
          const refreshed = this.sonosGroups.find(g =>
            g.coordinator.ip === group.coordinator.ip
          );
          this._setActive(group.coordinator.ip, refreshed ? refreshed.id : group.id);
          console.log(`[MMM-SpotifySonos] "${group.name}" is now active (id: ${this._activeGroupId})`);

          this._sendGroups();
          this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: this._activeGroupId });
          break;
        }

        // ── Last resort: nothing playing, UPnP already tried above ───────────
        console.warn(`[MMM-SpotifySonos] Cannot play "${group.name}" — no source and Play failed`);
        break;
      }


      case "SONOS_PAUSE": {
        const group = this._findGroup(payload.groupId);
        if (!group) {
          console.warn(`[MMM-SpotifySonos] SONOS_PAUSE: group not found for id="${payload.groupId}"`);
          break;
        }
        // Pause via Spotify API if the room is a Spotify device, else UPnP
        this._clearActive();
        const pauseDevId = await this._spotifyDeviceId(group.name);
        if (pauseDevId) {
          console.log(`[MMM-SpotifySonos] Pausing "${group.name}" via Spotify API`);
          await this._spotifyCmd("PUT", "me/player/pause");
        } else {
          console.log(`[MMM-SpotifySonos] Pausing "${group.name}" via UPnP`);
          await Sonos.sonosPause(group.coordinator.ip, group.coordinator.port);
        }
        this.sendSocketNotification("PLAYBACK_MOVED", { activeGroupId: null, isPlaying: false });
        this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: null });
        break;
      }

      case "SONOS_VOL": {
        const group = this._findGroup(payload.groupId);
        if (!group) break;
        const step = this.config.volumeStep || 5;
        // Adjust volume on all visible members of the group
        for (const member of group.visibleMembers) {
          try {
            const cur  = await Sonos.sonosGetVolume(member.ip, member.port);
            const next = Math.max(0, Math.min(100,
              payload.dir === "up" ? cur + step : cur - step));
            await Sonos.sonosSetVolume(member.ip, member.port, next);
          } catch (e) { /* skip unresponsive member */ }
        }
        break;
      }

      case "SONOS_REDISCOVER":
        await this._sonosDiscover();
        break;

      // Add a room to the currently active group (multi-room)
      case "SONOS_GROUP_ADD": {
        const targetGroup = this._findGroup(payload.groupId);
        const activeGroup = this._activeGroupId ? this._findGroup(this._activeGroupId) : null;
        if (!targetGroup || !activeGroup) {
          console.warn(`[MMM-SpotifySonos] SONOS_GROUP_ADD: missing group(s)`);
          break;
        }
        console.log(`[MMM-SpotifySonos] Grouping "${targetGroup.name}" with "${activeGroup.name}"`);
        await Sonos.sonosJoinGroup(
          targetGroup.coordinator.ip, targetGroup.coordinator.port,
          activeGroup.coordinatorUuid
        );
        await new Promise(r => setTimeout(r, 800));
        await this._refreshGroups();
        this._syncActiveGroupId();
        this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: this._activeGroupId });
        break;
      }

      // Remove a room from the active group (it becomes standalone)
      case "SONOS_GROUP_REMOVE": {
        const leaveGroup = this._findGroup(payload.groupId);
        if (!leaveGroup) {
          console.warn(`[MMM-SpotifySonos] SONOS_GROUP_REMOVE: group not found`);
          break;
        }

        // Identify the device that is leaving
        const memberDevice = leaveGroup.allMembers.find(m => m.uuid === payload.memberUuid)
                          || leaveGroup.coordinator;
        const isCoordLeaving = memberDevice.uuid === leaveGroup.coordinatorUuid;

        console.log(`[MMM-SpotifySonos] Removing "${memberDevice.name || leaveGroup.name}" from group (isCoord: ${isCoordLeaving})`);

        // Find the device that will REMAIN playing after this leave
        // If the coordinator leaves → the next visible member becomes coordinator (keeps playing)
        // If a member leaves → the coordinator keeps playing
        let remainingIp = null;
        if (isCoordLeaving && leaveGroup.visibleMembers.length > 1) {
          // Find a visible member that is NOT the coordinator — it will be promoted
          const remaining = leaveGroup.visibleMembers.find(m => m.uuid !== leaveGroup.coordinatorUuid);
          if (remaining) remainingIp = remaining.ip;
        } else if (!isCoordLeaving) {
          remainingIp = leaveGroup.coordinator.ip;
        }

        await Sonos.sonosLeaveGroup(memberDevice.ip, memberDevice.port);
        await new Promise(r => setTimeout(r, 1200));

        // Pause the device that left (it's now standalone and silent)
        await Sonos.sonosPause(memberDevice.ip, memberDevice.port);

        // Set active to the remaining IP BEFORE refresh to prevent flash
        if (remainingIp) {
          this._activeCoordinatorIp = remainingIp;
        } else {
          this._activeCoordinatorIp = null;
        }

        // Refresh topology — _syncActiveGroupId will derive correct group ID from IP
        await this._refreshGroups();

        if (remainingIp) {
          const refreshed = this.sonosGroups.find(g => g.coordinator.ip === remainingIp);
          if (refreshed) {
            console.log(`[MMM-SpotifySonos] Active is now "${refreshed.name}" (id: ${this._activeGroupId})`);
          }
        }
        this._sendGroups();
        this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId: this._activeGroupId });
        break;
      }

      // Fix #3: detect which room is currently active (called after browser refresh)
      case "GET_ACTIVE_ZONE":
        await this._detectActiveZone();
        break;
    }
  },

  // ── Fix #3: detect the currently playing Sonos group ─────────────────────
  async _detectActiveZone() {
    if (!this.sonosGroups.length) return;

    // Query Spotify to get the active device id (informational, not strictly needed)
    const token = await this._getToken();
    if (token) {
      try {
        await _fetch("https://api.spotify.com/v1/me/player", {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (e) { /* ignore */ }
    }

    // Check each coordinator's transport state
    let activeGroupId = null;
    for (const group of this.sonosGroups) {
      try {
        const state = await Sonos.getTransportState(
          group.coordinator.ip, group.coordinator.port
        );
        if (state === "PLAYING") {
          activeGroupId = group.id;
          break;
        }
      } catch (e) { /* skip unresponsive device */ }
    }

    if (activeGroupId) {
      const g = this.sonosGroups.find(gr => gr.id === activeGroupId);
      if (g) this._setActive(g.coordinator.ip, activeGroupId);
    } else {
      this._clearActive();
    }
    this.sendSocketNotification("ACTIVE_ZONE", { activeGroupId });
  },

  // ── Sonos discovery ───────────────────────────────────────────────────────
  async _sonosDiscover() {
    console.log("[MMM-SpotifySonos] Starting Sonos discovery...");
    try {
      const rawDevices = await Sonos.discoverSonos();
      if (!rawDevices.length) {
        console.warn("[MMM-SpotifySonos] No Sonos devices found on the network");
        this.sendSocketNotification("ZONES_RECEIVED", []);
        return;
      }

      // Fetch full group topology from the first responding device
      const firstDev = rawDevices[0];
      const groups   = await Sonos.fetchZoneGroups(firstDev.ip, firstDev.port);

      if (groups && groups.length > 0) {
        this.sonosGroups = groups;
      } else {
        // Fallback: treat each discovered device as its own group
        this.sonosGroups = rawDevices.map(d => ({
          id:              d.udn,
          coordinatorUuid: d.udn,
          coordinator:     { uuid: d.udn, name: d.udn, ip: d.ip, port: d.port },
          allMembers:      [{ uuid: d.udn, name: d.udn, ip: d.ip, port: d.port, invisible: false }],
          visibleMembers:  [{ uuid: d.udn, name: d.udn, ip: d.ip, port: d.port, invisible: false }],
          name:            d.udn
        }));
      }

      this._discoveryDone = true;
      console.log(`[MMM-SpotifySonos] Found ${this.sonosGroups.length} group(s)`);
      this.sonosGroups.forEach(g =>
        console.log(`  → "${g.name}" (${g.visibleMembers.length} visible, ${g.allMembers.length} total)`)
      );

      this._sendGroups();

      // Immediately detect which group is active
      await this._detectActiveZone();

      // Start periodic topology refresh
      if (!this._groupPollTimer) {
        this._groupPollTimer = setInterval(
          () => this._refreshGroups(),
          this.config.sonosRefresh || 15000
        );
      }
    } catch (e) {
      console.error("[MMM-SpotifySonos] Discovery error:", e.message);
    }
  },

  async _refreshGroups() {
    if (!this.sonosGroups.length) return;
    try {
      const first  = this.sonosGroups[0].coordinator;
      const groups = await Sonos.fetchZoneGroups(first.ip, first.port);
      if (groups && groups.length > 0) {
        this.sonosGroups = groups;
        // Derive active group ID from stable coordinator IP
        this._syncActiveGroupId();
        this._sendGroups();
      }
    } catch (e) { /* ignore refresh errors */ }
  },

  // Derive _activeGroupId from the stable _activeCoordinatorIp
  // Called after every topology refresh so the group ID stays current
  _syncActiveGroupId() {
    if (!this._activeCoordinatorIp) {
      this._activeGroupId = null;
      return;
    }
    const group = this.sonosGroups.find(g => g.coordinator.ip === this._activeCoordinatorIp);
    if (group) {
      this._activeGroupId = group.id;
    } else {
      // Active coordinator not found — it may have left or been regrouped
      // Don't clear it immediately; let next refresh confirm
    }
  },

  // Set active room by coordinator IP (stable across topology changes)
  _setActive(coordinatorIp, groupId) {
    this._activeCoordinatorIp = coordinatorIp;
    this._activeGroupId       = groupId || (coordinatorIp
      ? (this.sonosGroups.find(g => g.coordinator.ip === coordinatorIp) || {}).id || null
      : null);
  },

  _clearActive() {
    this._activeCoordinatorIp = null;
    this._activeGroupId       = null;
  },

  _sendGroups() {
    const activeGroupId  = this._activeGroupId;

    // Expand each Sonos ZoneGroup into individual room rows.
    // When multiple rooms are grouped (e.g. Küche + Schlafzimmer), Sonos reports
    // them as ONE ZoneGroup with visibleMembers=[Küche, Schlafzimmer].
    // We expand those into separate rows so each room is always visible and
    // its & button is always accessible.
    const rows = [];

    this.sonosGroups.forEach(g => {
      const isActiveGroup = g.id === activeGroupId;

      if (g.visibleMembers.length <= 1) {
        // Single room — simple row
        rows.push({
          id:              g.id,
          coordinatorUuid: g.coordinatorUuid,
          memberUuid:      g.coordinatorUuid,   // which device to control
          name:            g.name,
          isCoordinator:   true,
          isActiveGroup,
          inActiveGroup:   false,
          groupName:       null                  // no multi-room label
        });
      } else {
        // Multi-room group — one row per visible member
        g.visibleMembers.forEach((member) => {
          const isCoord = member.uuid === g.coordinatorUuid;
          rows.push({
            // All members of this group share the same group id for play/pause
            id:              g.id,
            coordinatorUuid: g.coordinatorUuid,
            memberUuid:      member.uuid,
            name:            member.name,
            isCoordinator:   isCoord,
            isActiveGroup:   isActiveGroup && isCoord,
            inActiveGroup:   isActiveGroup && !isCoord,  // non-coord members are "grouped"
            groupName:       g.name  // shown as subtitle to indicate multi-room
          });
        });
      }
    });

    this.sendSocketNotification("ZONES_RECEIVED", { groups: rows, activeGroupId });
  },

  _findGroup(groupId) {
    return this.sonosGroups.find(g => g.id === groupId);
  },

  // ── Spotify device control ────────────────────────────────────────────────
  // Find the Spotify device matching a room name and return its id.
  // Spotify shows Sonos rooms by their exact room name (e.g. "Schlafzimmer").
  async _spotifyDeviceId(roomName) {
    const token = await this._getToken();
    if (!token) return null;
    try {
      const res = await _fetch("https://api.spotify.com/v1/me/player/devices", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) return null;
      const { devices = [] } = await res.json();
      const name = (roomName || "").toLowerCase();
      const match = devices.find(d =>
        d.name.toLowerCase() === name ||
        d.name.toLowerCase() === `sonos ${name}` ||
        d.name.toLowerCase().includes(name)
      );
      if (!match) {
        console.warn(`[MMM-SpotifySonos] No Spotify device for "${roomName}". Available: ${devices.map(d => d.name).join(", ")}`);
      }
      return match ? match.id : null;
    } catch (e) {
      console.error("[MMM-SpotifySonos] Device lookup error:", e.message);
      return null;
    }
  },

  async _spotifyTransfer(deviceId, play = true) {
    const token = await this._getToken();
    if (!token || !deviceId) return false;
    try {
      const res = await _fetch("https://api.spotify.com/v1/me/player", {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ device_ids: [deviceId], play })
      });
      return res.ok || res.status === 204;
    } catch (e) {
      console.error("[MMM-SpotifySonos] Transfer error:", e.message);
      return false;
    }
  },

  // Get the currently active Spotify device id (may be null if nothing playing)
  async _spotifyActiveDeviceId() {
    const token = await this._getToken();
    if (!token) return null;
    try {
      const res = await _fetch("https://api.spotify.com/v1/me/player", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 204 || !res.ok) return null;
      const data = await res.json();
      return data && data.device ? data.device.id : null;
    } catch (e) { return null; }
  },



  // ── Spotify ───────────────────────────────────────────────────────────────
  async _spotifyState() {
    const token = await this._getToken();
    if (!token) return;
    try {
      const res = await _fetch("https://api.spotify.com/v1/me/player", {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.status === 204 || res.status === 202) return; // nothing playing
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.item) return;
      this.sendSocketNotification("SPOTIFY_STATE", {
        isPlaying:  data.is_playing,
        progressMs: data.progress_ms,
        durationMs: data.item.duration_ms,
        deviceId:   data.device ? data.device.id : null,
        track: {
          name:     data.item.name,
          artist:   data.item.artists.map(a => a.name).join(", "),
          album:    data.item.album.name,
          albumArt: data.item.album.images && data.item.album.images[0]
                      ? data.item.album.images[0].url : null
        }
      });
    } catch (e) {
      console.error("[MMM-SpotifySonos] Spotify state error:", e.message);
    }
  },

  async _spotifyCmd(method, endpoint) {
    const token = await this._getToken();
    if (!token) return;
    try {
      await _fetch(`https://api.spotify.com/v1/${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });
    } catch (e) {
      console.error("[MMM-SpotifySonos] Spotify command error:", e.message);
    }
  },

  // ── OAuth token management ────────────────────────────────────────────────
  async _getToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60000) return this.accessToken;
    if (this.refreshToken) return await this._refreshAccessToken();
    if (!this._authServerRunning) this._startAuthServer();
    return null;
  },

  async _refreshAccessToken() {
    const { clientID, clientSecret } = this.config;
    const creds = Buffer.from(`${clientID}:${clientSecret}`).toString("base64");
    try {
      const res = await _fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: `grant_type=refresh_token&refresh_token=${this.refreshToken}`
      });
      const data = await res.json();
      if (data.access_token) {
        this.accessToken = data.access_token;
        this.tokenExpiry = Date.now() + data.expires_in * 1000;
        if (data.refresh_token) this.refreshToken = data.refresh_token;
        this._saveToken();
        return this.accessToken;
      }
    } catch (e) {
      console.error("[MMM-SpotifySonos] Token refresh error:", e.message);
    }
    return null;
  },

  // ── OAuth local auth server (one-time setup) ──────────────────────────────
  _startAuthServer() {
    if (this._authServerRunning) return;
    this._authServerRunning = true;

    const { clientID, clientSecret, callbackUrl, authPort } = this.config;
    const parsedCallback = new URL(callbackUrl);
    const useHttps       = parsedCallback.protocol === "https:";
    const callbackPath   = parsedCallback.pathname;
    const port           = authPort || Number(parsedCallback.port) || (useHttps ? 443 : 80);

    const scopes = [
      "user-read-playback-state",
      "user-modify-playback-state",
      "user-read-currently-playing"
    ].join(" ");

    const authUrl =
      `https://accounts.spotify.com/authorize?client_id=${clientID}` +
      `&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}` +
      `&scope=${encodeURIComponent(scopes)}`;

    // Print the URL immediately — before server starts — so it's always visible
    console.log("\n╔════════════════════════════════════════════════════╗");
    console.log("║  MMM-SpotifySonos – Spotify Authorization          ║");
    console.log("╚════════════════════════════════════════════════════╝");
    console.log("\n  Open this URL in a browser to authorize:\n");
    console.log("  " + authUrl + "\n");

    const handler = async (req, res) => {
      const parsed = new URL(req.url, callbackUrl);
      if (parsed.pathname !== callbackPath) { res.writeHead(404); res.end("Not found"); return; }
      const code = parsed.searchParams.get("code");
      if (!code) { res.writeHead(400); res.end("No code received."); return; }
      const creds = Buffer.from(`${clientID}:${clientSecret}`).toString("base64");
      try {
        const tokenRes = await _fetch("https://accounts.spotify.com/api/token", {
          method: "POST",
          headers: {
            Authorization: `Basic ${creds}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(callbackUrl)}`
        });
        const data = await tokenRes.json();
        if (data.access_token) {
          this.accessToken  = data.access_token;
          this.refreshToken = data.refresh_token;
          this.tokenExpiry  = Date.now() + data.expires_in * 1000;
          this._saveToken();
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<style>body{background:#0a0a0a;color:#1db954;font-family:monospace;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px;}
p{color:#aaa;font-size:.9rem;}</style></head><body>
<div style="font-size:3rem">✓</div>
<h2>MMM-SpotifySonos authorized!</h2>
<p>You can close this window.</p>
</body></html>`);
          console.log("[MMM-SpotifySonos] ✓ Token saved");
          server.close(() => { this._authServerRunning = false; });
        } else {
          res.writeHead(500); res.end("Token error: " + JSON.stringify(data));
        }
      } catch (e) { res.writeHead(500); res.end("Error: " + e.message); }
    };

    const server = useHttps
      ? https.createServer(this._getOrCreateSslCert(), handler)
      : http.createServer(handler);

    server.listen(port, () => {
      console.log(`[MMM-SpotifySonos] Auth server listening on ${useHttps ? "HTTPS" : "HTTP"} port ${port}`);
    });
    server.on("error", (e) => {
      console.error(`[MMM-SpotifySonos] Auth server error: ${e.message}`);
      this._authServerRunning = false;
    });
  },

  // ── SSL certificate (use existing or auto-generate self-signed) ───────────
  _getOrCreateSslCert() {
    const certFile = this.config.sslCert || path.join(__dirname, ".ssl-cert.pem");
    const keyFile  = this.config.sslKey  || path.join(__dirname, ".ssl-key.pem");

    if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
      console.log(`[MMM-SpotifySonos] SSL certificate loaded: ${certFile}`);
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    }

    // If explicit paths were given but files don't exist, fail clearly
    if (this.config.sslCert || this.config.sslKey) {
      console.error(`[MMM-SpotifySonos] SSL certificate not found: ${certFile}`);
      return { cert: "", key: "" };
    }

    // Auto-generate a self-signed certificate (requires openssl)
    try {
      execSync(
        `openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" ` +
        `-out "${certFile}" -days 3650 -nodes ` +
        `-subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
        { stdio: "pipe" }
      );
      console.log(`[MMM-SpotifySonos] SSL certificate generated: ${certFile}`);
      return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    } catch (e) {
      console.error("[MMM-SpotifySonos] SSL error:", e.message);
      return { cert: "", key: "" };
    }
  },

  // ── Token persistence ─────────────────────────────────────────────────────
  _saveToken() {
    try {
      fs.writeFileSync(TOKEN_FILE, JSON.stringify({
        accessToken:  this.accessToken,
        refreshToken: this.refreshToken,
        tokenExpiry:  this.tokenExpiry
      }));
    } catch (e) { /* ignore */ }
  },

  _loadToken() {
    try {
      if (fs.existsSync(TOKEN_FILE)) {
        const data = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
        this.accessToken  = data.accessToken;
        this.refreshToken = data.refreshToken;
        this.tokenExpiry  = data.tokenExpiry;
        console.log("[MMM-SpotifySonos] Token loaded from disk");
      }
    } catch (e) { /* ignore */ }
  }
});
