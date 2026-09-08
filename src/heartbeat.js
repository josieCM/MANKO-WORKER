"use strict";

// Heartbeat loop conforming to the ingestHeartbeat contract:
//   { session_id, worker_id, status, page_status, authentication_status,
//     current_url, latency_ms, metadata }
// POSTed every HEARTBEAT_INTERVAL_MS while the session is alive.
// Send failures are logged and retried next tick; they never crash the
// running browser session.

class Heartbeat {
  constructor(cfg, logger, base44, sessionManager, sessionId) {
    this.cfg = cfg;
    this.logger = logger;
    this.base44 = base44;
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
    this.timer = null;
    this.consecutiveFailures = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error("heartbeat_tick_error", { session: this.sessionId, error: err.message });
      });
    }, this.cfg.heartbeatIntervalMs);
    // Send one immediately so Base44 sees the session as soon as it starts.
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick() {
    const health = this.sessionManager.getSessionHealth(this.sessionId);
    if (!health) return;
    // Refresh observable state (page probe latency, auth transitions) first.
    const snap = await this.sessionManager.refreshSessionState(this.sessionId);
    if (snap) health.latencyMs = snap.latencyMs;
    await this.send(health.status, health);
  }

  // statusOverride lets stop/crash paths send one final heartbeat with an
  // explicit state ('stopped'/'crashed') before the loop ends.
  async send(statusOverride, healthOverride) {
    const health = healthOverride || this.sessionManager.getSessionHealth(this.sessionId);
    const payload = {
      session_id: this.sessionId,
      worker_id: this.cfg.workerId,
      status: statusOverride || health.status,
      page_status: health.pageStatus,
      authentication_status: health.authenticationStatus,
      current_url: health.currentUrl,
      latency_ms: health.latencyMs,
      metadata: {
        timestamp: new Date().toISOString(),
        worker_version: this.cfg.version,
        worker_uptime_sec: Math.round(process.uptime()),
        memory_rss_mb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        browser_alive: health.browserAlive,
        page_alive: health.pageAlive,
        page_title: health.pageTitle,
        last_navigation_at: health.lastNavigationAt,
      },
    };
    try {
      await this.base44.sendHeartbeat(payload);
      this.consecutiveFailures = 0;
      this.logger.info("heartbeat_sent", { session: this.sessionId, status: payload.status });
    } catch (err) {
      this.consecutiveFailures++;
      this.logger.warn("heartbeat_failed", {
        session: this.sessionId,
        consecutive: this.consecutiveFailures,
        error: err.message,
      });
      this.sessionManager.reportHeartbeatFailure(this.sessionId, this.consecutiveFailures);
    }
  }
}

module.exports = { Heartbeat };