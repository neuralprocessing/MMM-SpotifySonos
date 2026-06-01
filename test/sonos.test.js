"use strict";

/**
 * Unit tests for sonos.js
 * Run: npm test
 */

const assert = require("node:assert/strict");
const { describe, it, before, after } = require("node:test");
const http = require("http");

// ── Import module under test ───────────────────────────────────────────────
const Sonos = require("../sonos.js");

// ── Helpers ────────────────────────────────────────────────────────────────

// Build a minimal SOAP response body for a given action/content
function soapResponse(service, action, innerXml) {
  return `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <u:${action}Response xmlns:u="${service}">
      ${innerXml}
    </u:${action}Response>
  </s:Body>
</s:Envelope>`;
}

// Escape XML entities (mirrors sonos.js escapeXml)
function escapeXml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
          .replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

// Start a mock HTTP server that responds to UPnP SOAP requests
function startMockSonos(port, handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        const { status, content } = handler(req, body);
        res.writeHead(status, { "Content-Type": "text/xml" });
        res.end(content);
      });
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// parseTags + parseAttrs (internal — tested via fetchZoneGroups)
// ══════════════════════════════════════════════════════════════════════════

describe("XML parsing via fetchZoneGroups", () => {

  let server;
  const PORT = 19400;

  // Real-world structure from the device (from user logs)
  const realZoneXml = `<ZoneGroupState><ZoneGroups>` +
    `<ZoneGroup Coordinator="RINCON_F0F6C177B18301400" ID="RINCON_F0F6C177B18301400:60208805">` +
      `<ZoneGroupMember UUID="RINCON_F0F6C177B18301400" Location="http://192.168.0.30:1400/xml/device_description.xml" ZoneName="Wohnzimmer" Invisible="0">` +
        `<Satellite UUID="RINCON_542A1BF3154601400" Location="http://192.168.0.11:1400/xml/device_description.xml" ZoneName="Wohnzimmer" Invisible="1"/>` +
        `<Satellite UUID="RINCON_542A1BF3147A01400" Location="http://192.168.0.10:1400/xml/device_description.xml" ZoneName="Wohnzimmer" Invisible="1"/>` +
        `<Satellite UUID="RINCON_542A1B1D073801400" Location="http://192.168.0.13:1400/xml/device_description.xml" ZoneName="Sub"         Invisible="1"/>` +
      `</ZoneGroupMember>` +
    `</ZoneGroup>` +
    `<ZoneGroup Coordinator="RINCON_804AF28A427E01400" ID="RINCON_804AF28A427E01400:3383742393">` +
      `<ZoneGroupMember UUID="RINCON_804AF28A427E01400" Location="http://192.168.0.53:1400/xml/device_description.xml" ZoneName="Arbeitszimmer" Invisible="0"/>` +
    `</ZoneGroup>` +
    `<ZoneGroup Coordinator="RINCON_F0F6C124740C01400" ID="RINCON_F0F6C124740C01400:417384329">` +
      `<ZoneGroupMember UUID="RINCON_F0F6C12AC32C01400" Location="http://192.168.0.31:1400/xml/device_description.xml" ZoneName="Schlafzimmer" Invisible="1"/>` +
      `<ZoneGroupMember UUID="RINCON_F0F6C124740C01400" Location="http://192.168.0.65:1400/xml/device_description.xml" ZoneName="Schlafzimmer" Invisible="0"/>` +
    `</ZoneGroup>` +
    `</ZoneGroups></ZoneGroupState>`;

  const escapedXml = escapeXml(realZoneXml);

  before(async () => {
    server = await startMockSonos(PORT, () => ({
      status:  200,
      content: soapResponse(
        "urn:schemas-upnp-org:service:ZoneGroupTopology:1",
        "GetZoneGroupState",
        `<ZoneGroupState>${escapedXml}</ZoneGroupState>`
      )
    }));
  });

  after(() => server.close());

  it("parses Wohnzimmer group with 4 members (1 visible, 3 invisible)", async () => {
    const groups = await Sonos.fetchZoneGroups("127.0.0.1", PORT);
    assert.ok(groups, "Should return groups");
    const wohnzimmer = groups.find(g => g.name === "Wohnzimmer");
    assert.ok(wohnzimmer, "Wohnzimmer group should exist");
    assert.equal(wohnzimmer.allMembers.length, 4, "Should have 4 physical devices");
    assert.equal(wohnzimmer.visibleMembers.length, 1, "Should have 1 visible room");
    assert.equal(wohnzimmer.coordinator.ip, "192.168.0.30", "Coordinator should be Arc");
  });

  it("parses Satellite tags as invisible members", async () => {
    const groups = await Sonos.fetchZoneGroups("127.0.0.1", PORT);
    const wohnzimmer = groups.find(g => g.name === "Wohnzimmer");
    const invisibles = wohnzimmer.allMembers.filter(m => m.invisible);
    assert.equal(invisibles.length, 3, "Should have 3 invisible (Sub + 2 Ones)");
    const sub = invisibles.find(m => m.name === "Sub");
    assert.ok(sub, "Sub should be in invisible members");
  });

  it("parses Schlafzimmer stereo pair: 2 members, 1 visible", async () => {
    const groups = await Sonos.fetchZoneGroups("127.0.0.1", PORT);
    const schlafzimmer = groups.find(g => g.name === "Schlafzimmer");
    assert.ok(schlafzimmer, "Schlafzimmer should exist");
    assert.equal(schlafzimmer.allMembers.length, 2);
    assert.equal(schlafzimmer.visibleMembers.length, 1);
    // Coordinator should be the non-invisible member
    assert.equal(schlafzimmer.coordinator.ip, "192.168.0.65");
  });

  it("parses Arbeitszimmer as single-device group", async () => {
    const groups = await Sonos.fetchZoneGroups("127.0.0.1", PORT);
    const az = groups.find(g => g.name === "Arbeitszimmer");
    assert.ok(az, "Arbeitszimmer should exist");
    assert.equal(az.allMembers.length, 1);
    assert.equal(az.visibleMembers.length, 1);
    assert.equal(az.coordinator.ip, "192.168.0.53");
  });

  it("returns coordinatorUuid correctly", async () => {
    const groups = await Sonos.fetchZoneGroups("127.0.0.1", PORT);
    const wz = groups.find(g => g.name === "Wohnzimmer");
    assert.equal(wz.coordinatorUuid, "RINCON_F0F6C177B18301400");
  });

  it("returns null when server responds with empty body", async () => {
    const emptyServer = await startMockSonos(PORT + 1, () => ({
      status: 200, content: "<empty/>"
    }));
    const result = await Sonos.fetchZoneGroups("127.0.0.1", PORT + 1);
    assert.equal(result, null);
    emptyServer.close();
  });

  it("returns null on malformed/empty SOAP response", async () => {
    // Server returns 200 but with no ZoneGroupState element
    const badServer = await startMockSonos(PORT + 2, () => ({
      status: 200,
      content: "<s:Envelope><s:Body><NoState/></s:Body></s:Envelope>"
    }));
    const result = await Sonos.fetchZoneGroups("127.0.0.1", PORT + 2);
    assert.equal(result, null, "Should return null when ZoneGroupState missing");
    badServer.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getTransportState
// ══════════════════════════════════════════════════════════════════════════

describe("getTransportState", () => {
  let server;
  const PORT = 19410;

  before(async () => {
    server = await startMockSonos(PORT, (_req, body) => {
      if (body.includes("GetTransportInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetTransportInfo",
            "<CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState>")
        };
      }
      return { status: 404, content: "" };
    });
  });

  after(() => server.close());

  it("returns PAUSED_PLAYBACK", async () => {
    const state = await Sonos.getTransportState("127.0.0.1", PORT);
    assert.equal(state, "PAUSED_PLAYBACK");
  });

  it("returns STOPPED on network error", async () => {
    const state = await Sonos.getTransportState("127.0.0.1", 19499); // nothing listening
    assert.equal(state, "STOPPED");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// hasContent
// ══════════════════════════════════════════════════════════════════════════

describe("hasContent", () => {
  let server;
  const PORT = 19420;

  before(async () => {
    server = await startMockSonos(PORT, (_req, body) => {
      if (body.includes("GetTransportInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetTransportInfo",
            "<CurrentTransportState>STOPPED</CurrentTransportState>")
        };
      }
      if (body.includes("GetMediaInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetMediaInfo",
            "<NrTracks>0</NrTracks><CurrentURI>x-sonos-http:track%3a123456.mp3</CurrentURI>")
        };
      }
      return { status: 404, content: "" };
    });
  });

  after(() => server.close());

  it("returns true when CurrentURI is non-empty Spotify URI", async () => {
    const result = await Sonos.hasContent("127.0.0.1", PORT);
    assert.equal(result, true);
  });

  it("returns false when no content available", async () => {
    const emptyServer = await startMockSonos(PORT + 1, (_req, body) => {
      if (body.includes("GetTransportInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetTransportInfo",
            "<CurrentTransportState>STOPPED</CurrentTransportState>")
        };
      }
      if (body.includes("GetMediaInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetMediaInfo",
            "<NrTracks>0</NrTracks><CurrentURI>NOT_IMPLEMENTED</CurrentURI>")
        };
      }
      return { status: 404, content: "" };
    });
    const result = await Sonos.hasContent("127.0.0.1", PORT + 1);
    assert.equal(result, false);
    emptyServer.close();
  });

  it("returns true immediately when transport is PAUSED_PLAYBACK", async () => {
    const pausedServer = await startMockSonos(PORT + 2, (_req, body) => {
      if (body.includes("GetTransportInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetTransportInfo",
            "<CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState>")
        };
      }
      // GetMediaInfo should NOT be called when transport is PAUSED_PLAYBACK
      return { status: 500, content: "should not be called" };
    });
    const result = await Sonos.hasContent("127.0.0.1", PORT + 2);
    assert.equal(result, true);
    pausedServer.close();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// sonosPlay / sonosPause / sonosNext / sonosPrev
// ══════════════════════════════════════════════════════════════════════════

describe("Playback control commands", () => {
  let server;
  const PORT = 19430;
  const requests = [];

  before(async () => {
    server = await startMockSonos(PORT, (req, body) => {
      requests.push({ path: req.url, action: req.headers["soapaction"], body });
      return {
        status: 200,
        content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "Play", "")
      };
    });
  });

  after(() => server.close());

  it("sonosPlay sends Play action", async () => {
    requests.length = 0;
    await Sonos.sonosPlay("127.0.0.1", PORT);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].action.includes("Play"));
    assert.ok(requests[0].body.includes("<Speed>1</Speed>"));
  });

  it("sonosPause sends Pause action", async () => {
    requests.length = 0;
    await Sonos.sonosPause("127.0.0.1", PORT);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].action.includes("Pause"));
  });

  it("sonosNext sends Next action", async () => {
    requests.length = 0;
    await Sonos.sonosNext("127.0.0.1", PORT);
    assert.ok(requests[requests.length - 1].action.includes("Next"));
  });

  it("sonosPrev sends Previous action", async () => {
    requests.length = 0;
    await Sonos.sonosPrev("127.0.0.1", PORT);
    assert.ok(requests[requests.length - 1].action.includes("Previous"));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Volume control
// ══════════════════════════════════════════════════════════════════════════

describe("Volume control", () => {
  let server;
  const PORT = 19440;
  const lastRequest = { body: "" };

  before(async () => {
    server = await startMockSonos(PORT, (_req, body) => {
      lastRequest.body = body;
      if (body.includes("GetVolume")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:RenderingControl:1", "GetVolume",
            "<CurrentVolume>42</CurrentVolume>")
        };
      }
      return {
        status: 200,
        content: soapResponse("urn:schemas-upnp-org:service:RenderingControl:1", "SetVolume", "")
      };
    });
  });

  after(() => server.close());

  it("sonosGetVolume returns correct volume", async () => {
    const vol = await Sonos.sonosGetVolume("127.0.0.1", PORT);
    assert.equal(vol, 42);
  });

  it("sonosSetVolume sends correct DesiredVolume", async () => {
    await Sonos.sonosSetVolume("127.0.0.1", PORT, 75);
    assert.ok(lastRequest.body.includes("<DesiredVolume>75</DesiredVolume>"));
  });

  it("sonosGetVolume returns 50 on error", async () => {
    const vol = await Sonos.sonosGetVolume("127.0.0.1", 19499); // nothing listening
    assert.equal(vol, 50);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getMediaInfo
// ══════════════════════════════════════════════════════════════════════════

describe("getMediaInfo", () => {
  let server;
  const PORT = 19460;

  before(async () => {
    server = await startMockSonos(PORT, (_req, body) => {
      if (body.includes("GetMediaInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetMediaInfo",
            "<CurrentURI>x-sonos-vli:RINCON_ABC:1,spotify:track:xyz</CurrentURI>" +
            "<CurrentURIMetaData>&lt;DIDL&gt;</CurrentURIMetaData>")
        };
      }
      return { status: 404, content: "" };
    });
  });

  after(() => server.close());

  it("returns uri and meta", async () => {
    const info = await Sonos.getMediaInfo("127.0.0.1", PORT);
    assert.equal(info.uri,  "x-sonos-vli:RINCON_ABC:1,spotify:track:xyz");
    assert.equal(info.meta, "&lt;DIDL&gt;");
  });

  it("returns empty strings on error", async () => {
    const info = await Sonos.getMediaInfo("127.0.0.1", 19499);
    assert.equal(info.uri,  "");
    assert.equal(info.meta, "");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// getPositionInfo
// ══════════════════════════════════════════════════════════════════════════

describe("getPositionInfo", () => {
  let server;
  const PORT = 19465;

  before(async () => {
    server = await startMockSonos(PORT, (_req, body) => {
      if (body.includes("GetPositionInfo")) {
        return {
          status: 200,
          content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "GetPositionInfo",
            "<Track>3</Track>" +
            "<TrackURI>x-sonos-http:track.mp3</TrackURI>" +
            "<TrackMetaData>meta</TrackMetaData>" +
            "<RelTime>0:01:23</RelTime>")
        };
      }
      return { status: 404, content: "" };
    });
  });

  after(() => server.close());

  it("returns parsed position info", async () => {
    const pos = await Sonos.getPositionInfo("127.0.0.1", PORT);
    assert.equal(pos.trackNum, 3);
    assert.equal(pos.trackUri, "x-sonos-http:track.mp3");
    assert.equal(pos.trackMeta, "meta");
    assert.equal(pos.relTime,  "0:01:23");
  });

  it("returns safe defaults on error", async () => {
    const pos = await Sonos.getPositionInfo("127.0.0.1", 19499);
    assert.equal(pos.trackNum,  1);
    assert.equal(pos.relTime,   "0:00:00");
    assert.equal(pos.trackUri,  "");
    assert.equal(pos.trackMeta, "");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// setAVTransportURI
// ══════════════════════════════════════════════════════════════════════════

describe("setAVTransportURI", () => {
  let server;
  const PORT = 19470;
  const lastRequest = { body: "", action: "" };

  before(async () => {
    server = await startMockSonos(PORT, (req, body) => {
      lastRequest.body   = body;
      lastRequest.action = req.headers["soapaction"] || "";
      return {
        status: 200,
        content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "SetAVTransportURI", "")
      };
    });
  });

  after(() => server.close());

  it("sends SetAVTransportURI with correct URI and metadata", async () => {
    await Sonos.setAVTransportURI("127.0.0.1", PORT, "x-sonos-vli:RINCON_ABC:1", "meta");
    assert.ok(lastRequest.action.includes("SetAVTransportURI"));
    assert.ok(lastRequest.body.includes("<CurrentURI>x-sonos-vli:RINCON_ABC:1</CurrentURI>"));
    assert.ok(lastRequest.body.includes("<CurrentURIMetaData>meta</CurrentURIMetaData>"));
  });

  it("sends empty metadata when not provided", async () => {
    await Sonos.setAVTransportURI("127.0.0.1", PORT, "x-rincon:RINCON_XYZ");
    assert.ok(lastRequest.body.includes("<CurrentURIMetaData></CurrentURIMetaData>"));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// seek
// ══════════════════════════════════════════════════════════════════════════

describe("seek", () => {
  let server;
  const PORT = 19480;
  const requests = [];

  before(async () => {
    server = await startMockSonos(PORT, (req, body) => {
      requests.push({ action: req.headers["soapaction"] || "", body });
      return {
        status: 200,
        content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "Seek", "")
      };
    });
  });

  after(() => server.close());

  it("sends TRACK_NR seek then REL_TIME seek", async () => {
    requests.length = 0;
    await Sonos.seek("127.0.0.1", PORT, 2, "0:01:30");
    assert.equal(requests.length, 2);
    assert.ok(requests[0].body.includes("<Unit>TRACK_NR</Unit>"));
    assert.ok(requests[0].body.includes("<Target>2</Target>"));
    assert.ok(requests[1].body.includes("<Unit>REL_TIME</Unit>"));
    assert.ok(requests[1].body.includes("<Target>0:01:30</Target>"));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Group management
// ══════════════════════════════════════════════════════════════════════════

describe("Group management", () => {
  let server;
  const PORT = 19450;
  const lastRequest = { body: "", action: "" };

  before(async () => {
    server = await startMockSonos(PORT, (req, body) => {
      lastRequest.body   = body;
      lastRequest.action = req.headers["soapaction"] || "";
      return {
        status: 200,
        content: soapResponse("urn:schemas-upnp-org:service:AVTransport:1", "SetAVTransportURI", "")
      };
    });
  });

  after(() => server.close());

  it("sonosJoinGroup sends x-rincon: URI", async () => {
    await Sonos.sonosJoinGroup("127.0.0.1", PORT, "RINCON_ABC123");
    assert.ok(lastRequest.body.includes("x-rincon:RINCON_ABC123"),
      "Should send x-rincon: URI");
  });

  it("sonosJoinGroup does not double-prefix x-rincon:", async () => {
    await Sonos.sonosJoinGroup("127.0.0.1", PORT, "x-rincon:RINCON_ABC123");
    const count = (lastRequest.body.match(/x-rincon:/g) || []).length;
    assert.equal(count, 1, "Should not double-prefix x-rincon:");
  });

  it("sonosLeaveGroup sends BecomeCoordinatorOfStandaloneGroup", async () => {
    await Sonos.sonosLeaveGroup("127.0.0.1", PORT);
    assert.ok(lastRequest.action.includes("BecomeCoordinatorOfStandaloneGroup"));
  });
});
