"use strict";

const keytar = require("keytar");

// Centralized naming strategy for the OS credential vault. Every account entry
// for this worker lives under one service name; the account name is the
// worker id, so re-pairing the same worker overwrites rather than duplicates.
const SERVICE_NAME = "MANKO Worker";

function accountForWorker(workerId) {
  if (!workerId || typeof workerId !== "string") {
    throw new Error("workerId is required to address a credential record");
  }
  return workerId;
}

// Secrets must never reach logs or error messages: keytar/OS errors are
// reported by name only, with any known secret value scrubbed out.
function scrub(message, secrets) {
  let out = String(message || "");
  for (const secret of secrets || []) {
    if (secret && typeof secret === "string" && secret.length >= 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

class CredentialStore {
  constructor(logger) {
    this.serviceName = SERVICE_NAME;
    this.logger = logger || null;
    // null = not probed yet, true/false = result of the last backend call.
    this.backendAvailable = null;
    this.backendError = null;
  }

  _log(event, message) {
    if (this.logger && typeof this.logger.warn === "function") {
      this.logger.warn(event, { error: message });
    } else {
      console.error(`${event}: ${message}`);
    }
  }

  // Runs a keytar call, recording whether the OS credential backend answered.
  // On Linux without a secret service this marks the backend unavailable
  // instead of crashing the app.
  async _call(event, fn, secrets) {
    try {
      const result = await fn();
      this.backendAvailable = true;
      this.backendError = null;
      return { ok: true, result };
    } catch (err) {
      const message = scrub(err && err.message, secrets);
      this.backendAvailable = false;
      this.backendError = message;
      this._log(event, message);
      return { ok: false, error: message };
    }
  }

  isBackendAvailable() {
    return this.backendAvailable;
  }

  getBackendError() {
    return this.backendError;
  }

  // Probes the OS credential vault without changing anything.
  async checkBackend() {
    const call = await this._call("credential_backend_unavailable", () =>
      keytar.findCredentials(this.serviceName)
    );
    return { available: call.ok, error: call.ok ? null : call.error };
  }

  async hasCredentials() {
    const call = await this._call("credential_lookup_failed", () =>
      keytar.findCredentials(this.serviceName)
    );
    if (!call.ok) return false;
    return Array.isArray(call.result) && call.result.length > 0;
  }

  // The worker id the machine is currently paired as, independent of any
  // non-secret configuration file.
  async getPairedWorkerId() {
    const call = await this._call("credential_lookup_failed", () =>
      keytar.findCredentials(this.serviceName)
    );
    if (!call.ok || !Array.isArray(call.result) || call.result.length === 0) return null;
    return call.result[0].account;
  }

  async storeCredentials(workerId, workerSharedSecret, base44ApiUrl, opts) {
    const account = accountForWorker(workerId);
    if (!workerSharedSecret || typeof workerSharedSecret !== "string") {
      throw new Error("workerSharedSecret is required");
    }
    const options = opts || {};

    const credentialData = JSON.stringify({
      worker_shared_secret: workerSharedSecret,
      base44_api_url: base44ApiUrl || null,
      paired_at: options.pairedAt || new Date().toISOString(),
    });

    const call = await this._call(
      "credential_store_failed",
      () => keytar.setPassword(this.serviceName, account, credentialData),
      [workerSharedSecret, credentialData]
    );
    if (!call.ok) {
      const err = new Error("Failed to store worker credentials: " + call.error);
      err.code = "CREDENTIAL_BACKEND_UNAVAILABLE";
      throw err;
    }

    // Exactly one paired worker per machine: drop records left behind by a
    // previous pairing under a different worker id.
    await this._removeOtherAccounts(account);
    return true;
  }

  async _removeOtherAccounts(keepAccount) {
    const call = await this._call("credential_lookup_failed", () =>
      keytar.findCredentials(this.serviceName)
    );
    if (!call.ok || !Array.isArray(call.result)) return;
    for (const cred of call.result) {
      if (cred.account !== keepAccount) {
        await this._call("credential_delete_failed", () =>
          keytar.deletePassword(this.serviceName, cred.account)
        );
      }
    }
  }

  async getCredentials(workerId) {
    let account;
    try {
      account = accountForWorker(workerId);
    } catch (err) {
      this._log("credential_read_failed", err.message);
      return null;
    }

    const call = await this._call("credential_read_failed", () =>
      keytar.getPassword(this.serviceName, account)
    );
    if (!call.ok || !call.result) return null;

    let parsed;
    try {
      parsed = JSON.parse(call.result);
    } catch (_) {
      // Never echo the stored blob; it holds the shared secret.
      this._log("credential_read_failed", "stored credential record is not valid JSON");
      return null;
    }

    return {
      worker_id: account,
      worker_shared_secret: parsed.worker_shared_secret,
      base44_api_url: parsed.base44_api_url,
      paired_at: parsed.paired_at,
    };
  }

  async deleteCredentials(workerId) {
    let account;
    try {
      account = accountForWorker(workerId);
    } catch (err) {
      this._log("credential_delete_failed", err.message);
      return false;
    }
    const call = await this._call("credential_delete_failed", () =>
      keytar.deletePassword(this.serviceName, account)
    );
    return call.ok && call.result !== false;
  }

  async clearAllCredentials() {
    const call = await this._call("credential_lookup_failed", () =>
      keytar.findCredentials(this.serviceName)
    );
    if (!call.ok || !Array.isArray(call.result)) return false;
    let allDeleted = true;
    for (const cred of call.result) {
      const del = await this._call("credential_delete_failed", () =>
        keytar.deletePassword(this.serviceName, cred.account)
      );
      if (!del.ok) allDeleted = false;
    }
    return allDeleted;
  }
}

module.exports = { CredentialStore, SERVICE_NAME, accountForWorker };
