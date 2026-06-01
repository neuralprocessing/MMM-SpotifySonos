"use strict";

/**
 * MMM-SpotifySonos – Sonos UPnP Engine
 * Self-contained, no external dependencies.
 * Uses SSDP for discovery and UPnP/SOAP for control.
 *
 * XML parsing uses Node's built-in node:fs + a minimal hand-rolled
 * attribute tokeniser that is not confused by attribute values containing
 * ">" or "/" — the exact characters that break naive regexes on Sonos XML.
 */

const dgram = require("dgram");
const http  = require("http");

// ── Minimal XML attribute tokeniser ──────────────────────────────────────────
//
// Parses a raw attribute string like:
//   UUID="RINCON_..." ZoneName="Arbeitszimmer" Location="http://..." Invisible="0"
// Returns a plain object { UUID, ZoneName, Location, Invisible, … }
//
// Handles: double-quoted, single-quoted, and unquoted values.
// Does NOT need the full tag — just the attribute portion.

function parseAttrs(attrStr) {
  const result = {};
  // Tokenise: name = "value" or name = 'value' or name = value
  const re = /(\w[\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    result[m[1]] = m[2] !== undefined ? m[2]
                 : m[3] !== undefined ? m[3]
                 : m[4];
  }
  return result;
}

// Split XML into a flat list of opening tags with their raw attribute strings.
// Works by scanning character-by-character so ">" inside attribute values
// (e.g. URLs) never prematurely ends the tag.
function parseTags(xml) {
  const tags = [];
  let i = 0;
  while (i < xml.length) {
    if (xml[i] !== "<") { i++; continue; }
    i++; // skip <
    if (i >= xml.length) break;
    // Skip closing tags, comments, declarations
    if (xml[i] === "/" || xml[i] === "!" || xml[i] === "?") {
      while (i < xml.length && xml[i] !== ">") i++;
      i++; continue;
    }
    // Read tag name
    let name = "";
    while (i < xml.length && !/[\s\/>]/.test(xml[i])) name += xml[i++];
    // Read attributes, respecting quoted values
    let attrs = "";
    while (i < xml.length) {
      const c = xml[i];
      if (c === ">") { i++; break; }
      if (c === "/" && xml[i + 1] === ">") { i += 2; break; }
      if (c === '"' || c === "'") {
        attrs += c; i++;
        while (i < xml.length && xml[i] !== c) attrs += xml[i++];
        if (i < xml.length) { attrs += xml[i++]; } // closing quote
      } else {
        attrs += c; i++;
      }
    }
    tags.push({ name, attrs: attrs.trim() });
  }
  return tags;
}

// ── SOAP helper ───────────────────────────────────────────────────────────────

function soapBody(service, action, args = {}) {
  const argXml = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${service}">${argXml}</u:${action}>
  </s:Body>
</s:Envelope>`;
}

function escapeXml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

function unescapeXml(s) {
  return s.replace(/&lt;/g,"<").replace(/&gt;/g,">")
          .replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&apos;/g,"'");
}

function sonosRequest(ip, port = 1400, urlPath, service, action, args = {}) {
  return new Promise((resolve, reject) => {
    const body = soapBody(service, action, args);
    const req  = http.request({
      hostname: ip, port, path: urlPath, method: "POST",
      headers: {
        "Content-Type":   "text/xml; charset=utf-8",
        "SOAPACTION":     `"${service}#${action}"`,
        "Content-Length": Buffer.byteLength(body)
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); resolve({ status: 0, body: "" }); });
    req.write(body);
    req.end();
  });
}

// ── SSDP discovery ────────────────────────────────────────────────────────────

const SSDP_ADDR    = "239.255.255.250";
const SSDP_PORT    = 1900;
const SONOS_ST     = "urn:schemas-upnp-org:device:ZonePlayer:1";
const SSDP_TIMEOUT = 5000;

function discoverSonos() {
  return new Promise((resolve) => {
    const socket  = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const devices = new Map();

    const msg = Buffer.from(
      "M-SEARCH * HTTP/1.1\r\n" +
      `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
      "MAN: \"ssdp:discover\"\r\n" +
      "MX: 3\r\n" +
      `ST: ${SONOS_ST}\r\n\r\n`
    );

    socket.on("message", (buf) => {
      const text = buf.toString();
      if (!text.includes("Sonos") && !text.includes("ZonePlayer")) return;
      const locMatch = text.match(/LOCATION:\s*http:\/\/([\d.]+):(\d+)/i);
      const udnMatch = text.match(/USN:.*?(uuid:[a-f0-9-]+)/i);
      if (!locMatch) return;
      const ip   = locMatch[1];
      const port = parseInt(locMatch[2]) || 1400;
      const udn  = udnMatch ? udnMatch[1] : ip;
      if (!devices.has(ip)) devices.set(ip, { ip, port, udn });
    });

    socket.on("error", () => resolve([...devices.values()]));

    socket.bind(0, () => {
      try { socket.addMembership(SSDP_ADDR); } catch (e) { /* ignore */ }
      socket.send(msg, 0, msg.length, SSDP_PORT, SSDP_ADDR);
    });

    setTimeout(() => {
      try { socket.close(); } catch (e) { /* ignore */ }
      resolve([...devices.values()]);
    }, SSDP_TIMEOUT);
  });
}

// ── Zone group topology ───────────────────────────────────────────────────────
//
// Sonos has three levels:
//   1. Physical devices       (Arc, Sub, Era 300 ×2, …)
//   2. Logical rooms          ("Living Room" = Arc + Sub + 2× Era 300)
//      Stereo pairs / surround satellites carry Invisible="1" → filtered out.
//   3. Dynamic multi-room groups  (Living Room + Bedroom playing together)
//      One coordinator with multiple visible room members.

async function fetchZoneGroups(ip, port = 1400) {
  try {
    const res = await sonosRequest(
      ip, port,
      "/ZoneGroupTopology/Control",
      "urn:schemas-upnp-org:service:ZoneGroupTopology:1",
      "GetZoneGroupState", {}
    );

    // The ZoneGroupState value is XML-escaped inside the SOAP envelope
    const stateMatch = res.body.match(/<ZoneGroupState[^>]*>([\s\S]*?)<\/ZoneGroupState>/);
    if (!stateMatch) {
      console.error("[Sonos] ZoneGroupState not found in SOAP response");
      console.error("[Sonos] Response body snippet:", res.body.substring(0, 300));
      return null;
    }

    // Unescape once to get the real inner XML
    const inner = unescapeXml(stateMatch[1]);

    // Parse all tags in one pass using the robust tokeniser
    const tags   = parseTags(inner);
    const groups = [];
    let currentGroup = null;

    for (const tag of tags) {
      if (tag.name === "ZoneGroup") {
        const a = parseAttrs(tag.attrs);
        currentGroup = {
          id:              a.ID             || "",
          coordinatorUuid: a.Coordinator    || "",
          allMembers:      [],
          visibleMembers:  []
        };
        groups.push(currentGroup);

      } else if ((tag.name === "ZoneGroupMember" || tag.name === "Satellite" || tag.name === "SatelliteMember") && currentGroup) {
        // SatelliteMember = Sub, surround speakers, stereo pair secondary (always invisible)
        const isSatellite = tag.name === "Satellite" || tag.name === "SatelliteMember";
        const a           = parseAttrs(tag.attrs);
        const uuid        = a.UUID     || "";
        const zoneName    = a.ZoneName || "";
        const location    = a.Location || "";
        const isInvis     = isSatellite || a.Invisible === "1" || a.Invisible === "true";

        // Extract IP from Location; fall back to raw attrs scan if truncated
        const locMatch = location.match(/http:\/\/([\d.]+):(\d+)/);
        const rawMatch = !locMatch ? tag.attrs.match(/http:\/\/([\d.]+):(\d+)/) : null;
        const ip   = locMatch ? locMatch[1] : (rawMatch ? rawMatch[1] : null);
        const port = locMatch ? parseInt(locMatch[2]) : (rawMatch ? parseInt(rawMatch[2]) : 1400);
        if (!uuid || !ip) continue;

        const member = {
          uuid,
          name:      zoneName || uuid,
          ip,
          port,
          invisible: isInvis
        };

        currentGroup.allMembers.push(member);
        if (!isInvis) currentGroup.visibleMembers.push(member);
      }
    }

    // Attach coordinator and group name to each group
    for (const g of groups) {
      g.coordinator = g.allMembers.find(m => m.uuid === g.coordinatorUuid)
                   || g.allMembers[0];
      if (!g.coordinator) continue;
      g.name = g.coordinator.name;
    }

    const valid = groups.filter(g => g.coordinator && g.allMembers.length > 0);
    console.log(`[Sonos] Found ${valid.length} zone(s): ${valid.map(g => `"${g.name}" (${g.allMembers.length} device${g.allMembers.length > 1 ? "s" : ""})`).join(", ")}`);

    return valid.length > 0 ? valid : null;
  } catch (e) {
    console.error("[Sonos] fetchZoneGroups error:", e.message);
    return null;
  }
}

// ── Transport state ───────────────────────────────────────────────────────────

async function getTransportState(ip, port = 1400) {
  try {
    const res = await sonosRequest(
      ip, port,
      "/MediaRenderer/AVTransport/Control",
      "urn:schemas-upnp-org:service:AVTransport:1",
      "GetTransportInfo", { InstanceID: 0 }
    );
    const m = res.body.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/);
    return m ? m[1] : "STOPPED"; // PLAYING | PAUSED_PLAYBACK | STOPPED
  } catch (e) {
    return "STOPPED";
  }
}

// ── Playback control ──────────────────────────────────────────────────────────

const AV_TRANSPORT  = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CTL = "urn:schemas-upnp-org:service:RenderingControl:1";

async function sonosPlay(ip, port = 1400) {
  return sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "Play", { InstanceID: 0, Speed: 1 });
}

async function sonosPause(ip, port = 1400) {
  return sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "Pause", { InstanceID: 0 });
}

async function sonosNext(ip, port = 1400) {
  return sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "Next", { InstanceID: 0 });
}

async function sonosPrev(ip, port = 1400) {
  return sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "Previous", { InstanceID: 0 });
}

// ── Volume control ────────────────────────────────────────────────────────────

async function sonosSetVolume(ip, port = 1400, volume) {
  return sonosRequest(ip, port, "/MediaRenderer/RenderingControl/Control",
    RENDERING_CTL, "SetVolume",
    { InstanceID: 0, Channel: "Master", DesiredVolume: volume });
}

async function sonosGetVolume(ip, port = 1400) {
  try {
    const res = await sonosRequest(ip, port, "/MediaRenderer/RenderingControl/Control",
      RENDERING_CTL, "GetVolume", { InstanceID: 0, Channel: "Master" });
    const m = res.body.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/);
    return m ? parseInt(m[1]) : 50;
  } catch (e) {
    return 50;
  }
}

// ── Group management ──────────────────────────────────────────────────────────

async function sonosJoinGroup(memberIp, memberPort, coordinatorUuid) {
  // coordinatorUuid must be the bare RINCON_... id (no "uuid:" prefix)
  const uri = coordinatorUuid.startsWith("x-rincon:")
    ? coordinatorUuid
    : `x-rincon:${coordinatorUuid}`;
  const res = await sonosRequest(memberIp, memberPort, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "SetAVTransportURI", {
      InstanceID:         0,
      CurrentURI:         uri,
      CurrentURIMetaData: ""
    });
  if (res.status !== 200) {
    console.error(`[Sonos] sonosJoinGroup failed: status=${res.status} body=${res.body.substring(0,200)}`);
  }
  return res;
}

async function sonosLeaveGroup(ip, port = 1400) {
  // Makes this device the coordinator of its own standalone group.
  // If called on the current group coordinator, remaining members get promoted.
  const res = await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "BecomeCoordinatorOfStandaloneGroup", { InstanceID: 0 });
  if (res.status !== 200) {
    console.error(`[Sonos] sonosLeaveGroup failed: status=${res.status} body=${res.body.substring(0,200)}`);
  }
  return res;
}

// Returns true if the room has content that can be resumed via UPnP Play.
// Multi-stage check: transport state, then CurrentURI, then NrTracks.
async function hasContent(ip, port = 1400) {
  try {
    // Stage 1: transport state — PAUSED_PLAYBACK is definitive
    const stateRes = await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
      AV_TRANSPORT, "GetTransportInfo", { InstanceID: 0 });
    const sm = stateRes.body.match(/<CurrentTransportState>([^<]+)<\/CurrentTransportState>/);
    const state = sm ? sm[1] : "STOPPED";
    if (state === "PLAYING" || state === "PAUSED_PLAYBACK") return true;

    // Stage 2: GetMediaInfo for CurrentURI and NrTracks
    const mediaRes = await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
      AV_TRANSPORT, "GetMediaInfo", { InstanceID: 0 });
    const um = mediaRes.body.match(/<CurrentURI>([^<]*)<\/CurrentURI>/);
    const uri = um ? um[1] : "";
    const nm = mediaRes.body.match(/<NrTracks>(\d+)<\/NrTracks>/);
    const nr  = nm ? parseInt(nm[1]) : 0;

    // Has content if URI is non-empty and not a group-member pointer
    // Has content if URI points to actual playable content:
    // - x-rincon: = group member pointer (not a coordinator) → no
    // - x-rincon-queue: with NrTracks=0 = empty local queue → no
    // - anything else non-empty = Spotify/radio/line-in URI → yes
    if (!uri || uri === "NOT_IMPLEMENTED" || uri.startsWith("x-rincon:")) {
      console.log(`[Sonos] hasContent(${ip}): false — URI="${uri}" NrTracks=${nr}`);
      return false;
    }
    if (uri.startsWith("x-rincon-queue:") && nr === 0) {
      console.log(`[Sonos] hasContent(${ip}): false — empty queue URI="${uri.substring(0,60)}"`);
      return false;
    }
    console.log(`[Sonos] hasContent(${ip}): true — URI="${uri.substring(0,60)}" NrTracks=${nr}`);
    return true;
  } catch (e) {
    return false;
  }
}

// Get current transport URI and metadata
async function getMediaInfo(ip, port = 1400) {
  try {
    const res = await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
      AV_TRANSPORT, "GetMediaInfo", { InstanceID: 0 });
    const uriMatch  = res.body.match(/<CurrentURI>([^<]*)<\/CurrentURI>/);
    const metaMatch = res.body.match(/<CurrentURIMetaData>([^<]*)<\/CurrentURIMetaData>/);
    return {
      uri:  uriMatch  ? uriMatch[1]  : "",
      meta: metaMatch ? metaMatch[1] : ""
    };
  } catch (e) {
    return { uri: "", meta: "" };
  }
}

// Get position info — track URI + playback position
async function getPositionInfo(ip, port = 1400) {
  try {
    const res = await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
      AV_TRANSPORT, "GetPositionInfo", { InstanceID: 0 });
    const trackUri  = (res.body.match(/<TrackURI>([^<]*)<\/TrackURI>/)    || [])[1] || "";
    const trackMeta = (res.body.match(/<TrackMetaData>([^<]*)<\/TrackMetaData>/) || [])[1] || "";
    const relTime   = (res.body.match(/<RelTime>([^<]*)<\/RelTime>/)       || [])[1] || "0:00:00";
    const trackNum  = (res.body.match(/<Track>([^<]+)<\/Track>/)           || [])[1] || "1";
    return { trackUri, trackMeta, relTime, trackNum: parseInt(trackNum) || 1 };
  } catch (e) {
    return { trackUri: "", trackMeta: "", relTime: "0:00:00", trackNum: 1 };
  }
}

// Set transport URI directly
async function setAVTransportURI(ip, port = 1400, uri, meta = "") {
  return sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
    AV_TRANSPORT, "SetAVTransportURI", {
      InstanceID:         0,
      CurrentURI:         uri,
      CurrentURIMetaData: meta
    });
}

// Seek to a specific track number and time position
async function seek(ip, port = 1400, trackNum, relTime) {
  // First seek to track, then to time
  try {
    await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
      AV_TRANSPORT, "Seek", { InstanceID: 0, Unit: "TRACK_NR", Target: trackNum });
  } catch (e) { /* may not support track seek */ }
  try {
    await sonosRequest(ip, port, "/MediaRenderer/AVTransport/Control",
      AV_TRANSPORT, "Seek", { InstanceID: 0, Unit: "REL_TIME", Target: relTime });
  } catch (e) { /* may not support time seek */ }
}

module.exports = {
  discoverSonos,
  fetchZoneGroups,
  getTransportState,
  hasContent,
  getMediaInfo,
  getPositionInfo,
  setAVTransportURI,
  seek,
  sonosPlay,
  sonosPause,
  sonosNext,
  sonosPrev,
  sonosSetVolume,
  sonosGetVolume,
  sonosJoinGroup,
  sonosLeaveGroup
};
