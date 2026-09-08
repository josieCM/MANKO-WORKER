"use strict";

const { BrowserManager } = require("./browserManager");
const { Heartbeat } = require("./heartbeat");

const { DEFAULT_CONFIG } = require("./configManager");

class SessionManager {
  constructor(cfg, logger, base44, events, configManager) {
    this.cfg = cfg;
    this.logger = logger;
    this.base44 = base44;
    this.events = events;
    this.configManager = configManager;
    this.sessions = new Map(); // sessionId -> record
    this.executedCommandIds = [];
    this.sessionDir = configManager.sessionsPath;
  }

  // ---- dynamic session management -------------------------------------------

  assignSession(sessionConfig) {
    const { session_id, target_url, allowed_url_prefixes, metadata } = sessionConfig;
    
    if (this.sessions.has(session_id)) {
      this.logger.warn("session_already_exists", { session_id });
      return false;
    }

    // Save session config to file
    this.configManager.saveSessionConfig(session_id, {
      session_id,
      target_url: target_url,
      allowed_url_prefixes: allowed_url_prefixes || [target_url],
      metadata: metadata || {},
      state: "assigned",
      created_at: new Date().toISOString(),
    });

    this.logger.info("session_assigned", { session_id, target_url });
    return true;
  }

  revokeSession(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) {
      this.logger.warn("session_not_found_for_revoke", { session_id });
      return false;
    }

    // Stop session if running
    if (rec.browser.isRunning()) {
      this.stopSession(sessionId).catch((err) => {
        this.logger.warn("stop_session_during_revoke_failed", { session_id: sessionId, error: err.message });
      });
    }

    // Delete session config and profile
    this.configManager.deleteSession(sessionId);
    this.sessions.delete(sessionId);

    this.logger.info("session_revoked", { session_id });
    return true;
  }

  getSessionConfig(sessionId) {
    // Load from file for dynamic sessions
    return this.configManager.loadSessionConfig(sessionId);
  }

  ownsSession(sessionId) {
    return this.sessions.has(sessionId) || this.configManager.loadSessionConfig(sessionId) !== null;
  }

  hasExecuted(commandId) {
    return this.executedCommandIds.includes(commandId);
  }

  markExecuted(commandId) {
    this.executedCommandIds.push(commandId);
    if (this.executedCommandIds.length > 100) this.executedCommandIds.shift();
  }

  _record(sessionId) {
    if (!this.sessions.has(sessionId)) {
      const browser = new BrowserManager(this.cfg, this.logger);
      browser.onUnexpectedClose = (sid) => this._onUnexpectedClose(sid);
      this.sessions.set(sessionId, {
        sessionId,
        browser,
        heartbeat: null,
        state: "created",
        authStatus: "unknown",
        lastNavigationAt: null,
        lastNavigationUrl: null,
        startedAt: null,
        crashRecoveryAttempts: 0,
        recovering: false,
        authEventSent: false,
      });
    }
    return this.sessions.get(sessionId);
  }

  isUrlAllowed(sessionId, url) {
    if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
    const s = this.getSessionConfig(sessionId);
    if (!s) return false;
    const prefixes = s.allowed_url_prefixes || [s.target_url];
    return prefixes.some((prefix) => 
      url.toLowerCase().startsWith(prefix.toLowerCase().replace(/\/+$/, "")) ||
      url.toLowerCase().startsWith(prefix.toLowerCase())
    );
  }

  _resolveUrl(sessionId, suppliedUrl) {
    const s = this.getSessionConfig(sessionId);
    const url = suppliedUrl || s.target_url;
    if (!this.isUrlAllowed(sessionId, url)) {
      const err = new Error("URL rejected: outside the configured allowlist");
      err.code = "URL_NOT_ALLOWED";
      throw err;
    }
    return url;
  }

  // ---- lifecycle ---------------------------------------------------------

  async startSession(sessionId, opts) {
    const o = opts || {};
    const rec = this._record(sessionId);

    // Idempotent: START on a running session is a no-op
    if (rec.browser.isRunning()) {
      this.logger.info("session_start_idempotent", { session: sessionId });
      return { state: rec.state, idempotent: true };
    }

    const activeCount = this.activeSessionCount();
    if (activeCount >= this.cfg.maxSessions) {
      const err = new Error(
        `Max sessions limit reached: ${this.cfg.maxSessions}; ${activeCount} already active`
      );
      err.code = "MAX_SESSIONS";
      throw err;
    }

    const url = this._resolveUrl(sessionId, o.url);
    rec.state = "starting";
    rec.startedAt = new Date().toISOString();
    
    await this.events.sessionEvent(sessionId, "SESSION_STARTING", {
      message: "Session starting",
      metadata: { url },
    });
    await this.events.sessionEvent(sessionId, "BROWSER_STARTED", {
      message: "Persistent Chromium context launching",
    });

    await rec.browser.launch(sessionId, this.sessionDir);
    rec.state = "browser_ready";
    await this.events.sessionEvent(sessionId, "BROWSER_READY", {
      message: "Browser ready with persistent profile",
      metadata: { profile: `sessions/${sessionId}/chromium-profile` },
    });

    // Navigate to the configured target page
    rec.state = "page_loading";
    await this.events.sessionEvent(sessionId, "PAGE_OPENED", {
      message: "Navigating to " + url,
      metadata: { url },
    });
    this.logger.info("navigation_started", { session: sessionId, url });
    
    let nav;
    try {
      nav = await rec.browser.navigate(url);
    } catch (err) {
      await this.events.sessionEvent(sessionId, "NAVIGATION_ERROR", {
        severity: "error",
        message: "Navigation failed: " + err.message,
        metadata: { url },
      });
      await this.events.sessionEvent(sessionId, "ERROR", {
        severity: "error",
        message: "Session start aborted after navigation failure",
      });
      rec.state = "error";
      throw err;
    }
    rec.lastNavigationAt = new Date().toISOString();
    rec.lastNavigationUrl = nav.finalUrl;

    // Observable authentication check
    const auth = await rec.browser.detectAuthState();
    rec.authStatus = auth.status;
    if (auth.status === "required") {
      rec.state = "authentication_required";
      rec.authEventSent = true;
      await this.events.sessionEvent(sessionId, "AUTHENTICATION_REQUIRED", {
        message: "Manual operator authentication required",
        metadata: { evidence: auth.evidence },
      });
      this.logger.info("authentication_required", { session: sessionId });
    } else {
      rec.state = "ready";
      await this.events.sessionEvent(sessionId, "SESSION_READY", {
        message: "Page loaded",
        metadata: { http_status: nav.httpStatus, url: nav.finalUrl, auth: auth.status },
      });
    }

    rec.heartbeat = new Heartbeat(this.cfg, this.logger, this.base44, this, sessionId);
    rec.heartbeat.start();
    this.logger.info("session_started", { session: sessionId, state: rec.state, url: nav.finalUrl });
    return { state: rec.state, url: nav.finalUrl };
  }

  async stopSession(sessionId, opts) {
    const o = opts || {};
    const rec = this._record(sessionId);
    const wasRunning = rec.browser.isRunning();

    if (rec.heartbeat) {
      if (o.finalHeartbeatStatus !== false) {
        await rec.heartbeat.send(o.finalHeartbeatStatus || "stopped").catch(() => {});
      }
      rec.heartbeat.stop();
      rec.heartbeat = null;
    }
    await rec.browser.close();
    rec.state = "stopped";
    await this.events.sessionEvent(sessionId, "SESSION_STOPPED", {
      message: "Session stopped; persistent profile retained",
      metadata: { was_running: wasRunning, profile: `sessions/${sessionId}/chromium-profile` },
    });
    this.logger.info("session_stopped", { session: sessionId });
    return { state: rec.state, wasRunning };
  }

  async restartSession(sessionId, opts) {
    const rec = this._record(sessionId);
    await this.stopSession(sessionId, { finalHeartbeatStatus: false });
    rec.crashRecoveryAttempts = 0;
    await this.events.sessionEvent(sessionId, "SESSION_RESTARTED", {
      message: "Session restarting with the same persistent profile",
    });
    const result = await this.startSession(sessionId, opts);
    return { state: result.state, restarted: true };
  }

  async reconnectSession(sessionId) {
    const rec = this._record(sessionId);
    if (!rec.browser.isRunning()) {
      const err = new Error("Reconnect impossible: no browser context is running for this session");
      err.code = "NO_BROWSER";
      throw err;
    }
    
    let snap = await rec.browser.snapshot();
    if (!snap.pageAlive) {
      this.logger.warn("reconnect_page_dead_creating_new_page", { session: sessionId });
      await rec.browser.openNewPageInContext();
      const s = this.getSessionConfig(sessionId);
      await this.events.sessionEvent(sessionId, "PAGE_OPENED", {
        message: "Reconnecting: navigating to " + s.target_url,
      });
      await rec.browser.navigate(s.target_url);
      snap = await rec.browser.snapshot();
    }
    rec.state = "active";
    await this.events.sessionEvent(sessionId, "SESSION_RECONNECTED", {
      message: "Session reconnected to existing browser context",
      metadata: { page_alive: snap.pageAlive, url: snap.currentUrl },
    });
    return { state: rec.state, pageAlive: snap.pageAlive };
  }

  async openPage(sessionId, url) {
    const rec = this._record(sessionId);
    if (!rec.browser.isRunning()) {
      const err = new Error("Session is not running; start it before opening a page");
      err.code = "SESSION_NOT_RUNNING";
      throw err;
    }
    const resolved = this._resolveUrl(sessionId, url);
    rec.state = "page_loading";
    await this.events.sessionEvent(sessionId, "PAGE_OPENED", {
      message: "Navigating to " + resolved,
      metadata: { url: resolved },
    });
    this.logger.info("navigation_started", { session: sessionId, url: resolved });
    
    let nav;
    try {
      nav = await rec.browser.navigate(resolved);
    } catch (err) {
      await this.events.sessionEvent(sessionId, "NAVIGATION_ERROR", {
        severity: "error",
        message: "Navigation failed: " + err.message,
        metadata: { url: resolved },
      });
      rec.state = "error";
      throw err;
    }
    rec.lastNavigationAt = new Date().toISOString();
    rec.lastNavigationUrl = nav.finalUrl;
    const auth = await rec.browser.detectAuthState();
    rec.authStatus = auth.status;
    if (auth.status === "required") {
      rec.state = "authentication_required";
      rec.authEventSent = true;
      await this.events.sessionEvent(sessionId, "AUTHENTICATION_REQUIRED", {
        message: "Manual operator authentication required",
        metadata: { evidence: auth.evidence },
      });
    } else {
      rec.state = "ready";
      await this.events.sessionEvent(sessionId, "SESSION_READY", {
        message: "Page loaded",
        metadata: { url: nav.finalUrl },
      });
    }
    return { state: rec.state, url: nav.finalUrl };
  }

  async healthCheck(sessionId) {
    const health = this.getSessionHealth(sessionId);
    if (!health) throw new Error("Unknown session: " + sessionId);
    return health;
  }

  // ---- observable state ---------------------------------------------------

  getSessionHealth(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return null;
    const browserAlive = rec.browser.isRunning();
    let pageAlive = false;
    let currentUrl = rec.lastNavigationUrl;
    let title = null;
    if (browserAlive && rec.browser.page) {
      pageAlive = !rec.browser.page.isClosed();
      try { currentUrl = rec.browser.page.url(); } catch (_) { /* keep last known */ }
    }
    return {
      state: rec.state,
      browserAlive,
      pageAlive,
      currentUrl,
      pageTitle: rec.pageTitle || null,
      authenticationStatus: rec.authStatus,
      lastNavigationAt: rec.lastNavigationAt,
      latencyMs: null,
      status: rec.state,
      pageStatus: rec.state === "stopped" ? "stopped" : (rec.state === "page_loading" ? "loading" : (currentUrl || "n/a")),
    };
  }

  async refreshSessionState(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.browser.isRunning()) return null;
    const snap = await rec.browser.snapshot();
    if (snap.pageAlive) {
      const auth = await rec.browser.detectAuthState();
      if (auth.status === "required" && rec.authStatus !== "required") {
        rec.authStatus = "required";
        rec.state = "authentication_required";
        await this.events.sessionEvent(sessionId, "AUTHENTICATION_REQUIRED", {
          message: "Manual operator authentication required",
          metadata: { evidence: auth.evidence },
        });
      } else if (auth.status === "authenticated" && rec.authStatus !== "authenticated") {
        rec.authStatus = "authenticated";
        if (rec.state === "authentication_required" || rec.state === "ready") {
          await this.events.sessionEvent(sessionId, "AUTHENTICATION_DETECTED", {
            message: "Operator authentication observed",
            metadata: { evidence: auth.evidence },
          });
          rec.state = "ready";
        }
      }
      if (rec.state === "ready" && rec.authStatus === "authenticated") {
        rec.state = "active";
      }
      if (snap.title) rec.pageTitle = snap.title;
      return snap;
    } else {
      this.logger.warn("page_dead_detected", { session: sessionId });
      return snap;
    }
  }

  reportHeartbeatFailure(sessionId, consecutiveFailures) {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    if (consecutiveFailures === 3) {
      this.events
        .sessionEvent(sessionId, "HEARTBEAT_FAILED", {
          severity: "warn",
          message: "Heartbeat delivery failing; Base44 may be unreachable (session continues running)",
          metadata: { consecutive: consecutiveFailures },
        })
        .catch(() => {});
    }
  }

  // ---- crash recovery -------------------------------------------------------

  async _onUnexpectedClose(sessionId) {
    const rec = this.sessions.get(sessionId);
    if (!rec || rec.recovering || rec.state === "stopped" || rec.state === "stopping") return;
    rec.recovering = true;
    if (rec.heartbeat) {
      await rec.heartbeat.send("crashed").catch(() => {});
      rec.heartbeat.stop();
      rec.heartbeat = null;
    }
    rec.state = "crashed";
    await this.events.sessionEvent(sessionId, "BROWSER_CRASHED", {
      severity: "error",
      message: "Chromium closed unexpectedly",
      metadata: { recovery_attempt: rec.crashRecoveryAttempts + 1 },
    });
    this.logger.error("browser_crashed", { session: sessionId });

    while (rec.crashRecoveryAttempts < this.cfg.crashMaxRecoveryAttempts) {
      const schedule = this.cfg.crashRecoveryBackoffMs || DEFAULT_CONFIG.crashRecoveryBackoffMs;
      const backoff = schedule[Math.min(rec.crashRecoveryAttempts, schedule.length - 1)];
      this.logger.warn("crash_recovery_scheduled", {
        session: sessionId,
        attempt: rec.crashRecoveryAttempts + 1,
        backoff_ms: backoff,
      });
      await new Promise((r) => setTimeout(r, backoff));
      rec.crashRecoveryAttempts++;
      try {
        await rec.browser.close();
        const result = await this.startSession(sessionId, {});
        this.logger.info("crash_recovery_succeeded", { session: sessionId, state: result.state });
        await this.events.sessionEvent(sessionId, "SESSION_RECONNECTED", {
          message: "Automatic crash recovery succeeded; same persistent profile reused",
          metadata: { attempt: rec.crashRecoveryAttempts },
        });
        rec.crashRecoveryAttempts = 0;
        rec.recovering = false;
        return;
      } catch (err) {
        this.logger.warn("crash_recovery_failed", {
          session: sessionId,
          attempt: rec.crashRecoveryAttempts,
          error: err.message,
        });
      }
    }
    rec.state = "error";
    await this.events.sessionEvent(sessionId, "ERROR", {
      severity: "critical",
      message: "Crash recovery exhausted; session marked error (no further restart attempts)",
      metadata: { attempts: rec.crashRecoveryAttempts },
    });
    rec.recovering = false;
  }

  activeSessionCount() {
    let n = 0;
    for (const rec of this.sessions.values()) {
      if (rec.browser.isRunning()) n++;
    }
    return n;
  }

  listSessions() {
    const sessions = [];
    for (const [sessionId, rec] of this.sessions) {
      const config = this.getSessionConfig(sessionId);
      sessions.push({
        session_id: sessionId,
        state: rec.state,
        browser_alive: rec.browser.isRunning(),
        authentication_status: rec.authStatus,
        current_url: rec.lastNavigationUrl,
        target_url: config ? config.target_url : null,
      });
    }
    return sessions;
  }

  async stopAll() {
    for (const sessionId of this.sessions.keys()) {
      try {
        await this.stopSession(sessionId);
      } catch (err) {
        this.logger.warn("stop_all_failed", { session: sessionId, error: err.message });
      }
    }
  }
}

module.exports = { SessionManager };
