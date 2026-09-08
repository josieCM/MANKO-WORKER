"use strict";

const fs = require("fs");
const path = require("path");

// Never write these key names' values to logs.
const REDACT_KEY_RE = /secret|password|token|cookie|authorization|credential/i;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = "info";

function serializeValue(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") {
    try { return JSON.stringify(v); } catch (_) { return "[object]"; }
  }
  return String(v);
}

class Logger {
  constructor(logDir, level) {
    this.logDir = logDir;
    this.currentFile = null;
    this.setLevel(level);
  }

  setLevel(level) {
    this.level = LEVELS[level] ? level : DEFAULT_LEVEL;
  }

  _filePath() {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const file = path.join(this.logDir, `worker-${day}.log`);
    if (file !== this.currentFile) this.currentFile = file;
    return file;
  }

  _clean(fields) {
    const out = {};
    for (const [k, v] of Object.entries(fields || {})) {
      out[k] = REDACT_KEY_RE.test(k) ? "[redacted]" : v;
    }
    return out;
  }

  log(level, event, fields) {
    if ((LEVELS[level] || LEVELS[DEFAULT_LEVEL]) < LEVELS[this.level]) return;
    const ts = new Date().toISOString();
    const clean = this._clean(fields);
    const kv = Object.entries(clean)
      .map(([k, v]) => `${k}=${serializeValue(v)}`)
      .join(" ");
    const line = `${ts} ${level.toUpperCase()} ${event}${kv ? " " + kv : ""}`;
    console.log(line);
    try {
      fs.appendFileSync(this._filePath(), line + "\n");
    } catch (_) {
      /* logging must never crash the worker */
    }
  }

  debug(event, fields) { this.log("debug", event, fields); }
  info(event, fields) { this.log("info", event, fields); }
  warn(event, fields) { this.log("warn", event, fields); }
  error(event, fields) { this.log("error", event, fields); }
}

module.exports = { Logger, LEVELS };