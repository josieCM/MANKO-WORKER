"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const APP_DIR_NAME = "MANKO Worker";

// Single source of truth for non-secret runtime configuration. Every module
// reads these values from the loaded config object rather than hardcoding them.
const DEFAULT_CONFIG = Object.freeze({
  // identity / pairing metadata (the secret itself lives in CredentialStore)
  workerId: null,
  base44ApiUrl: null,
  lastSeenAt: null,
  // desktop behavior
  autoStart: false,
  minimizeToTray: true,
  logLevel: "info",
  // worker runtime
  maxSessions: 5,
  commandEndpointHost: "127.0.0.1",
  commandEndpointPort: 3939,
  heartbeatIntervalMs: 10000,
  ackDelayMs: 2500,
  navigationTimeoutMs: 45000,
  crashMaxRecoveryAttempts: 3,
  crashMaxBackoffMs: 60000,
  crashRecoveryBackoffMs: Object.freeze([5000, 15000, 30000]),
  apiRetryBackoffMs: Object.freeze([1000, 2000, 5000]),
  ackRetryBackoffMs: Object.freeze([2000, 5000, 10000]),
  pairingRetryBackoffMs: Object.freeze([2000, 5000]),
  pairingPollIntervalMs: 5000,
  pairingPollTimeoutMs: 300000,
  headless: false,
  viewportWidth: 1280,
  viewportHeight: 800,
  version: "1.0.0-alpha",
});

// config.json and session.json are plaintext files: nothing matching these key
// names may ever be persisted there. Secrets belong in CredentialStore/keytar.
const SECRET_KEY_RE = /secret|password|token|cookie|authorization|credential/i;

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key));
}

function stripSecrets(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj || {})) {
    if (!isSecretKey(key)) out[key] = value;
  }
  return out;
}

// %APPDATA%/MANKO Worker on Windows; the Electron-provided per-user data
// directory elsewhere, so the app also runs outside Windows for development.
function resolveAppDataPath() {
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") {
      return path.join(app.getPath("appData"), APP_DIR_NAME);
    }
  } catch (_) {
    /* not running inside Electron (tests, scripts) */
  }
  if (process.env.APPDATA) return path.join(process.env.APPDATA, APP_DIR_NAME);
  return path.join(os.homedir(), "AppData", "Roaming", APP_DIR_NAME);
}

class ConfigManager {
  constructor(options) {
    const opts = options || {};
    this.appDataPath = opts.appDataPath || resolveAppDataPath();
    this.configPath = path.join(this.appDataPath, "config.json");
    this.sessionsPath = path.join(this.appDataPath, "sessions");
    this.logsPath = path.join(this.appDataPath, "logs");
    this.logger = opts.logger || null;
    this.config = null;
  }

  _warn(event, message) {
    if (this.logger && typeof this.logger.warn === "function") {
      this.logger.warn(event, { error: message });
    } else {
      console.error(`${event}: ${message}`);
    }
  }

  ensureDirectories() {
    fs.mkdirSync(this.appDataPath, { recursive: true });
    fs.mkdirSync(this.sessionsPath, { recursive: true });
    fs.mkdirSync(this.logsPath, { recursive: true });
  }

  getDefaults() {
    return { ...DEFAULT_CONFIG };
  }

  loadConfig() {
    this.ensureDirectories();

    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, "utf8");
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("config.json is not an object");
        }
        // Anything secret-looking that reached the file is dropped rather than
        // carried into the runtime.
        this.config = { ...DEFAULT_CONFIG, ...stripSecrets(parsed) };
      } catch (err) {
        // Never echo file contents: a malformed config may contain anything.
        this._warn("config_load_failed", err.message);
        this.config = { ...DEFAULT_CONFIG };
      }
    } else {
      this.config = { ...DEFAULT_CONFIG };
      this.saveConfig();
    }

    return this.config;
  }

  saveConfig() {
    this.ensureDirectories();
    const safe = stripSecrets(this.config || DEFAULT_CONFIG);
    // Write-then-rename so a crash mid-write cannot leave a truncated file.
    const tmpPath = `${this.configPath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(safe, null, 2));
    fs.renameSync(tmpPath, this.configPath);
  }

  updateConfig(updates) {
    this.config = { ...(this.config || DEFAULT_CONFIG), ...stripSecrets(updates) };
    this.saveConfig();
    return this.config;
  }

  get(key) {
    if (!this.config) this.loadConfig();
    return this.config[key];
  }

  set(key, value) {
    if (isSecretKey(key)) {
      throw new Error(`Refusing to persist secret-like key "${key}" to config.json`);
    }
    if (!this.config) this.loadConfig();
    this.config[key] = value;
    this.saveConfig();
  }

  // Runtime view handed to the worker modules: persisted non-secret settings
  // plus the pairing secrets held in memory only. Mutating it never touches
  // config.json, which keeps secrets out of the file by construction.
  buildRuntimeConfig(secrets) {
    const base = this.config || this.loadConfig();
    return { ...base, ...(secrets || {}) };
  }

  getSessionPath(sessionId) {
    return path.join(this.sessionsPath, sessionId);
  }

  getProfilePath(sessionId) {
    return path.join(this.getSessionPath(sessionId), "chromium-profile");
  }

  getSessionConfigPath(sessionId) {
    return path.join(this.getSessionPath(sessionId), "session.json");
  }

  loadSessionConfig(sessionId) {
    const sessionPath = this.getSessionConfigPath(sessionId);
    if (fs.existsSync(sessionPath)) {
      try {
        const data = fs.readFileSync(sessionPath, "utf8");
        return JSON.parse(data);
      } catch (err) {
        this._warn("session_config_load_failed", err.message);
        return null;
      }
    }
    return null;
  }

  saveSessionConfig(sessionId, config) {
    const sessionPath = this.getSessionPath(sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });
    const safe = stripSecrets(config);
    const target = this.getSessionConfigPath(sessionId);
    const tmpPath = `${target}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(safe, null, 2));
    fs.renameSync(tmpPath, target);
    return safe;
  }

  deleteSession(sessionId) {
    const sessionPath = this.getSessionPath(sessionId);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  listSessions() {
    if (!fs.existsSync(this.sessionsPath)) {
      return [];
    }
    return fs.readdirSync(this.sessionsPath).filter((id) => {
      const sessionPath = path.join(this.sessionsPath, id);
      return fs.statSync(sessionPath).isDirectory();
    });
  }

  getAppDataPath() {
    return this.appDataPath;
  }

  getLogsPath() {
    return this.logsPath;
  }
}

module.exports = {
  ConfigManager,
  DEFAULT_CONFIG,
  APP_DIR_NAME,
  isSecretKey,
  stripSecrets,
  resolveAppDataPath,
};
