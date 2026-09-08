"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("pairingForm");
  const pairingCodeInput = document.getElementById("pairingCode");
  const pairButton = document.getElementById("pairButton");
  const messageDiv = document.getElementById("pairingMessage");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const code = pairingCodeInput.value.trim();
    if (!code || code.length !== 6) {
      showMessage("Please enter a valid 6-digit pairing code", "error");
      return;
    }

    pairButton.disabled = true;
    pairButton.textContent = "Pairing...";
    showMessage("Waiting for MANKO control plane...", "info");

    try {
      await window.workerAPI.submitPairingCode(code);
      showMessage("Pairing successful! Redirecting...", "success");
      // Will be redirected by main process
    } catch (err) {
      showMessage(err.error || "Pairing failed. Please try again.", "error");
      pairButton.disabled = false;
      pairButton.textContent = "Pair Worker";
    }
  });

  // Listen for pairing success/error events
  window.workerAPI.onPairingSuccess((event, data) => {
    showMessage("Pairing successful! Worker is now online.", "success");
    setTimeout(() => {
      // Page will be reloaded by main process
    }, 2000);
  });

  window.workerAPI.onPairingError((event, data) => {
    showMessage(data.error || "Pairing failed", "error");
    pairButton.disabled = false;
    pairButton.textContent = "Pair Worker";
  });

  function showMessage(text, type) {
    messageDiv.textContent = text;
    messageDiv.className = "message " + type;
    messageDiv.style.display = "block";
  }
});
