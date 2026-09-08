"use strict";

const fs = require("fs");
const path = require("path");

// Minimal .env loader (no extra dependency).
function loadEnvFile(root) {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    val = val.replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

function required(name) {
  const v = process.env[name];
  if (!v || v.startsWith("replace-with")) {
    throw new Error(`Missing or placeholder value for required environment variable: ${name}`);
  }
  return v;
}

function loadConfig(root) {
  const resolvedRoot = root || process.cwd();
  loadEnvFile(resolvedRoot);

  const targetUrl = process.env.SESSION_TARGET_URL || "https://sportpesa.co.tz/en/casino/aviator";
  const cfg = {
    root: resolvedRoot,
    workerId: process.env.WORKER_ID || "worker-01",
    version: require(path.join(resolvedRoot, "package.json")).version,
    platform: process.platform,
    base44ApiBaseUrl: required("BASE44_API_BASE_URL").replace(/\/+$/, ""),
    workerEndpoint: (process.env.BASE44_WORKER_ENDPOINT || "").replace(/\/+$/, ""),
    workerSharedSecret: required("WORKER_SHARED_SECRET"),
    // Reserved for the remote-viewer phase (not used in this POC).
    viewerTokenHmacKey: process.env.VIEWER_TOKEN_HMAC_KEY || "",

    host: process.env.HOST || "127.0.0.1",
    port: parseInt(process.env.PORT || "3939", 10),
    headless: (process.env.HEADLESS || "false").toLowerCase() === "true",
    maxSessions: parseInt(process.env.MAX_SESSIONS || "1", 10),

    sessionDir: path.join(resolvedRoot, process.env.SESSIONS_DIR_NAME || "sessions"),
    logDir: path.join(resolvedRoot, process.env.LOG_DIR_NAME || "worker-logs"),

    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || "10000", 10),
    ackDelayMs: parseInt(process.env.ACK_DELAY_MS || "2500", 10),
    navigationTimeoutMs: parseInt(process.env.NAVIGATION_TIMEOUT_MS || "45000", 10),
    crashMaxRecoveryAttempts: parseInt(process.env.CRASH_MAX_RECOVERY_ATTEMPTS || "2", 10),

    // POC: a single configured session. The manager iterates this list,
    // so more sessions can be added later without restructuring.
    sessions: [
      {
        sessionId: process.env.SESSION_ID || "6a97b86f",
        targetUrl: targetUrl,
        allowedUrlPrefixes: (process.env.ALLOWED_URL_PREFIXES || targetUrl)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      },
    ],
  };

  fs.mkdirSync(cfg.sessionDir, { recursive: true });
  fs.mkdirSync(cfg.logDir, { recursive: true });
  return cfg;
}

module.exports = { loadConfig };