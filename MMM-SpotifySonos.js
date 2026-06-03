Module.register("MMM-SpotifySonos", {

  defaults: {
    clientID:        "",
    clientSecret:    "",
    pollInterval:    3000,
    sonosRefresh:    15000,
    volumeStep:      5,
    showProgressBar: true,
    showCoverArt:    true,
    big_cover:       false,
    theme:           "",       // "" = default green-on-dark  |  "black_white" = monochrome outlines
    materialIcons:   false,
    icons:           {},   // override individual icons; see README for keys
    callbackUrl:     "https://127.0.0.1:8888/callback",
    authPort:        8888,
    // sslCert:      "/etc/ssl/certs/my.crt",
    // sslKey:       "/etc/ssl/private/my.key",
    panelAbove:      false,  // true for lower_* positions (panel opens upward)
  },

  // ── State ──────────────────────────────────────────────────────────────────
  track:          null,
  isPlaying:      false,
  progressMs:     0,
  durationMs:     0,
  groups:         [],
  activeGroup:    null,   // group.id of the currently active room
  showSonos:      false,
  showPlaylists:  false,
  playlists:      [],
  _progressTimer: null,
  _errorMsg:      null,
  _errorTimer:    null,

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  start() {
    Log.info("MMM-SpotifySonos started");

    if (this.config.materialIcons) {
      const link = document.createElement("link");
      link.rel  = "stylesheet";
      link.href = "https://fonts.googleapis.com/icon?family=Material+Icons";
      document.head.appendChild(link);
    }

    this.sendSocketNotification("INIT", this.config);
    setInterval(() => this.sendSocketNotification("GET_SPOTIFY"), this.config.pollInterval);
    setInterval(() => this.sendSocketNotification("GET_ZONES"),   this.config.sonosRefresh);
    setTimeout(()  => this.sendSocketNotification("GET_ACTIVE_ZONE"), 7000);

    this._progressTimer = setInterval(() => {
      if (this.isPlaying && this.durationMs > 0) {
        this.progressMs = Math.min(this.progressMs + 1000, this.durationMs);
        this._updateProgress();
      }
    }, 1000);
  },

  getStyles() { return ["MMM-SpotifySonos.css"]; },

  // ── Full DOM rebuild ───────────────────────────────────────────────────────
  getDom() {
    const wrap = document.createElement("div");
    wrap.className = "ssw" +
      (this.config.big_cover ? " ssw--big-cover" : "") +
      (this.config.theme === "black_white" ? " ssw--bw" : "");

    const card = document.createElement("div");
    card.className = "ssw-card";

    if (this.config.showCoverArt) {
      const coverWrap = document.createElement("div");
      coverWrap.className = "ssw-cover-wrap";
      const cover = document.createElement("div");
      cover.id = "ssw-cover";
      cover.className = "ssw-cover" + (this.isPlaying ? " playing" : "");
      if (this.track && this.track.albumArt)
        cover.style.backgroundImage = `url(${this.track.albumArt})`;
      coverWrap.appendChild(cover);
      card.appendChild(coverWrap);
    }

    const info = document.createElement("div");
    info.className = "ssw-info";

    const title = document.createElement("div");
    title.className = "ssw-title";
    title.id = "ssw-title";
    title.innerText = (this.track && this.track.name) ? this.track.name : "– nothing playing –";
    info.appendChild(title);

    const artist = document.createElement("div");
    artist.className = "ssw-artist";
    artist.id = "ssw-artist";
    artist.innerText = (this.track && this.track.artist) ? this.track.artist : "";
    info.appendChild(artist);

    if (this.config.showProgressBar) {
      const progWrap = document.createElement("div");
      progWrap.className = "ssw-prog-wrap";
      progWrap.id = "ssw-prog-wrap";
      progWrap.style.display = this.durationMs > 0 ? "" : "none";
      const progBg = document.createElement("div");
      progBg.className = "ssw-prog-bg";
      const progFill = document.createElement("div");
      progFill.className = "ssw-prog-fill";
      progFill.id = "ssw-prog-fill";
      progFill.style.width = this.durationMs > 0
        ? `${(this.progressMs / this.durationMs) * 100}%` : "0%";
      progBg.appendChild(progFill);
      const timeRow = document.createElement("div");
      timeRow.className = "ssw-time-row";
      const tCur = document.createElement("span");
      tCur.id = "ssw-time-cur";
      tCur.innerText = this._fmtTime(this.progressMs);
      const tTotal = document.createElement("span");
      tTotal.id = "ssw-time-total";
      tTotal.innerText = this._fmtTime(this.durationMs);
      timeRow.appendChild(tCur);
      timeRow.appendChild(tTotal);
      progWrap.appendChild(progBg);
      progWrap.appendChild(timeRow);
      info.appendChild(progWrap);
    }

    const controls = document.createElement("div");
    controls.className = "ssw-controls";
    const prevBtn = this._btn(this._icon("prev"), "Previous track", () => this.sendSocketNotification("PREV"));
    const playBtn = this._btn(this._icon(this.isPlaying ? "pause" : "play"), "Play / Pause", () =>
      this.sendSocketNotification(this.isPlaying ? "PAUSE" : "PLAY"));
    playBtn.className += " ssw-btn-play";
    playBtn.id = "ssw-play-btn";
    const nextBtn = this._btn(this._icon("next"), "Next track", () => this.sendSocketNotification("NEXT"));
    const playlistBtn = this._btn(this._icon("playlists"), "Browse playlists", () => {
      this.showPlaylists = !this.showPlaylists;
      if (this.showPlaylists) {
        this.showSonos = false;
        this.sendSocketNotification("GET_PLAYLISTS");
      }
      this.updateDom();
    });
    playlistBtn.className += " ssw-btn-playlists" + (this.showPlaylists ? " active" : "");

    const sonosBtn = this._btn(this._icon("speaker"), "Choose speaker", () => {
      this.showSonos = !this.showSonos;
      if (this.showSonos) this.showPlaylists = false;
      this.updateDom();
    });
    sonosBtn.className += " ssw-btn-sonos" + (this.showSonos ? " active" : "");

    controls.appendChild(prevBtn);
    controls.appendChild(playBtn);
    controls.appendChild(nextBtn);
    controls.appendChild(playlistBtn);
    controls.appendChild(sonosBtn);
    info.appendChild(controls);
    card.appendChild(info);
    wrap.appendChild(card);

    if (this.showPlaylists) wrap.appendChild(this._buildPlaylistPanel());
    if (this.showSonos)     wrap.appendChild(this._buildSonosPanel());
    if (this._errorMsg)     wrap.appendChild(this._buildToast(this._errorMsg));

    return wrap;
  },

  // ── Playlist panel ─────────────────────────────────────────────────────────
  _buildPlaylistPanel() {
    const panel = document.createElement("div");
    panel.className = "ssw-playlist-panel" + (this.config.panelAbove ? " panel-above" : "");

    const header = document.createElement("div");
    header.className = "ssw-sonos-header";
    header.innerText = "PLAYLISTS";
    panel.appendChild(header);

    if (this.playlists.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ssw-sonos-empty";
      empty.innerText = "Loading playlists…";
      panel.appendChild(empty);
      return panel;
    }

    this.playlists.forEach(pl => {
      const row = document.createElement("div");
      row.className = "ssw-playlist-row";

      const img = document.createElement("div");
      img.className = "ssw-playlist-img";
      if (pl.image) img.style.backgroundImage = `url(${pl.image})`;
      row.appendChild(img);

      const name = document.createElement("span");
      name.className = "ssw-playlist-name";
      name.innerText = pl.name;
      row.appendChild(name);

      row.addEventListener("click", () => {
        this.sendSocketNotification("PLAY_PLAYLIST", { playlistUri: pl.uri });
        this.showPlaylists = false;
        this.updateDom();
      });

      panel.appendChild(row);
    });

    return panel;
  },

  // ── Sonos panel ────────────────────────────────────────────────────────────
  _buildSonosPanel() {
    const panel = document.createElement("div");
    panel.className = "ssw-sonos-panel" + (this.config.panelAbove ? " panel-above" : "");
    panel.id = "ssw-sonos-panel";

    const header = document.createElement("div");
    header.className = "ssw-sonos-header";
    header.innerText = "SPEAKERS";
    const refreshBtn = this._btn(this._icon("refresh"), "Rediscover", () =>
      this.sendSocketNotification("SONOS_REDISCOVER"));
    refreshBtn.className = "ssw-btn ssw-btn-refresh";
    header.appendChild(refreshBtn);
    panel.appendChild(header);

    if (this.groups.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ssw-sonos-empty";
      empty.innerText = "Searching for Sonos devices…";
      panel.appendChild(empty);
      return panel;
    }

    // Whether ANY room is currently active (playing)
    const hasActive = !!this.activeGroup;

    this.groups.forEach(group => {
      const isActive  = !!group.isActiveGroup;   // this room IS playing
      const isGrouped = !!group.inActiveGroup;   // this room is grouped with the active room

      const row = document.createElement("div");
      row.className = "ssw-zone-row" +
                      (isActive  ? " active"  : "") +
                      (isGrouped ? " grouped" : "");
      row.dataset.groupId    = group.id;
      row.dataset.memberUuid = group.memberUuid || group.coordinatorUuid;
      row.dataset.inGroup    = isGrouped ? "1" : "0";

      // ── Room name — tap to activate / deactivate ──────────────────────────
      const nameWrap = document.createElement("div");
      nameWrap.className = "ssw-zone-name-wrap";

      const nameEl = document.createElement("span");
      nameEl.className = "ssw-zone-name";
      nameEl.innerText = group.name;
      nameEl.addEventListener("click", () => {
        // Read live state at click time
        const liveGroup  = this.groups.find(g =>
          g.id === group.id &&
          (g.memberUuid === group.memberUuid || g.coordinatorUuid === group.memberUuid)
        );
        const liveActive  = liveGroup ? !!liveGroup.isActiveGroup  : false;
        const liveGrouped = liveGroup ? !!liveGroup.inActiveGroup  : false;

        if (liveActive) {
          // Tap active room → pause it
          this.sendSocketNotification("SONOS_PAUSE", { groupId: group.id });
          this.activeGroup = null;
          this._updateActiveHighlight();
        } else if (liveGrouped) {
          // Tap a grouped member → do nothing (use & to remove from group)
          // Grouped rooms are not independently tappable to avoid confusion
        } else {
          // Tap inactive room → make it active
          this.sendSocketNotification("SONOS_PLAY", {
            groupId:     group.id,
            prevGroupId: this.activeGroup
          });
          this.activeGroup = group.id;
          this._updateActiveHighlight();
        }
      });
      nameWrap.appendChild(nameEl);

      // ↳ label for grouped members
      if (isGrouped && group.groupName) {
        const withLabel = document.createElement("span");
        withLabel.className = "ssw-group-with";
        withLabel.innerText = `↳ ${group.groupName}`;
        withLabel.title = `Playing with ${group.groupName}`;
        nameWrap.appendChild(withLabel);
      }

      // ── & button — group/ungroup ──────────────────────────────────────────
      // Enabled only when:
      //   - This room IS grouped (can always remove)
      //   - OR there is an active room AND this room is not that active room
      const canGroup   = !isActive && hasActive;
      const canUngroup = isGrouped;
      const groupEnabled = canGroup || canUngroup;

      const groupBtn = this._btn(this._icon("group"),
        isGrouped ? "Remove from group" : "Add to active group",
        (e) => {
          e.stopPropagation();
          const liveGrouped  = row.dataset.inGroup === "1";
          const liveActiveId = this.activeGroup;
          if (liveGrouped) {
            this.sendSocketNotification("SONOS_GROUP_REMOVE", {
              groupId:    group.id,
              memberUuid: row.dataset.memberUuid
            });
          } else if (liveActiveId && liveActiveId !== group.id) {
            this.sendSocketNotification("SONOS_GROUP_ADD", { groupId: group.id });
          }
        }
      );
      groupBtn.className = "ssw-btn ssw-btn-group" +
                           (isGrouped   ? " grouped"  : "") +
                           (!groupEnabled ? " disabled" : "");
      if (!groupEnabled) groupBtn.disabled = true;

      // ── Volume buttons — enabled only if this row is active or grouped ────
      const volEnabled = isActive || isGrouped;

      const volRow = document.createElement("div");
      volRow.className = "ssw-vol-row";

      const volDown = this._btn(this._icon("volDown"), "Volume down", () =>
        this.sendSocketNotification("SONOS_VOL", { groupId: group.id, dir: "down" }));
      volDown.className = "ssw-btn ssw-btn-vol" + (!volEnabled ? " disabled" : "");
      if (!volEnabled) volDown.disabled = true;

      const volUp = this._btn(this._icon("volUp"), "Volume up", () =>
        this.sendSocketNotification("SONOS_VOL", { groupId: group.id, dir: "up" }));
      volUp.className = "ssw-btn ssw-btn-vol" + (!volEnabled ? " disabled" : "");
      if (!volEnabled) volUp.disabled = true;

      volRow.appendChild(volDown);
      volRow.appendChild(volUp);

      row.appendChild(nameWrap);
      row.appendChild(groupBtn);
      row.appendChild(volRow);
      panel.appendChild(row);
    });

    return panel;
  },

  // ── Surgical updates ───────────────────────────────────────────────────────

  _updateTrackInfo() {
    const titleEl  = document.getElementById("ssw-title");
    const artistEl = document.getElementById("ssw-artist");
    const coverEl  = document.getElementById("ssw-cover");
    const playBtn  = document.getElementById("ssw-play-btn");

    if (titleEl)  titleEl.innerText  = (this.track && this.track.name)   ? this.track.name   : "– nothing playing –";
    if (artistEl) artistEl.innerText = (this.track && this.track.artist) ? this.track.artist : "";
    if (coverEl) {
      coverEl.style.backgroundImage = (this.track && this.track.albumArt)
        ? `url(${this.track.albumArt})` : "";
      coverEl.className = "ssw-cover" + (this.isPlaying ? " playing" : "");
    }
    if (playBtn) playBtn.innerHTML = this._icon(this.isPlaying ? "pause" : "play");
    const progWrap = document.getElementById("ssw-prog-wrap");
    if (progWrap) progWrap.style.display = this.durationMs > 0 ? "" : "none";
    const totalEl  = document.getElementById("ssw-time-total");
    if (totalEl) totalEl.innerText = this._fmtTime(this.durationMs);
    this._updateProgress();
  },

  // Update highlights + button enabled state without full rebuild
  _updateActiveHighlight() {
    const panel = document.getElementById("ssw-sonos-panel");
    if (!panel) return;

    const hasActive = !!this.activeGroup;

    panel.querySelectorAll(".ssw-zone-row").forEach(row => {
      const gid        = row.dataset.groupId;
      const memberUuid = row.dataset.memberUuid;
      const group = this.groups.find(g =>
        g.id === gid && (g.memberUuid === memberUuid || g.coordinatorUuid === memberUuid)
      );
      const isActive  = group ? !!group.isActiveGroup : false;
      const isGrouped = group ? !!group.inActiveGroup : false;

      row.dataset.inGroup = isGrouped ? "1" : "0";
      row.className = "ssw-zone-row" +
                      (isActive  ? " active"  : "") +
                      (isGrouped ? " grouped" : "");

      // & button enabled state
      const canGroup    = !isActive && hasActive;
      const canUngroup  = isGrouped;
      const groupEnabled = canGroup || canUngroup;
      const groupBtn = row.querySelector(".ssw-btn-group");
      if (groupBtn) {
        groupBtn.disabled = !groupEnabled;
        groupBtn.className = "ssw-btn ssw-btn-group" +
                             (isGrouped    ? " grouped"  : "") +
                             (!groupEnabled ? " disabled" : "");
        groupBtn.title = isGrouped ? "Remove from group" : "Add to active group";
      }

      // Volume buttons enabled state
      const volEnabled = isActive || isGrouped;
      row.querySelectorAll(".ssw-btn-vol").forEach(btn => {
        btn.disabled = !volEnabled;
        btn.className = "ssw-btn ssw-btn-vol" + (!volEnabled ? " disabled" : "");
      });
    });
  },

  _updateProgress() {
    const fill = document.getElementById("ssw-prog-fill");
    const cur  = document.getElementById("ssw-time-cur");
    if (fill && this.durationMs > 0)
      fill.style.width = `${(this.progressMs / this.durationMs) * 100}%`;
    if (cur) cur.innerText = this._fmtTime(this.progressMs);
  },

  // ── Helpers ────────────────────────────────────────────────────────────────

  _icon(key) {
    const defaults = this.config.materialIcons ? {
      prev:      "skip_previous",
      play:      "play_arrow",
      pause:     "pause",
      next:      "skip_next",
      playlists: "queue_music",
      speaker:   "volume_up",
      refresh:   "refresh",
      group:     "hub",
      volDown:   "remove",
      volUp:     "add"
    } : {
      prev:      "⏮",
      play:      "▶",
      pause:     "⏸",
      next:      "⏭",
      playlists: "♫",
      speaker:   "🔊",
      refresh:   "↻",
      group:     "&",
      volDown:   "−",
      volUp:     "+"
    };
    const label = this.config.icons[key] !== undefined ? this.config.icons[key] : defaults[key];
    return this.config.materialIcons
      ? `<span class="material-icons">${label}</span>`
      : label;
  },

  _btn(label, title, onClick) {
    const b = document.createElement("button");
    b.className = "ssw-btn";
    b.innerHTML = label;
    b.title = title;
    b.addEventListener("click", onClick);
    return b;
  },

  _buildToast(msg) {
    const toast = document.createElement("div");
    toast.className = "ssw-toast";
    toast.innerText = msg;
    return toast;
  },

  _showError(msg) {
    this._errorMsg = msg;
    if (this._errorTimer) clearTimeout(this._errorTimer);
    this._errorTimer = setTimeout(() => {
      this._errorMsg = null;
      this._errorTimer = null;
      this.updateDom();
    }, 5000);
    this.updateDom();
  },

  _fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },

  // ── Notifications from backend ─────────────────────────────────────────────
  socketNotificationReceived(notification, payload) {
    switch (notification) {

      case "SPOTIFY_STATE": {
        const trackChanged = !this.track || !payload.track ||
                             this.track.name !== payload.track.name;
        const wasPlaying   = this.isPlaying;
        this.track      = payload.track;
        this.isPlaying  = payload.isPlaying;
        this.progressMs = payload.progressMs;
        this.durationMs = payload.durationMs;
        if (trackChanged || wasPlaying !== this.isPlaying) this._updateTrackInfo();
        break;
      }

      case "ZONES_RECEIVED": {
        const data      = Array.isArray(payload) ? { groups: payload } : payload;
        const newGroups = data.groups || [];
        const structureChanged =
          newGroups.length !== this.groups.length ||
          newGroups.some((g, i) => !this.groups[i] || g.id !== this.groups[i].id);
        this.groups = newGroups;
        if (data.activeGroupId !== undefined) this.activeGroup = data.activeGroupId;
        if (structureChanged) this.updateDom();
        else this._updateActiveHighlight();
        break;
      }

      case "ACTIVE_ZONE":
        this.activeGroup = payload.activeGroupId;
        this._updateActiveHighlight();
        break;

      case "PLAYBACK_MOVED":
        if (payload.activeGroupId !== undefined) this.activeGroup = payload.activeGroupId;
        if (payload.isPlaying     !== undefined) this.isPlaying   = payload.isPlaying;
        this._updateTrackInfo();
        this._updateActiveHighlight();
        break;

      case "PLAYLISTS_RECEIVED":
        this.playlists = payload;
        if (this.showPlaylists) this.updateDom();
        break;

      case "ERROR":
        Log.error("MMM-SpotifySonos:", payload);
        this._showError(payload);
        break;
    }
  }
});
