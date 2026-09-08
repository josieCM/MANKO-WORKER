"use strict";

document.addEventListener("DOMContentLoaded", async () => {
  const workerStatus = document.getElementById("workerStatus");
  const sessionsList = document.getElementById("sessionsList");
  const refreshButton = document.getElementById("refreshButton");
  const workerIdSpan = document.getElementById("workerId");
  const saveSettingsButton = document.getElementById("saveSettings");
  const forgetCredentialsButton = document.getElementById("forgetCredentials");
  const quitButton = document.getElementById("quitButton");

  // Settings inputs
  const autoStartCheckbox = document.getElementById("autoStart");
  const minimizeToTrayCheckbox = document.getElementById("minimizeToTray");
  const logLevelSelect = document.getElementById("logLevel");
  const maxSessionsInput = document.getElementById("maxSessions");

  // Load initial data
  await loadWorkerStatus();
  await loadConfig();
  await loadSessions();

  // Event listeners
  refreshButton.addEventListener("click", loadSessions);
  saveSettingsButton.addEventListener("click", saveSettings);
  forgetCredentialsButton.addEventListener("click", forgetCredentials);
  quitButton.addEventListener("click", () => window.workerAPI.quit());

  // Listen for status changes
  window.workerAPI.onStatusChanged((event, data) => {
    updateWorkerStatus(data);
  });

  window.workerAPI.onSessionAdded((event, data) => {
    loadSessions();
  });

  window.workerAPI.onSessionRemoved((event, data) => {
    loadSessions();
  });

  window.workerAPI.onSessionStateChanged((event, data) => {
    loadSessions();
  });

  async function loadWorkerStatus() {
    try {
      const status = await window.workerAPI.getStatus();
      updateWorkerStatus(status);
      workerIdSpan.textContent = status.worker_id || "-";
    } catch (err) {
      console.error("Failed to load worker status:", err);
    }
  }

  function updateWorkerStatus(status) {
    const statusText = workerStatus.querySelector(".status-text");
    const statusDot = workerStatus.querySelector(".status-dot");
    
    statusText.textContent = status.status || "Unknown";
    
    if (status.status === "ONLINE") {
      statusDot.className = "status-dot online";
    } else if (status.status === "PAIRING") {
      statusDot.className = "status-dot pairing";
    } else {
      statusDot.className = "status-dot offline";
    }
  }

  async function loadConfig() {
    try {
      const config = await window.workerAPI.getConfig();
      autoStartCheckbox.checked = config.autoStart || false;
      minimizeToTrayCheckbox.checked = config.minimizeToTray || true;
      logLevelSelect.value = config.logLevel || "info";
      maxSessionsInput.value = config.maxSessions || 5;
    } catch (err) {
      console.error("Failed to load config:", err);
    }
  }

  async function saveSettings() {
    try {
      const updates = {
        autoStart: autoStartCheckbox.checked,
        minimizeToTray: minimizeToTrayCheckbox.checked,
        logLevel: logLevelSelect.value,
        maxSessions: parseInt(maxSessionsInput.value, 10),
      };
      await window.workerAPI.updateConfig(updates);
      alert("Settings saved successfully");
    } catch (err) {
      alert("Failed to save settings: " + (err.error || err.message));
    }
  }

  async function loadSessions() {
    try {
      const sessions = await window.workerAPI.getSessions();
      renderSessions(sessions);
    } catch (err) {
      console.error("Failed to load sessions:", err);
      sessionsList.innerHTML = `
        <div class="empty-state">
          <p>Failed to load sessions</p>
          <p class="subtext">${err.error || err.message}</p>
        </div>
      `;
    }
  }

  function renderSessions(sessions) {
    if (!sessions || sessions.length === 0) {
      sessionsList.innerHTML = `
        <div class="empty-state">
          <p>No sessions assigned</p>
          <p class="subtext">Sessions will be assigned by the MANKO control plane</p>
        </div>
      `;
      return;
    }

    sessionsList.innerHTML = sessions.map(session => `
      <div class="session-item" data-session-id="${session.session_id}">
        <div class="session-header">
          <span class="session-id">${session.session_id.substring(0, 8)}...</span>
          <span class="session-status ${session.state.toLowerCase()}">${session.state}</span>
        </div>
        <div class="session-details">
          <div class="session-detail">
            <span class="label">Browser:</span>
            <span class="value">${session.browser_alive ? "Running" : "Stopped"}</span>
          </div>
          <div class="session-detail">
            <span class="label">Auth:</span>
            <span class="value">${session.authentication_status || "Unknown"}</span>
          </div>
          <div class="session-detail">
            <span class="label">URL:</span>
            <span class="value url">${session.current_url || session.target_url || "N/A"}</span>
          </div>
        </div>
        <div class="session-actions">
          ${session.state === "stopped" || session.state === "error" ? 
            `<button class="btn btn-small btn-primary" onclick="startSession('${session.session_id}')">Start</button>` : ""}
          ${session.browser_alive ? 
            `<button class="btn btn-small btn-secondary" onclick="stopSession('${session.session_id}')">Stop</button>` : ""}
          ${session.browser_alive ? 
            `<button class="btn btn-small btn-secondary" onclick="restartSession('${session.session_id}')">Restart</button>` : ""}
        </div>
      </div>
    `).join("");
  }

  // Expose session control functions globally
  window.startSession = async function(sessionId) {
    try {
      await window.workerAPI.startSession(sessionId);
      loadSessions();
    } catch (err) {
      alert("Failed to start session: " + (err.error || err.message));
    }
  };

  window.stopSession = async function(sessionId) {
    try {
      await window.workerAPI.stopSession(sessionId);
      loadSessions();
    } catch (err) {
      alert("Failed to stop session: " + (err.error || err.message));
    }
  };

  window.restartSession = async function(sessionId) {
    try {
      await window.workerAPI.restartSession(sessionId);
      loadSessions();
    } catch (err) {
      alert("Failed to restart session: " + (err.error || err.message));
    }
  };

  async function forgetCredentials() {
    if (!confirm("Are you sure you want to forget credentials? This will disconnect the worker from MANKO.")) {
      return;
    }
    try {
      await window.workerAPI.forgetCredentials();
      alert("Credentials forgotten. The application will now show the pairing screen.");
      // Page will be reloaded by main process
    } catch (err) {
      alert("Failed to forget credentials: " + (err.error || err.message));
    }
  }
});
