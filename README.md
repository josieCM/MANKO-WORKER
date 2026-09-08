# MANKO Browser Worker (worker-01) — Local POC

> **PROTOTYPE / SOURCE MATERIAL ONLY** — this folder is a development prototype
> inside the Base44 project. It is not the downloadable Windows product. See
> `PROTOTYPE.md`. The final worker will be packaged separately as a Windows
> installer with built-in pairing against the MANKO control plane.

Local browser-execution worker for the Base44 **Browser Control Plane**
(SessionSphere). This project is the worker plane only — the Base44 app is the
control plane and is **not modified** by this project.

Strict scope: browser/session infrastructure. It launches Chromium with a
persistent profile, navigates to configured pages, reports observable state,
and handles lifecycle commands. It contains **no betting/wager automation, no
auto-login, no CAPTCHA bypass, no anti-detection, no fingerprint spoofing**.
Authentication to the target website is performed **manually by an authorized
operator** in the visible browser window.

```
Base44 (control plane)
        │  HMAC-signed HTTPS (X-Worker-Signature)
worker-01 on your Windows PC
        │
   Playwright ── Chromium ── persistent profile ── target website
```

---

## 1. What is implemented (and what is not)

**Implemented**

- HMAC-SHA256 request signing/verification exactly per
  `base44/shared/WORKER_CONTRACT.md` (base64url, no padding, raw body bytes).
- Local HTTP command endpoint `POST /command` (signature verified,
  constant-time compare, command validation, URL allowlist).
- Commands: `start`, `stop`, `restart`, `reconnect`, `open_page`, `health_check`
  (idempotent; START on a running session is a no-op, STOP on a stopped session
  is safe, restart preserves the profile).
- Persistent Chromium profile per session: `sessions/<session_id>/chromium-profile/`
  (deterministic from the session id, survives STOP/restart/worker restart).
- Heartbeat loop → `POST /functions/ingestHeartbeat` every 10s while a session
  is alive; final heartbeat with status `stopped` on STOP, `crashed` on crash.
- Events → `POST /functions/ingestEvent` for lifecycle changes.
- Command ACKs → `POST /functions/ingestCommandAck` after execution (with a
  short delay so the control plane finishes marking the command `dispatched`).
- Observable auth-state detection (reads visible login/logout labels only) —
  reports `AUTHENTICATION_REQUIRED` / `AUTHENTICATION_DETECTED`.
- Bounded crash recovery (max 2 attempts, backoff, no infinite restart loop).
- Worker health endpoint `GET /healthz` (uptime, memory, CPU count, sessions).
- Structured local logs under `worker-logs/worker-YYYYMMDD.log`.
- POC limit: exactly **one** session (`6a97b86f`); additional sessions are rejected.

**NOT implemented (deliberately)**

- **Remote viewer (noVNC): NOT implemented.** `/vnc.html` returns an honest
  `501`. The control plane can mint viewer tokens, but this worker does not
  serve a VNC stream yet — that integration is isolated for a later phase.
  Because the worker runs headed on your own PC, you can interact with the
  browser window directly during this POC.
- Multi-worker, multi-session, cloud/VPS/Docker/K8s deployment, proxy
  rotation, stealth plugins — all out of scope by design.

## 2. Prerequisites (Windows)

1. **Node.js 20 LTS** — <https://nodejs.org> (installer → Next → Next → Install).
   Verify in PowerShell:
   ```powershell
   node -v
   npm -v
   ```
2. This project folder on your PC (e.g. `C:\manko\browser-worker`).

## 3. Installation

In PowerShell, from the project root:

```powershell
cd C:\manko\browser-worker

# 1. Dependencies (playwright)
npm install

# 2. Chromium browser for Playwright
npx playwright install chromium
```

## 4. Configuration

Copy `.env.example` to `.env` and fill in the real values:

```powershell
Copy-Item .env.example .env
notepad .env
```

| Variable | Meaning |
| --- | --- |
| `BASE44_API_BASE_URL` | `https://session-sphere-flow.base44.app` |
| `BASE44_WORKER_ENDPOINT` | This worker's URL **as reachable from Base44's servers** (see §5) |
| `WORKER_ID` | `worker-01` |
| `WORKER_SHARED_SECRET` | **Same value** as the `WORKER_SHARED_SECRET` secret in the Base44 app settings |
| `VIEWER_TOKEN_HMAC_KEY` | Same value as the Base44 app secret (reserved for the viewer phase; unused now) |
| `SESSION_ID` | `6a97b86f` |
| `SESSION_TARGET_URL` | `https://sportpesa.co.tz/en/casino/aviator` |
| `ALLOWED_URL_PREFIXES` | `https://sportpesa.co.tz` — navigation to anything else is refused |
| `HOST` / `PORT` | Command endpoint bind address (default `127.0.0.1:3939`) |

Never commit `.env`. The worker refuses to start with placeholder secret values.

## 5. Networking prerequisite (important)

The control plane **pushes** commands to `POST <BASE44_WORKER_ENDPOINT>/command`
and heartbeats flow worker → Base44. Two things must be true:

1. Worker → Base44 works from any normal internet connection (outbound HTTPS).
2. Base44 → worker requires your PC to be reachable at `BASE44_WORKER_ENDPOINT`.

For the POC on a home/gaming PC, pick ONE:

- **Router port-forward** your `PORT` (e.g. 3939) to the PC and set
  `BASE44_WORKER_ENDPOINT=http://<your-public-ip>:3939` and `HOST=0.0.0.0`.
  Add a firewall rule for inbound TCP 3939 and restrict the source if possible.
- **HTTPS tunnel** (recommended, keeps TLS): run e.g. `cloudflared tunnel` or
  `ngrok http 3939` and set `BASE44_WORKER_ENDPOINT` to the tunnel's https URL.

Finally, the **`BrowserWorker` record in Base44 must be updated** with
`worker_id: worker-01`, your `endpoint_url`, and status `online` — ask the
Base44 assistant to update it once you know your endpoint URL. Without it,
dispatched commands are created but stubbed (never reach this worker), and
viewer URLs stay empty.

## 6. Starting the worker

```powershell
npm start
```

Expected startup output:

```
Worker starting
Worker ID: worker-01
Platform: win32
Browser engine: Chromium
Status: starting
Command endpoint:  http://127.0.0.1:3939/command
Status: online (command endpoint listening)
Base44 control plane: https://session-sphere-flow.base44.app (worker_id=worker-01)
```

Verify locally: `http://127.0.0.1:3939/healthz` returns worker status JSON.
Run the signing self-test any time with: `npm run verify`.

## 7. First test procedure (POC acceptance flow)

1. Start the worker (`npm start`) → worker-01 online.
2. In Base44 → System Health: confirm the worker shows online (after a
   heartbeat or registration update).
3. In Base44 → open the session `6a97b86f` → issue **START**.
4. Worker launches Chromium with `sessions/6a97b86f/chromium-profile/` and
   navigates to `https://sportpesa.co.tz/en/casino/aviator`.
5. Base44 session detail shows `starting → browser_ready → page_loading → …`,
   events appear, heartbeats arrive every ~10s, command shows `ack`.
6. If login is required, the session shows `authentication_required`.
   **Log in manually in the Chromium window on the PC.**
7. Worker observes the logout label → reports `ready` → `active`.
8. Issue **STOP** → browser closes, profile retained, session `stopped`.
9. Issue **START** again → same profile is reused (you stay logged in).
10. Kill the Chromium window abruptly → worker reports `BROWSER_CRASHED` and
    attempts bounded recovery.

## 8. Security notes

- Secrets only via environment variables; never committed, never logged
  (logger redacts secret/token/cookie/credential keys).
- All incoming commands HMAC-verified with constant-time comparison before
  any execution; malformed requests rejected with 400/401/403.
- Navigation restricted to the configured URL allowlist per session.
- Browser cookies/local storage/credentials stay **local** on this PC — never
  sent to Base44 (Base44 stores only the persistence reference).
- Bind the command endpoint to `127.0.0.1` unless dispatch requires exposure;
  no debugging port or DevTools is exposed by the worker.
- Chromium DevTools/WebSocket debugging endpoints are not opened to the network.

## 9. Project layout

```
browser-worker/
  src/
    index.js            entrypoint, startup banner, signal handling
    config.js           .env loading + validation, session/allowlist config
    worker.js           identity, HTTP server (/command, /healthz, /vnc.html)
    commandHandler.js   HMAC verify, validation, execution, ACK
    sessionManager.js   session registry, lifecycle, states, crash recovery
    browserManager.js   Playwright persistent context, navigation, probes
    heartbeat.js        heartbeat loop per session
    base44Client.js     signing + HMAC POSTs with bounded retry
    events.js           session event reporting
    logger.js           structured console + file logs, secret redaction
  scripts/verify-signing.js   npm run verify
  sessions/    persistent profiles (gitignored)
  worker-logs/ local logs (gitignored)
`