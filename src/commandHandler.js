"use strict";

const { verifyBody } = require("./base44Client");

// Command set defined by the control plane (dispatchCommand):
const ALLOWED_COMMANDS = ["start", "stop", "restart", "open_page", "health_check", "reconnect"];

class CommandHandler {
  constructor(cfg, logger, base44, events, sessionManager) {
    this.cfg = cfg;
    this.logger = logger;
    this.base44 = base44;
    this.events = events;
    this.sessionManager = sessionManager;
  }

  // Entry point for the local /command endpoint.
  // Returns { status, body } - the caller sends it as the HTTP response.
  async handle(rawBody, signature) {
    // 1. Verify HMAC first (constant-time). Nothing else runs without it.
    if (!verifyBody(this.cfg.workerSharedSecret, rawBody, signature)) {
      this.logger.warn("command_signature_invalid");
      return { status: 401, body: { error: "Invalid signature" } };
    }

    // 2. Parse and validate structure.
    let cmd;
    try {
      cmd = JSON.parse(rawBody);
    } catch (_) {
      return { status: 400, body: { error: "Malformed JSON body" } };
    }
    if (!cmd.command_id || !cmd.session_id || !cmd.command_type) {
      return { status: 400, body: { error: "command_id, session_id and command_type required" } };
    }
    if (!ALLOWED_COMMANDS.includes(cmd.command_type)) {
      return {
        status: 400,
        body: { error: "Unsupported command", command_type: cmd.command_type },
      };
    }

    // 3. Session ownership (POC: only configured session ids are owned).
    if (!this.sessionManager.ownsSession(cmd.session_id)) {
      this.logger.warn("command_rejected_unknown_session", {
        command_id: cmd.command_id,
        session: cmd.session_id,
      });
      return {
        status: 403,
        body: { error: "Session not owned by this worker", session_id: cmd.session_id },
      };
    }

    // 4. URL allowlist for start/open_page (contract §3.1 rule 3).
    if ((cmd.command_type === "start" || cmd.command_type === "open_page") && cmd.payload && cmd.payload.url) {
      if (!this.sessionManager.isUrlAllowed(cmd.session_id, cmd.payload.url)) {
        this.logger.warn("command_rejected_url", {
          command_id: cmd.command_id,
          session: cmd.session_id,
        });
        return {
          status: 403,
          body: { error: "URL outside the configured allowlist", url: cmd.payload.url },
        };
      }
    }

    // 5. Idempotency: a command_id executes at most once.
    if (this.sessionManager.hasExecuted(cmd.command_id)) {
      this.logger.info("command_duplicate_ignored", { command_id: cmd.command_id });
      // Re-ack in case the first ack never reached Base44.
      this._ackLater(cmd, { idempotent: true, note: "command already executed" });
      return {
        status: 200,
        body: { ok: true, ack: true, command_id: cmd.command_id, duplicate: true },
      };
    }
    this.sessionManager.markExecuted(cmd.command_id);

    this.logger.info("command_received", {
      command_id: cmd.command_id,
      command: cmd.command_type,
      session: cmd.session_id,
    });
    this.events
      .sessionEvent(cmd.session_id, "COMMAND_RECEIVED", {
        message: "Command " + cmd.command_type + " received",
        metadata: { command_id: cmd.command_id },
      })
      .catch(() => {});

    // 6. Accept the command. The HTTP response returns immediately so the
    // control plane can mark the command "dispatched"; execution + ACK then
    // run after ACK_DELAY_MS (avoids acking while the command is still
    // "pending" and being overwritten by the dispatch update).
    this._executeAndAck(cmd);
    return {
      status: 200,
      body: { ok: true, ack: true, command_id: cmd.command_id, accepted: true },
    };
  }

  _ackLater(cmd, result) {
    setTimeout(() => this._sendAck(cmd, result).catch((err) => {
      this.logger.error("ack_send_failed", {
        command_id: cmd.command_id,
        error: err.message,
      });
    }), this.cfg.ackDelayMs);
  }

  _executeAndAck(cmd) {
    setTimeout(async () => {
      let result;
      try {
        result = await this._execute(cmd);
        this.logger.info("command_completed", {
          command_id: cmd.command_id,
          command: cmd.command_type,
          session: cmd.session_id,
        });
        this.events
          .sessionEvent(cmd.session_id, "COMMAND_COMPLETED", {
            message: "Command " + cmd.command_type + " completed",
            metadata: { command_id: cmd.command_id, result: result },
          })
          .catch(() => {});
        await this._sendAck(cmd, result);
      } catch (err) {
        // Honest failure: no fabricated ACK. The control plane's ack endpoint
        // only supports success transitions; a failed execution is reported
        // via a COMMAND_FAILED event and the command stays in its current
        // (dispatched) state, visibly un-acked.
        this.logger.error("command_failed", {
          command_id: cmd.command_id,
          command: cmd.command_type,
          error: err.message,
        });
        this.events
          .sessionEvent(cmd.session_id, "COMMAND_FAILED", {
            severity: "error",
            message: "Command " + cmd.command_type + " failed: " + err.message,
            metadata: { command_id: cmd.command_id, code: err.code },
          })
          .catch(() => {});
      }
    }, this.cfg.ackDelayMs);
  }

  async _execute(cmd) {
    const payload = cmd.payload || {};
    switch (cmd.command_type) {
      case "start":
        return this.sessionManager.startSession(cmd.session_id, { url: payload.url });
      case "stop":
        return this.sessionManager.stopSession(cmd.session_id);
      case "restart":
        return this.sessionManager.restartSession(cmd.session_id, { url: payload.url });
      case "reconnect":
        return this.sessionManager.reconnectSession(cmd.session_id);
      case "open_page":
        return this.sessionManager.openPage(cmd.session_id, payload.url);
      case "health_check":
        return this.sessionManager.healthCheck(cmd.session_id);
      default:
        throw new Error("Unsupported command: " + cmd.command_type);
    }
  }

  async _sendAck(cmd, result) {
    const payload = {
      command_id: cmd.command_id,
      session_id: cmd.session_id,
      status: "ack",
      result: result || {},
    };
    const res = await this.base44.sendCommandAck(payload);
    this.logger.info("command_acked", {
      command_id: cmd.command_id,
      idempotent: !!res.idempotent,
    });
  }
}

module.exports = { CommandHandler };