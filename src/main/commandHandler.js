"use strict";

const { verifyBody } = require("./base44Client");
const { CommandRegistry } = require("./commandRegistry");

class CommandHandler {
  constructor(cfg, logger, base44, events, sessionManager) {
    this.cfg = cfg;
    this.logger = logger;
    this.base44 = base44;
    this.events = events;
    this.sessionManager = sessionManager;
    this.registry = new CommandRegistry();
    this._registerCommands();
  }

  _registerCommands() {
    // Register existing commands
    this.registry.register("start", this._handleStart.bind(this), this._validateStart, {});
    this.registry.register("stop", this._handleStop.bind(this), this._validateStop, {});
    this.registry.register("restart", this._handleRestart.bind(this), this._validateRestart, {});
    this.registry.register("reconnect", this._handleReconnect.bind(this), this._validateReconnect, {});
    this.registry.register("open_page", this._handleOpenPage.bind(this), this._validateOpenPage, {});
    this.registry.register("health_check", this._handleHealthCheck.bind(this), this._validateHealthCheck, {});
  }

  // Validators
  _validateStart(payload) {
    if (!payload) return { valid: true, errors: [] };
    if (payload.url && typeof payload.url !== "string") {
      return { valid: false, errors: ["url must be a string"] };
    }
    return { valid: true, errors: [] };
  }

  _validateStop(payload) {
    return { valid: true, errors: [] };
  }

  _validateRestart(payload) {
    return this._validateStart(payload);
  }

  _validateReconnect(payload) {
    return { valid: true, errors: [] };
  }

  _validateOpenPage(payload) {
    if (!payload || !payload.url) {
      return { valid: false, errors: ["url is required"] };
    }
    if (typeof payload.url !== "string") {
      return { valid: false, errors: ["url must be a string"] };
    }
    return { valid: true, errors: [] };
  }

  _validateHealthCheck(payload) {
    return { valid: true, errors: [] };
  }

  // Command handlers
  async _handleStart(sessionId, payload) {
    return this.sessionManager.startSession(sessionId, { url: payload.url });
  }

  async _handleStop(sessionId, payload) {
    return this.sessionManager.stopSession(sessionId);
  }

  async _handleRestart(sessionId, payload) {
    return this.sessionManager.restartSession(sessionId, { url: payload.url });
  }

  async _handleReconnect(sessionId, payload) {
    return this.sessionManager.reconnectSession(sessionId);
  }

  async _handleOpenPage(sessionId, payload) {
    return this.sessionManager.openPage(sessionId, payload.url);
  }

  async _handleHealthCheck(sessionId, payload) {
    return this.sessionManager.healthCheck(sessionId);
  }

  // Entry point for the local /command endpoint
  async handle(rawBody, signature) {
    // 1. Verify HMAC first
    if (!verifyBody(this.cfg.workerSharedSecret, rawBody, signature)) {
      this.logger.warn("command_signature_invalid");
      return { status: 401, body: { error: "Invalid signature" } };
    }

    // 2. Parse and validate structure
    let cmd;
    try {
      cmd = JSON.parse(rawBody);
    } catch (_) {
      return { status: 400, body: { error: "Malformed JSON body" } };
    }
    if (!cmd.command_id || !cmd.session_id || !cmd.command_type) {
      return { status: 400, body: { error: "command_id, session_id and command_type required" } };
    }

    // 3. Check command type
    if (!this.registry.has(cmd.command_type)) {
      return {
        status: 400,
        body: { error: "Unsupported command", command_type: cmd.command_type },
      };
    }

    // 4. Session ownership
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

    // 5. URL allowlist for start/open_page
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

    // 6. Idempotency
    if (this.sessionManager.hasExecuted(cmd.command_id)) {
      this.logger.info("command_duplicate_ignored", { command_id: cmd.command_id });
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

    // 7. Accept and execute
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
        const registration = this.registry.get(cmd.command_type);
        const validation = registration.validator(cmd.payload || {});
        if (!validation.valid) {
          throw new Error("Invalid payload: " + validation.errors.join(", "));
        }

        result = await registration.handler(cmd.session_id, cmd.payload || {});
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
