"use strict";

const http = require("http");

class CommandReceiver {
  constructor(cfg, logger, commandHandler) {
    this.cfg = cfg;
    this.logger = logger;
    this.commandHandler = commandHandler;
    this.server = null;
    this.started = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this._route(req, res).catch((err) => {
          this.logger.error("http_server_error", { error: err.message });
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
          }
          res.end(JSON.stringify({ error: "Internal worker error" }));
        });
      });

      this.server.listen(this.cfg.commandEndpointPort, this.cfg.commandEndpointHost, () => {
        this.started = true;
        this.logger.info("command_receiver_listening", {
          host: this.cfg.commandEndpointHost,
          port: this.cfg.commandEndpointPort,
        });
        console.log(`Command endpoint: http://${this.cfg.commandEndpointHost}:${this.cfg.commandEndpointPort}/command`);
        resolve();
      });

      this.server.on("error", (err) => {
        this.logger.error("command_receiver_error", { error: err.message });
        reject(err);
      });
    });
  }

  async _route(req, res) {
    const url = (req.url || "/").split("?")[0];

    if (req.method === "POST" && url === "/command") {
      return this._handleCommand(req, res);
    }

    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: new Date().toISOString() }));
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

  async stop() {
    if (!this.started) return;
    
    return new Promise((resolve) => {
      this.server.close(() => {
        this.started = false;
        this.logger.info("command_receiver_stopped");
        resolve();
      });
    });
  }

  isRunning() {
    return this.started;
  }
}

module.exports = { CommandReceiver };
