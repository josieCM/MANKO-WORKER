"use strict";

const { app } = require("electron");
const path = require("path");
const { AppController } = require("./appController");

let appController = null;

async function initializeApp() {
  appController = new AppController();
  await appController.initialize();
  appController.createMainWindow();
}

app.whenReady().then(() => {
  initializeApp().catch((err) => {
    console.error("Failed to initialize application:", err);
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async () => {
  if (appController) {
    await appController.shutdown();
  }
});

app.on("quit", () => {
  console.log("Application quit");
});
