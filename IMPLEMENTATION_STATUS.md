# MANKO Worker — Implementation Status (audit checkpoint)

Audit date: 2026-09-08. Audited commit: `14d2c23` (merge of PR #1) on `main`.
This is an audit-only document. No application behavior was changed to produce it.

## 1. Project purpose

MANKO Worker is a Windows Electron desktop application that acts as the **worker plane**
for the Base44 "Browser Control Plane" (SessionSphere). It launches Chromium through
Playwright with a persistent per-session profile, navigates to allowlisted pages,
reports observable state (heartbeats/events) to Base44, and executes lifecycle commands
pushed by the control plane over an HMAC-signed local HTTP endpoint.

Out of scope by design: betting/wager automation, auto-login, CAPTCHA bypass,
anti-detection/fingerprint spoofing. Operator authentication is manual.

**Target runtime is Windows.** Linux is only used as the audit/dev environment; the
Linux limitations listed in §6 are environment facts, not architectural problems.

## 2. Current architecture

```
src/main/       Electron main process
  index.js          app lifecycle -> AppController
  appController.js  wiring: config, credentials, pairing vs online mode, IPC, tray, window
  configManager.js  JSON config + per-session dirs under %APPDATA%/MANKO Worker
  credentialStore.js keytar (Windows Credential Manager) wrapper
  pairingManager.js  polls Base44 for pairing credentials (contract unconfirmed)
  commandReceiver.js HTTP server: POST /command, GET /healthz
  commandHandler.js  HMAC verify -> validate -> registry dispatch -> ACK
  commandRegistry.js Map of command_type -> {handler, validator, schema}
  sessionManager.js  session records, lifecycle, state machine, crash recovery
  browserManager.js  Playwright persistent context, navigation, observable probes
  heartbeat.js       per-session heartbeat loop
  events.js          ingestEvent reporting
  base44Client.js    HMAC signing/verification + POST with bounded retry
  logger.js          structured file/console logs with key redaction
  trayManager.js     system tray (skipped when icon missing/empty)
src/renderer/   pairing.html/js, main.html/js, preload.js (contextBridge), styles.css
src/*.js        LEGACY standalone Node POC (index.js, worker.js, config.js,
                sessionManager.js, ...). Not referenced by the Electron entry point.
scripts/verify-signing.js   HMAC self-test (`npm run verify`)
```

Entry point: `package.json` `main` = `src/main/index.js`. Renderer runs with
`nodeIntegration: false`, `contextIsolation: true`, and a preload bridge.

Dependency versions as installed: electron 29.4.6, electron-builder 24.13.3,
playwright 1.62.1, keytar 7.9.0, jest 29.7.0. Scripts: `start`, `verify`, `build`,
`build:win`, `test`.

## 3. Git history (verified)

The whole source tree entered the repo in a single commit; there are no separate
commits for the individual Phase 1 items.

| Claimed work | Commit | Verdict |
| --- | --- | --- |
| ZIP unpacked, `node_modules` removed | `097e12c` (PR #1, merged as `14d2c23`) | Verified |
| `.gitignore` recreated | `097e12c` | Verified (originals in the ZIP were unreadable) |
| `.env.example` recreated | `097e12c` | Verified — reconstructed from `src/config.js` (legacy POC), so it does **not** describe the Electron config surface |
| trayManager tolerates missing icon | `097e12c` | Present in the code, but it arrived inside the ZIP; there is no commit in this repo that introduced it |
| `ELECTRON_RUN_AS_NODE=1` startup fix | none | **Not in this repo.** No file references that variable; it was an environment-level fix, not a code change |
| Devin blueprint / environment setup | none | Blueprint is stored in Devin settings, not in git; no `.devin/` directory exists |

## 4. Component status

| Component | Status | Evidence / gap |
| --- | --- | --- |
| Electron main process | COMPLETE | `src/main/index.js` + `appController.js`; app boots, initializes, quits cleanly |
| preload / context isolation | COMPLETE | `contextIsolation: true`, `nodeIntegration: false`, `contextBridge` surface matches the registered IPC channels |
| renderer / UI | PARTIAL | Pairing view renders and is wired; main dashboard/settings view has never been reached (requires a paired worker) so it is unverified. Session table renders whatever `listSessions()` returns |
| configuration management | PARTIAL | `ConfigManager` works, but the AppData path is hardcoded (`os.homedir()/AppData/Roaming`) rather than `app.getPath("userData")`, and the legacy `.env` config path (`src/config.js`) still coexists. `autoStart` and `minimizeToTray` are persisted but not acted on anywhere |
| Credential Manager / keytar | PARTIAL | `CredentialStore` implements store/get/delete/find against keytar; never exercised end to end because pairing never completes. Unverifiable on Linux (no secret service) |
| pairing | PARTIAL | UI + IPC + polling loop exist, but: the Base44 pairing contract is explicitly marked unknown in `pairingManager.js`; in pairing mode `base44Client` is only constructed when `config.base44ApiUrl` is already set (it is `null` by default), so `submitPairingCode` would fail on a null client; `requestPairing()` is never called by any UI path; and signing a pairing request needs a shared secret the worker does not yet have |
| worker identity | PARTIAL | `workerId` comes from stored credentials/config. `appController` emits `worker_id: config.worker_id` for the WORKER_ONLINE event, but the config key is `workerId`, so that field is `undefined` |
| session manager | PARTIAL | Full lifecycle (start/stop/restart/reconnect/open_page/health), state machine and registry implemented. But nothing ever calls `assignSession()`/`revokeSession()` — no command or IPC path assigns a session — so a session can only exist if a `session.json` already sits on disk. `revokeSession()` also references an undefined `session_id` in its log calls |
| persistent browser profiles | COMPLETE (code) / UNKNOWN (runtime) | Deterministic `sessions/<id>/chromium-profile` via `launchPersistentContext`; never launched in this audit |
| command registry | COMPLETE | `CommandRegistry` + six registered commands |
| command validation / schema | PARTIAL | Validators are hand-written and shallow; the `schema` argument is stored but never used |
| command receiver | COMPLETE (code) / UNKNOWN (runtime) | `POST /command`, `GET /healthz`, 404 fallback; only starts in online mode, so it was never listening during this audit |
| command ACK / idempotency | COMPLETE (code) | Executed-id ring buffer (100 entries, in-memory only — resets on restart), delayed ACK for both fresh and duplicate commands |
| heartbeat | COMPLETE (code) / UNKNOWN (runtime) | Per-session loop, immediate first tick, final `stopped`/`crashed` heartbeat, failure counter |
| worker / session events | PARTIAL | `EventReporter` covers session-scoped events; worker-level events are sent with `session_id: "worker"`, which the contract note in `events.js` says is not a real session id |
| crash recovery | COMPLETE (code) / UNKNOWN (runtime) | Bounded attempts with `[5s, 15s, 30s]` backoff, terminal `error` state, no infinite loop |
| reconnect / offline behavior | PARTIAL | `reconnect` command reattaches to a live context; heartbeat failures are counted and reported at 3 consecutive misses, but there is no offline queue, no re-registration after the control plane returns, and no worker-level online/offline state machine |
| security / HMAC | COMPLETE (verified) | `signBody`/`verifyBody` base64url unpadded, constant-time compare, 4xx not retried, logger redacts secret-like keys. `npm run verify` passes |
| logging | COMPLETE | Daily file + console, key redaction. `logLevel` from config is not honored (all levels always written) |
| Windows packaging | NOT STARTED | electron-builder config exists (nsis, x64) but has never been run. `build/icon.ico` referenced by `build`, `nsis`, and the BrowserWindow is **absent from the repo** (only `build/.gitkeep`). `extraResources` expects `node_modules/playwright-core/.local-browsers/chromium-*/chrome-win`, and nothing installs that browser (no postinstall) |
| tests | PARTIAL | `tests/credentialStore.test.js` (18 Jest tests, keytar mocked) covers Phase 2 only. No tests for any other component. `scripts/verify-signing.js` plus two throwaway Electron smoke files (`test-electron.js`, `test-simple.js`) at the repo root |

## 5. Phase status

| Phase | Status | Notes |
| --- | --- | --- |
| 1 — Foundation | COMPLETE | Repo unpacked, deps install, `npm run verify` passes, `npm start` opens the pairing window |
| 2 — Credential Storage | COMPLETE (behavior verified against mocked keytar; Windows Credential Manager persistence still requires Windows verification) | See §5a |
| 3 — Configuration Refactor | PARTIAL | AppData config manager exists; hardcoded path, dead legacy `.env` config, unhonored settings |
| 4 — Pairing | PARTIAL | UI/flow scaffolded; Base44 contract unknown, null-client bug, request-code path missing |
| 5 — Command Registry | COMPLETE (code) | Registry + validators + dispatch; runtime unverified |
| 6 — Session Manager | PARTIAL | Lifecycle complete; no session assignment path, `revokeSession` bug |
| 7 — CommandReceiver | COMPLETE (code) | HTTP endpoint implemented; never started in this audit |
| 8 — UI | PARTIAL | Pairing view verified; main dashboard unverified |
| 9 — Heartbeat / Events | PARTIAL | Session heartbeats/events implemented; worker-level events use a fake session id |
| 10 — Error Recovery | PARTIAL | Browser crash recovery implemented; control-plane offline behavior thin |
| 11 — Security Hardening | PARTIAL | HMAC verified; no rate limiting, no request-timestamp/replay window, idempotency cache is memory-only |
| 12 — Windows Packaging | NOT STARTED | Never built; icon and bundled Chromium missing |
| 13 — Testing | PARTIAL | Jest suite exists but covers Phase 2 credential storage only |
| 14 — Documentation | PARTIAL | README describes the legacy POC (`npm start` as a Node worker, `.env` config), not the current Electron app |
| 15 — Release | NOT STARTED | — |

### 5a. Phase 2 — Credential Storage (implemented)

Production backend is unchanged: Windows Credential Manager → keytar → `CredentialStore`.
No plaintext or Linux fallback was added.

- Naming is centralized in `src/main/credentialStore.js`: one exported `SERVICE_NAME`
  (`"MANKO Worker"`) and `accountForWorker(workerId)`. The account name is the worker id,
  so re-pairing the same worker overwrites its record via `setPassword` instead of
  creating a duplicate; pairing under a new worker id removes the stale account.
- Stored record (single JSON value per account): `worker_shared_secret`,
  `base44_api_url`, `paired_at`. `worker_id` is the account name.
- API: `storeCredentials`, `getCredentials`, `hasCredentials`, `getPairedWorkerId`,
  `deleteCredentials`, `clearAllCredentials`, `checkBackend`, `isBackendAvailable`,
  `getBackendError`. Pre-existing method names and signatures are unchanged
  (`storeCredentials` gained an optional trailing `opts`).
- Missing records return `null`/`false`; backend failures mark the store unavailable and
  return safe values rather than throwing, except `storeCredentials`, which throws an
  error tagged `CREDENTIAL_BACKEND_UNAVAILABLE`.
- Secrets never reach logs or error messages: keytar errors are scrubbed of known secret
  values before logging, and a corrupt stored record is reported by name, never echoed.
- Configuration boundary: the credential store is now the source of truth for the pairing
  identity. `appController` resolves the paired worker id from it, and pairing no longer
  mirrors `workerId` / `base44ApiUrl` / `pairedAt` into `config.json`. Non-secret runtime
  settings stay in `configManager` (the wider Phase 3 refactor was not done).
- Security boundary unchanged: this store holds only MANKO Worker control-plane pairing
  secrets — never target-site passwords, cookies, or browser tokens.

## 6. Known limitations and blockers

Environment (Linux audit box — document, do not "fix" by changing architecture):

- keytar cannot reach a secret service (`Unknown or unsupported transport "disabled"`);
  the store records the backend as unavailable, logs `credential_backend_unavailable`,
  and reports unpaired, so the app boots into pairing mode here without crashing.
  **Actual Windows Credential Manager persistence has NOT been verified end to end and
  requires a Windows run.** Phase 2 behavior was verified against mocked keytar only.
- Windows Credential Manager, `.ico` tray/window icons, and the NSIS installer target
  are all Windows-only and cannot be validated on this machine.
- The tray is skipped on every platform right now because the icon file is absent.

Blockers to progress:

1. **Base44 pairing contract is unknown** (`requestWorkerPairing` / `workerPairingPoll`
   request and response shapes, and how the first request is authenticated without a
   shared secret). Phase 4 cannot be finished without it.
2. **No session assignment path** from the control plane to `SessionManager.assignSession`.
3. `build/icon.ico` does not exist in the repo, which blocks Phase 12.

## 7. Verification performed in this audit

```
git log --stat                 # history reconstructed; single source commit
npm ls --depth=0               # electron 29.4.6, playwright 1.62.1, keytar 7.9.0
npm run verify                 # PASS: signing round-trip, tamper rejection, WebCrypto parity
node -e "require('src/main/sessionManager.js'); require('src/main/commandHandler.js')"  # modules load
DISPLAY=:0 npm start           # Electron boots, pairing window renders, tray skipped
```

Phase 2:

```
npx jest tests/credentialStore.test.js   # PASS: 18/18
npm test                                 # PASS: 1 suite, 18 tests
npm run verify                           # PASS
DISPLAY=:0 npm start                     # boots to pairing mode; logs
                                         # credential_backend_unavailable, no crash
```

Test coverage: save, get, exists/isPaired, clear (single and all), missing and corrupt
records, repeated save/update and stale-account cleanup, backend-error handling for every
operation, and absence of secret leakage in logs, thrown errors, and stored backend state.

Not exercised: pairing round trip, command endpoint, heartbeat delivery, browser
launch, crash recovery, installer build.

## 8. Checkpoint

- **CURRENT CHECKPOINT:** Phase 2 (Credential Storage) COMPLETE, verified against mocked
  keytar; Windows Credential Manager persistence still requires verification on Windows.
  Phase 1 (Foundation) COMPLETE and verified. Phases 3–11 exist as unverified scaffolding
  of varying depth; Phases 12 and 15 not started, 13 partial (Phase 2 tests only).
- **NEXT AUTHORIZED PHASE:** Phase 3 — Configuration Refactor.

## 9. Rules for future sessions

- Phase 1 is done. Do **not** re-unpack the ZIP, re-create `.gitignore`/`.env.example`,
  or redo the Electron bootstrap.
- Phase 2 is done. Do **not** rewrite `credentialStore.js`, add a second credential
  store, or introduce a non-keytar backend.
- Do not refactor working code for style. Do not start a later phase before the
  current one is authorized.
- The target runtime is Windows Electron. Do not replace Windows-specific
  functionality (keytar/Credential Manager, NSIS, `.ico`) with Linux substitutes to
  make a Linux environment pass — document the limitation instead.
- Do not mark a phase COMPLETE because files exist; mark it COMPLETE only when the
  behavior is implemented and verified, otherwise PARTIAL or UNKNOWN.
