"use strict";

const keytar = require("keytar");

const SERVICE_NAME = "MANKO Worker";

class CredentialStore {
  constructor() {
    this.serviceName = SERVICE_NAME;
  }

  async hasCredentials() {
    try {
      const credentials = await keytar.findCredentials(this.serviceName);
      return credentials && credentials.length > 0;
    } catch (err) {
      console.error("Failed to check for credentials:", err.message);
      return false;
    }
  }

  async storeCredentials(workerId, workerSharedSecret, base44ApiUrl) {
    try {
      const credentialData = JSON.stringify({
        worker_shared_secret: workerSharedSecret,
        base44_api_url: base44ApiUrl,
        paired_at: new Date().toISOString(),
      });

      await keytar.setPassword(this.serviceName, workerId, credentialData);
      return true;
    } catch (err) {
      console.error("Failed to store credentials:", err.message);
      throw err;
    }
  }

  async getCredentials(workerId) {
    try {
      const credentialData = await keytar.getPassword(this.serviceName, workerId);
      if (!credentialData) {
        return null;
      }

      const parsed = JSON.parse(credentialData);
      return {
        worker_id: workerId,
        worker_shared_secret: parsed.worker_shared_secret,
        base44_api_url: parsed.base44_api_url,
        paired_at: parsed.paired_at,
      };
    } catch (err) {
      console.error("Failed to get credentials:", err.message);
      return null;
    }
  }

  async deleteCredentials(workerId) {
    try {
      await keytar.deletePassword(this.serviceName, workerId);
      return true;
    } catch (err) {
      console.error("Failed to delete credentials:", err.message);
      return false;
    }
  }

  async clearAllCredentials() {
    try {
      const credentials = await keytar.findCredentials(this.serviceName);
      for (const cred of credentials) {
        await keytar.deletePassword(this.serviceName, cred.account);
      }
      return true;
    } catch (err) {
      console.error("Failed to clear all credentials:", err.message);
      return false;
    }
  }
}

module.exports = { CredentialStore };
