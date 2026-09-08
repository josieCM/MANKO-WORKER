"use strict";

const path = require("path");
const { ConfigManager } = require("./configManager");
const { CredentialStore } = require("./credentialStore");
const { Logger } = require("./logger");
const { Base44Client } = require("./base44Client");
const { EventReporter } = require("./events");
const { SessionManager } = require("./sessionManager");
const { CommandHandler } = require("./commandHandler");
const { CommandReceiver } = require("./commandReceiver");
const { PairingManager } = require("./pairingManager");
const { TrayManager } = require("./trayManager");
const { registerIpcHandlers } = require("./ipcHandlers");

class AppController {
  constructor() {
    this.configManager = new ConfigManager();
    this.credentialStore = new CredentialStore();
    this.logger = null;
    this.base44Client = null;
    this.events = null;
    this.sessionManager = null;
    this.commandHandler = null;
    this.commandReceiver = null;
    this.pairingManager = null;
    this.trayManager = null;
    this.mainWindow = null;
    this.isPaired = false;
    this.workerStatus = "PAIRING";
  }

  async initialize() {
    // Initialize configuration
    const config = this.configManager.loadConfig();
    
    // Initialize logger
    this.logger = new Logger(this.configManager.getLogsPath());
    this.logger.info("app_initializing", { version: config.version });

    // Check pairing status
    this.isPaired = await this.credentialStore.hasCredentials();
    this.workerStatus = this.isPaired ? "ONLINE" : "PAIRING";

    if (this.isPaired) {
      await this.initializeOnlineWorker(config);
    } else {
      await this.initializePairingMode(config);
    }

    // Register IPC handlers
    registerIpcHandlers(this);

    // Initialize system tray
    this.trayManager = new TrayManager(this);
    this.trayManager.create();

    this.logger.info("app_initialized", { paired: this.isPaired, status: this.workerStatus });
  }

  async initializeOnlineWorker(config) {
    // Load credentials
    const credentials = await this.credentialStore.getCredentials(config.workerId);
    if (!credentials) {
      throw new Error("Credentials not found despite paired status");
    }

    // Update config with credential data
    config.workerSharedSecret = credentials.worker_shared_secret;
    config.base44ApiBaseUrl = credentials.base44_api_url;

    // Initialize Base44 client
    this.base44Client = new Base44Client(config, this.logger);

    // Initialize event reporter
    this.events = new EventReporter(config, this.base44Client, this.logger);

    // Initialize session manager
    this.sessionManager = new SessionManager(config, this.logger, this.base44Client, this.events, this.configManager);

    // Initialize command handler
    this.commandHandler = new CommandHandler(config, this.logger, this.base44Client, this.events, this.sessionManager);

    // Initialize command receiver
    this.commandReceiver = new CommandReceiver(config, this.logger, this.commandHandler);
    await this.commandReceiver.start();

    // Send worker online event
    await this.events.sessionEvent("worker", "WORKER_ONLINE", {
      message: "Worker online",
      metadata: { worker_id: config.worker_id },
    }).catch(() => {});

    this.logger.info("worker_online", { worker_id: config.worker_id });
  }

  async initializePairingMode(config) {
    // Initialize Base44 client with minimal config (no secret yet)
    // We'll need the base44ApiUrl from somewhere - for now use config if available
    if (config.base44ApiUrl) {
      this.base44Client = new Base44Client(config, this.logger);
    }

    // Initialize pairing manager
    this.pairingManager = new PairingManager(this.base44Client, this.logger);

    this.logger.info("pairing_mode_entered");
  }

  createMainWindow() {
    const { BrowserWindow } = require("electron");
    this.mainWindow = new BrowserWindow({
      width: 900,
      height: 700,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, "..", "renderer", "preload.js"),
      },
      icon: path.join(__dirname, "..", "..", "build", "icon.ico"),
    });

    // Load appropriate view based on pairing status
    if (this.isPaired) {
      this.mainWindow.loadFile(path.join(__dirname, "..", "renderer", "main.html"));
    } else {
      this.mainWindow.loadFile(path.join(__dirname, "..", "renderer", "pairing.html"));
    }

    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
    });

    // DevTools in development
    if (process.env.NODE_ENV === "development") {
      this.mainWindow.webContents.openDevTools();
    }
  }

  showPairingView() {
    if (this.mainWindow) {
      this.mainWindow.loadFile(path.join(__dirname, "..", "renderer", "pairing.html"));
    }
  }

  showMainView() {
    if (this.mainWindow) {
      this.mainWindow.loadFile(path.join(__dirname, "..", "renderer", "main.html"));
    }
  }

  async submitPairingCode(pairingCode) {
    if (!this.pairingManager) {
      throw new Error("Pairing manager not initialized");
    }

    return new Promise((resolve, reject) => {
      this.pairingManager.startPolling(
        pairingCode,
        async (credentials) => {
          // Store credentials
          await this.credentialStore.storeCredentials(
            credentials.worker_id,
            credentials.worker_shared_secret,
            credentials.base44_api_url
          );

          // Update config
          this.configManager.set("workerId", credentials.worker_id);
          this.configManager.set("base44ApiUrl", credentials.base44_api_url);
          this.configManager.set("pairedAt", new Date().toISOString());

          // Transition to online mode
          this.isPaired = true;
          this.workerStatus = "ONLINE";
          
          const config = this.configManager.loadConfig();
          await this.initializeOnlineWorker(config);
          
          this.showMainView();
          this.notifyRenderer("pairing:success", { worker_id: credentials.worker_id });
          
          resolve(credentials);
        },
        (error) => {
          this.notifyRenderer("pairing:error", { error: error.message });
          reject(error);
        }
      );
    });
  }

  async shutdown() {
    this.logger.info("app_shutdown_start");

    // Stop pairing if active
    if (this.pairingManager) {
      this.pairingManager.stopPolling();
    }

    // Stop command receiver
    if (this.commandReceiver) {
      await this.commandReceiver.stop();
    }

    // Stop all sessions
    if (this.sessionManager) {
      await this.sessionManager.stopAll();
    }

    // Send worker offline event
    if (this.events && this.isPaired) {
      await this.events.sessionEvent("worker", "WORKER_OFFLINE", {
        message: "Worker shutting down",
      }).catch(() => {});
    }

    this.logger.info("app_shutdown_complete");
  }

  // Getters for IPC handlers
  getConfig() {
    return this.configManager.config;
  }

  getWorkerStatus() {
    return {
      status: this.workerStatus,
      paired: this.isPaired,
      worker_id: this.configManager.get("workerId"),
    };
  }

  getSessions() {
    if (!this.sessionManager) return [];
    return this.sessionManager.listSessions();
  }

  async startSession(sessionId) {
    if (!this.sessionManager) throw new Error("Session manager not initialized");
    return this.sessionManager.startSession(sessionId, {});
  }

  async stopSession(sessionId) {
    if (!this.sessionManager) throw new Error("Session manager not initialized");
    return this.sessionManager.stopSession(sessionId);
  }

  async restartSession(sessionId) {
    if (!this.sessionManager) throw new Error("Session manager not initialized");
    return this.sessionManager.restartSession(sessionId, {});
  }

  updateConfig(updates) {
    this.configManager.updateConfig(updates);
  }

  async forgetCredentials() {
    const workerId = this.configManager.get("workerId");
    if (workerId) {
      await this.credentialStore.deleteCredentials(workerId);
    }
    this.configManager.updateConfig({
      workerId: null,
      base44ApiUrl: null,
      pairedAt: null,
    });
    this.isPaired = false;
    this.workerStatus = "PAIRING";
    this.showPairingView();
  }

  notifyRenderer(channel, data) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

module.exports = { AppController };
