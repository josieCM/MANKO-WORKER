"use strict";

class PairingManager {
  constructor(base44Client, logger) {
    this.base44Client = base44Client;
    this.logger = logger;
    this.pollingInterval = null;
    this.pollingDelayMs = 5000;
    this.maxPollingDurationMs = 5 * 60 * 1000; // 5 minutes
  }

  async startPolling(pairingCode, onCredentialsReceived, onError) {
    const startTime = Date.now();

    this.logger.info("pairing_poll_start", { code: pairingCode });

    this.pollingInterval = setInterval(async () => {
      const elapsed = Date.now() - startTime;

      if (elapsed > this.maxPollingDurationMs) {
        this.stopPolling();
        onError(new Error("Pairing timeout"));
        return;
      }

      try {
        const result = await this.pollPairing(pairingCode);
        if (result && result.worker_id) {
          this.stopPolling();
          this.logger.info("pairing_success", { worker_id: result.worker_id });
          onCredentialsReceived(result);
        }
      } catch (err) {
        this.logger.warn("pairing_poll_failed", { error: err.message });
        // Continue polling unless it's a permanent error
        if (err.status && err.status >= 400 && err.status < 500) {
          this.stopPolling();
          onError(err);
        }
      }
    }, this.pollingDelayMs);
  }

  stopPolling() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      this.logger.info("pairing_poll_stopped");
    }
  }

  async pollPairing(pairingCode) {
    // NOTE: The exact API contract for workerPairingPoll is not available in the current source.
    // This is an adapter that will need to be updated once the Base44 API contract is known.
    // Expected response structure (assumed):
    // {
    //   worker_id: "uuid",
    //   worker_shared_secret: "secret",
    //   base44_api_url: "https://...",
    //   worker_endpoint: "https://..." // optional
    // }

    const payload = {
      pairing_code: pairingCode,
    };

    // This will need to be updated to the actual Base44 function name
    // For now, we'll assume it's workerPairingPoll
    const response = await this.base44Client.post("workerPairingPoll", payload, {
      retries: [2000, 5000],
    });

    return response;
  }

  async requestPairing() {
    // NOTE: The exact API contract for requestWorkerPairing is not available in the current source.
    // This is an adapter that will need to be updated once the Base44 API contract is known.
    // Expected response structure (assumed):
    // {
    //   pairing_code: "123456",
    //   expires_at: "2026-09-04T10:05:00Z"
    // }

    const response = await this.base44Client.post("requestWorkerPairing", {}, {
      retries: [2000, 5000],
    });

    return response;
  }
}

module.exports = { PairingManager };
