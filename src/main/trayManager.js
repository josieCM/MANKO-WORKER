"use strict";

const { Tray, Menu, app } = require("electron");
const path = require("path");

class TrayManager {
  constructor(appController) {
    this.appController = appController;
    this.tray = null;
  }

  create() {
    // Create tray icon (placeholder - will need actual icon file)
    const iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");
    
    // Skip tray creation if icon file doesn't exist or is invalid
    try {
      const fs = require("fs");
      if (!fs.existsSync(iconPath) || fs.statSync(iconPath).size === 0) {
        console.log("Skipping tray icon - icon file missing or empty");
        return;
      }
    } catch (err) {
      console.log("Skipping tray icon - cannot check icon file");
      return;
    }
    
    try {
      this.tray = new Tray(iconPath);
      this.updateContextMenu();
      
      this.tray.on("click", () => {
        if (this.appController.mainWindow) {
          if (this.appController.mainWindow.isVisible()) {
            this.appController.mainWindow.hide();
          } else {
            this.appController.mainWindow.show();
          }
        }
      });
    } catch (err) {
      console.error("Failed to create tray icon:", err.message);
      // Continue without tray if icon is missing
    }
  }

  updateContextMenu() {
    if (!this.tray) return;

    const status = this.appController.getWorkerStatus();
    const statusText = status.status === "ONLINE" ? "Online" : "Offline";

    const contextMenu = Menu.buildFromTemplate([
      {
        label: `MANKO Worker - ${statusText}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open MANKO Worker",
        click: () => {
          if (this.appController.mainWindow) {
            this.appController.mainWindow.show();
          }
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  updateStatus(status) {
    this.updateContextMenu();
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { TrayManager };
