"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workerAPI", {
  // Worker status
  getStatus: () => ipcRenderer.invoke("worker:getStatus"),
  getSessions: () => ipcRenderer.invoke("worker:getSessions"),
  
  // Session control
  startSession: (sessionId) => ipcRenderer.invoke("session:start", sessionId),
  stopSession: (sessionId) => ipcRenderer.invoke("session:stop", sessionId),
  restartSession: (sessionId) => ipcRenderer.invoke("session:restart", sessionId),
  
  // Configuration
  getConfig: () => ipcRenderer.invoke("config:get"),
  updateConfig: (updates) => ipcRenderer.invoke("config:update", updates),
  
  // Pairing
  submitPairingCode: (code) => ipcRenderer.invoke("pairing:submitCode", code),
  
  // Credentials
  forgetCredentials: () => ipcRenderer.invoke("credentials:forget"),
  
  // App control
  quit: () => ipcRenderer.invoke("app:quit"),
  
  // Event listeners
  onStatusChanged: (callback) => ipcRenderer.on("worker:statusChanged", callback),
  onSessionAdded: (callback) => ipcRenderer.on("session:added", callback),
  onSessionRemoved: (callback) => ipcRenderer.on("session:removed", callback),
  onSessionStateChanged: (callback) => ipcRenderer.on("session:stateChanged", callback),
  onPairingSuccess: (callback) => ipcRenderer.on("pairing:success", callback),
  onPairingError: (callback) => ipcRenderer.on("pairing:error", callback),
  
  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
});
