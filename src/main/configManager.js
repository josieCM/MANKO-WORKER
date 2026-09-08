"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

class ConfigManager {
  constructor() {
    this.appDataPath = path.join(os.homedir(), "AppData", "Roaming", "MANKO Worker");
    this.configPath = path.join(this.appDataPath, "config.json");
    this.sessionsPath = path.join(this.appDataPath, "sessions");
    this.logsPath = path.join(this.appDataPath, "logs");
    this.config = null;
  }

  ensureDirectories() {
    fs.mkdirSync(this.appDataPath, { recursive: true });
    fs.mkdirSync(this.sessionsPath, { recursive: true });
    fs.mkdirSync(this.logsPath, { recursive: true });
  }

  loadConfig() {
    this.ensureDirectories();

    const defaults = {
      workerId: null,
      base44ApiUrl: null,
      pairedAt: null,
      lastSeenAt: null,
      autoStart: false,
      minimizeToTray: true,
      logLevel: "info",
      maxSessions: 5,
      commandEndpointHost: "127.0.0.1",
      commandEndpointPort: 3939,
      heartbeatIntervalMs: 10000,
      ackDelayMs: 2500,
      navigationTimeoutMs: 45000,
      crashMaxRecoveryAttempts: 3,
      crashMaxBackoffMs: 60000,
      headless: false,
      version: "1.0.0-alpha",
    };

    if (fs.existsSync(this.configPath)) {
      try {
        const data = fs.readFileSync(this.configPath, "utf8");
        this.config = { ...defaults, ...JSON.parse(data) };
      } catch (err) {
        console.error("Failed to load config, using defaults:", err.message);
        this.config = { ...defaults };
      }
    } else {
      this.config = { ...defaults };
      this.saveConfig();
    }

    return this.config;
  }

  saveConfig() {
    this.ensureDirectories();
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  updateConfig(updates) {
    this.config = { ...this.config, ...updates };
    this.saveConfig();
  }

  get(key) {
    return this.config[key];
  }

  set(key, value) {
    this.config[key] = value;
    this.saveConfig();
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
        console.error("Failed to load session config:", err.message);
        return null;
      }
    }
    return null;
  }

  saveSessionConfig(sessionId, config) {
    const sessionPath = this.getSessionPath(sessionId);
    fs.mkdirSync(sessionPath, { recursive: true });
    fs.writeFileSync(this.getSessionConfigPath(sessionId), JSON.stringify(config, null, 2));
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

module.exports = { ConfigManager };
