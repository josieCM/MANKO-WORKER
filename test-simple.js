const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  console.log("App ready!");
  const win = new BrowserWindow({ width: 800, height: 600 });
  win.loadURL("data:text/html,<h1>Test</h1>");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
