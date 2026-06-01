# MMM-SpotifySonos

A combined MagicMirror² module for **Spotify** (player, cover art, controls) and **Sonos** (speaker selection, volume, multi-room grouping) — all in one.

---

## Requirements

- **Spotify Premium** account
- **Spotify Developer App** (Client ID + Secret)
- **openssl** installed (for HTTPS auth server):
  ```bash
  sudo apt install openssl
  ```
- All Sonos devices on the same network as the Raspberry Pi

---

## Create a Spotify Developer App

1. Go to https://developer.spotify.com/dashboard → "Create App"
2. App name: anything, e.g. "MagicMirror"
3. Add a Redirect URI — must match `callbackUrl` exactly:
   e.g. `https://127.0.0.1:8888/callback`
4. Note your **Client ID** and **Client Secret**

---

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/YOUR_USER/MMM-SpotifySonos.git
cd MMM-SpotifySonos
npm install
```

`npm install` also runs `npm run prepare`, which configures the git hook for automatic deployment (see [Deploy](#deploy)).

---

## Sonos Discovery

The module auto-discovers all Sonos devices on the local network via **SSDP/UPnP** — no external service needed.

- Devices must be **powered on** and on the **same network**
- Group topology (stereo pairs, surround sets, multi-room groups) is read automatically and refreshed every 15 s
- Invisible members (Sub, satellites) are filtered out — only logical rooms are shown
- Multi-room groups expand into individual room rows, each with its own volume and group button
- Use the **↻ button** to re-run discovery manually

---

## Configuration in `config.js`

```js
{
  module: "MMM-SpotifySonos",
  position: "bottom_left",
  config: {
    clientID:        "YOUR_CLIENT_ID",
    clientSecret:    "YOUR_CLIENT_SECRET",
    pollInterval:    3000,    // Spotify poll interval in ms
    sonosRefresh:    15000,   // Sonos topology refresh in ms
    volumeStep:      5,       // volume change per tap
    showProgressBar: true,
    showCoverArt:    true,
    big_cover:       false,   // true = 300×300 cover stacked above track info
    // OAuth callback (must be registered exactly in the Spotify Developer App)
    callbackUrl:     "https://127.0.0.1:8888/callback",
    authPort:        8888,
    // SSL certificate paths (optional – auto-generated if omitted)
    // sslCert:      "/etc/ssl/certs/my.crt",
    // sslKey:       "/etc/ssl/private/my.key",
    panelAbove:      false,  // set true for bottom positions (lower_third, lower_center, etc.)
  }
}
```

### Config options

| Option | Default | Description |
|--------|---------|-------------|
| `clientID` | `""` | Spotify app Client ID |
| `clientSecret` | `""` | Spotify app Client Secret |
| `pollInterval` | `3000` | How often to poll Spotify for track state (ms) |
| `sonosRefresh` | `15000` | How often to refresh Sonos group topology (ms) |
| `volumeStep` | `5` | Volume increment/decrement per tap |
| `showProgressBar` | `true` | Show track progress bar and timestamps |
| `showCoverArt` | `true` | Show album cover art |
| `big_cover` | `false` | `true` = 300×300 cover on top, info below; `false` = 80×80 thumbnail beside info |
| `callbackUrl` | `"https://127.0.0.1:8888/callback"` | OAuth redirect URI (must match Spotify app exactly) |
| `authPort` | `8888` | Port for the local OAuth server |
| `sslCert` | — | Path to an existing SSL certificate (optional) |
| `sslKey` | — | Path to the matching private key (optional) |
| `panelAbove` | `false` | Open speaker panel upward — use for `lower_*` positions |

### callbackUrl options

| Scenario | callbackUrl |
|----------|-------------|
| Local on the Pi ✅ **recommended** | `https://127.0.0.1:8888/callback` |
| Access from another device on LAN | `https://192.168.1.XX:8888/callback` |
| Without HTTPS (not recommended) | `http://localhost:8888/callback` |

> ⚠️ `https://localhost` is **rejected** by Spotify (`redirect_uri: Insecure`).
> Use **`https://127.0.0.1`** instead — Spotify accepts this.
>
> The `callbackUrl` must be registered **exactly** (including protocol and port)
> under **Redirect URIs** in the Spotify Developer App.

---

## SSL Certificate

### Use an existing certificate (recommended if you already have one)

```js
config: {
  sslCert: "/etc/ssl/certs/my.crt",
  sslKey:  "/etc/ssl/private/my.key",
}
```

### Auto-generated self-signed certificate (default)

If `sslCert` / `sslKey` are not set, a self-signed certificate is generated
automatically on first start and saved as `.ssl-cert.pem` / `.ssl-key.pem`
in the module directory. Requires `openssl`:

```bash
sudo apt install openssl
```

> Browsers will show a warning for self-signed certificates — just click **"Proceed anyway"**. This is a one-time step.

---

## One-time Authorization (first start)

On **first start**, the terminal will print:

```
╔════════════════════════════════════════════════════╗
║  MMM-SpotifySonos – Spotify Authorization          ║
╚════════════════════════════════════════════════════╝

https://accounts.spotify.com/authorize?client_id=...
```

1. Open the URL in a browser (on the Pi or any device on the same network)
2. For HTTPS: confirm the browser certificate warning
3. Log in to Spotify and grant access
4. Browser shows "✓ MMM-SpotifySonos authorized!"
5. Token is saved to `.token.json` and refreshed automatically from now on

---

## Touch Controls

| Element | Action |
|---------|--------|
| ⏮ | Previous track |
| ▶ / ⏸ | Play / Pause |
| ⏭ | Next track |
| 🔊 | Open / close speaker panel |
| Tap room name | Activate room (start playing) / deactivate (pause) |
| `&` button | Add room to the active group, or remove it from the group |
| − / + | Adjust room volume (enabled only for active / grouped rooms) |
| ↳ label | Indicates a room is grouped with the active room |
| ↻ | Re-run Sonos discovery |

---

## Deploy

### Automatic deploy on `git push`

Every `git push` automatically deploys to the Pi before the push goes through. The hook is installed by `npm install` (via the `prepare` script).

Edit the three variables at the top of `deploy.sh` once:

```bash
PI_USER="pi"
PI_HOST="rasp.local"
PI_PATH="/home/pi/MagicMirror/modules/MMM-SpotifySonos"
```

Or set them as environment variables:

```bash
export PI_HOST=192.168.0.99
git push
```

### Manual deploy

```bash
npm run deploy
```

### What the deploy does

1. `rsync` — syncs all module files to the Pi (excludes `node_modules`, `.git`, tokens, SSL keys)
2. `npm install --omit=dev` — installs/updates dependencies on the Pi
3. `pm2 restart ~/mm.sh` — restarts MagicMirror

---

## File structure

```
MMM-SpotifySonos/
├── MMM-SpotifySonos.js      ← Frontend / DOM
├── MMM-SpotifySonos.css     ← Styling
├── sonos.js                 ← Sonos UPnP/SSDP engine
├── node_helper.js           ← Backend (Spotify API + Sonos + OAuth)
├── deploy.sh                ← Deploy script (rsync → Pi)
├── package.json
├── README.md
├── .githooks/
│   └── pre-push             ← Runs deploy.sh before every git push
├── .github/
│   └── workflows/
│       └── deploy.yml       ← Optional: GitHub Actions deploy (post-push)
├── test/
│   └── sonos.test.js        ← Unit tests for sonos.js (run: npm test)
├── .token.json              ← created automatically (Spotify OAuth token)
├── .ssl-cert.pem            ← created automatically (self-signed cert)
└── .ssl-key.pem             ← created automatically
```
