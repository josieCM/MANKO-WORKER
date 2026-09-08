"use strict";

const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  console.log("Electron app ready");
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.loadURL("data:text/html,<h1>Test</h1>");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
