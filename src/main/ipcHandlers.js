"use strict";

function registerIpcHandlers(appController) {
  const { ipcMain } = require("electron");

  // Worker status
  ipcMain.handle("worker:getStatus", () => {
    return appController.getWorkerStatus();
  });

  // Sessions
  ipcMain.handle("worker:getSessions", () => {
    return appController.getSessions();
  });

  ipcMain.handle("session:start", async (event, sessionId) => {
    try {
      return await appController.startSession(sessionId);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("session:stop", async (event, sessionId) => {
    try {
      return await appController.stopSession(sessionId);
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle("session:restart", async (event, sessionId) => {
    try {
      return await appController.restartSession(sessionId);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Configuration
  ipcMain.handle("config:get", () => {
    return appController.getConfig();
  });

  ipcMain.handle("config:update", async (event, updates) => {
    try {
      appController.updateConfig(updates);
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  // Pairing
  ipcMain.handle("pairing:submitCode", async (event, pairingCode) => {
    try {
      return await appController.submitPairingCode(pairingCode);
    } catch (err) {
      return { error: err.message };
    }
  });

  // Credentials
  ipcMain.handle("credentials:forget", async () => {
    try {
      await appController.forgetCredentials();
      return { success: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  // App control
  ipcMain.handle("app:quit", () => {
    const { app } = require("electron");
    app.quit();
  });
}

module.exports = { registerIpcHandlers };
