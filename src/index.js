"use strict";

const { loadConfig } = require("./config");
const { Logger } = require("./logger");
const { Base44Client } = require("./base44Client");
const { EventReporter } = require("./events");
const { SessionManager } = require("./sessionManager");
const { CommandHandler } = require("./commandHandler");
const { Worker } = require("./worker");

async function main() {
  const cfg = loadConfig();
  const logger = new Logger(cfg.logDir);

  // Startup banner
  console.log("Worker starting");
  console.log(`Worker ID: ${cfg.workerId}`);
  console.log(`Platform: ${cfg.platform}`);
  console.log("Browser engine: Chromium");
  console.log("Status: starting");
  logger.info("worker_started", {
    worker: cfg.workerId,
    version: cfg.version,
    platform: cfg.platform,
    base44: cfg.base44ApiBaseUrl,
    sessions: cfg.sessions.map((s) => s.sessionId).join(","),
  });

  const base44 = new Base44Client(cfg, logger);
  const events = new EventReporter(cfg, base44, logger);
  const sessionManager = new SessionManager(cfg, logger, base44, events);
  const commandHandler = new CommandHandler(cfg, logger, base44, events, sessionManager);
  const worker = new Worker(cfg, logger, commandHandler, sessionManager, base44);

  worker.start();

  const shutdown = (signal) => {
    worker.shutdown(signal).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", { error: reason && reason.message ? reason.message : String(reason) });
  });
}

main().catch((err) => {
  console.error("Worker failed to start:", err.message);
  process.exit(1);
});