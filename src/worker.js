"use strict";

const http = require("http");
const os = require("os");

// Worker identity, local HTTP command server, health endpoint, graceful shutdown.

class Worker {
  constructor(cfg, logger, commandHandler, sessionManager, base44) {
    this.cfg = cfg;
    this.logger = logger;
    this.commandHandler = commandHandler;
    this.sessionManager = sessionManager;
    this.base44 = base44;
    this.server = null;
    this.startedAt = new Date();
    this.status = "starting";
  }

  start() {
    this.server = http.createServer((req, res) => {
      this._route(req, res).catch((err) => {
        this.logger.error("http_server_error", { error: err.message });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "Internal worker error" }));
      });
    });

    this.server.listen(this.cfg.port, this.cfg.host, () => {
      this.status = "online";
      this.logger.info("worker_listening", {
        host: this.cfg.host,
        port: this.cfg.port,
      });
      console.log(`Command endpoint:  http://${this.cfg.host}:${this.cfg.port}/command`);
      console.log("Status: online (command endpoint listening)");
      console.log(
        `Base44 control plane: ${this.cfg.base44ApiBaseUrl} (worker_id=${this.cfg.workerId})`
      );
      if (!this.cfg.workerEndpoint) {
        this.logger.warn(
          "worker_endpoint_not_configured",
          { note: "BASE44_WORKER_ENDPOINT is not set; the control plane cannot dispatch commands to this worker until it is registered with a reachable endpoint URL" }
        );
      }
    });
  }

  async _route(req, res) {
    const url = (req.url || "/").split("?")[0];

    if (req.method === "POST" && url === "/command") {
      return this._handleCommand(req, res);
    }

    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(this.health()));
      return;
    }

    if (url === "/vnc.html") {
      // Honest 501: the remote viewer is deliberately NOT implemented in
      // this POC. No fake viewer URLs are served.
      res.writeHead(501, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Remote viewer not implemented in this POC worker",
        })
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  async _handleCommand(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const signature = req.headers["x-worker-signature"] || "";

    const { status, body } = await this.commandHandler.handle(rawBody, signature);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  health() {
    const sessions = [];
    for (const rec of this.sessionManager.sessions.values()) {
      sessions.push({
        session_id: rec.sessionId,
        state: rec.state,
        browser_alive: rec.browser.isRunning(),
        authentication_status: rec.authStatus,
      });
    }
    const mem = process.memoryUsage();
    return {
      worker_id: this.cfg.workerId,
      version: this.cfg.version,
      status: this.status,
      uptime_sec: Math.round(process.uptime()),
      started_at: this.startedAt.toISOString(),
      platform: this.cfg.platform,
      os_type: os.type(),
      cpu_count: os.cpus().length,
      memory_rss_mb: Math.round(mem.rss / (1024 * 1024)),
      active_sessions: this.sessionManager.activeSessionCount(),
      sessions,
      browser_engine: "chromium",
      headless: this.cfg.headless,
      last_base44_comm: this.base44.lastCommAt,
      viewer_implemented: false,
    };
  }

  async shutdown(signal) {
    this.status = "stopping";
    this.logger.info("worker_stopping", { signal });
    console.log("Status: stopping - closing sessions and command endpoint");
    try {
      await this.sessionManager.stopAll();
    } catch (err) {
      this.logger.warn("shutdown_stop_all_failed", { error: err.message });
    }
    if (this.server) {
      this.server.close();
    }
    this.status = "offline";
    this.logger.info("worker_stopped");
    console.log("Status: offline - worker stopped");
  }
}

module.exports = { Worker };