"use strict";

// Session-scoped event reporting via the existing ingestEvent contract.
// Payload schema (unchanged from the contract):
//   { session_id, account_id?, event_type, severity, message, metadata }
//
// NOTE: ingestEvent requires a session_id, so worker-level events with no
// session context (e.g. WORKER_STARTED) are logged locally only. Free-form
// event types beyond the contract's status-mapping table are still stored by
// the control plane; they just do not drive status transitions.

class EventReporter {
  constructor(cfg, base44, logger) {
    this.cfg = cfg;
    this.base44 = base44;
    this.logger = logger;
  }

  async sessionEvent(sessionId, eventType, opts) {
    const o = opts || {};
    this.logger.info("event", {
      session: sessionId,
      type: eventType,
      severity: o.severity || "info",
    });
    try {
      await this.base44.sendEvent({
        session_id: sessionId,
        account_id: o.accountId,
        event_type: eventType,
        severity: o.severity || "info",
        message: o.message || "",
        metadata: o.metadata || {},
      });
    } catch (err) {
      // An unreachable control plane must not disturb running sessions.
      this.logger.warn("event_send_failed", { type: eventType, error: err.message });
    }
  }
}

module.exports = { EventReporter };