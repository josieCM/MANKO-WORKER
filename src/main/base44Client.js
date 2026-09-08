"use strict";

const crypto = require("crypto");
const { DEFAULT_CONFIG } = require("./configManager");

// Canonical signing rules (per base44/shared/WORKER_CONTRACT.md):
//   X-Worker-Signature: base64url(HMAC_SHA256(rawBody, WORKER_SHARED_SECRET))
// base64url without padding, over the exact raw bytes sent.

function signBody(secret, body) {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("base64url");
}

// Constant-time verification of an incoming signature.
function verifyBody(secret, body, signature) {
  if (!signature || typeof signature !== "string") return false;
  const expected = Buffer.from(signBody(secret, body), "utf8");
  let received;
  try {
    received = Buffer.from(signature, "utf8");
  } catch (_) {
    return false;
  }
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(received, expected);
}

class Base44Client {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.lastCommAt = null;
  }

  async post(functionName, payload, options) {
    const opts = options || {};
    const retries = opts.retries || this.cfg.apiRetryBackoffMs || DEFAULT_CONFIG.apiRetryBackoffMs;
    const body = JSON.stringify(payload);
    const signature = signBody(this.cfg.workerSharedSecret, body);
    const url = `${this.cfg.base44ApiBaseUrl}/functions/${functionName}`;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      try {
        const t0 = Date.now();
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-worker-signature": signature,
          },
          body,
        });
        this.lastCommAt = new Date().toISOString();

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          const err = new Error(
            `${functionName} responded ${res.status}: ${text.slice(0, 200)}`
          );
          err.status = res.status;
          throw err;
        }

        const json = await res.json().catch(() => ({}));
        this.logger.info("base44_request_ok", { fn: functionName, ms: Date.now() - t0 });
        return json;
      } catch (err) {
        lastErr = err;
        // 4xx responses are permanent contract failures - do not retry.
        if (err.status && err.status >= 400 && err.status < 500) break;
        if (attempt < retries.length) {
          this.logger.warn("base44_request_retry", {
            fn: functionName,
            attempt: attempt + 1,
            error: err.message,
          });
          await new Promise((r) => setTimeout(r, retries[attempt]));
        }
      }
    }
    throw lastErr;
  }

  sendHeartbeat(payload) {
    return this.post("ingestHeartbeat", payload);
  }

  sendEvent(payload) {
    return this.post("ingestEvent", payload);
  }

  sendCommandAck(payload) {
    return this.post("ingestCommandAck", payload, {
      retries: this.cfg.ackRetryBackoffMs || DEFAULT_CONFIG.ackRetryBackoffMs,
    });
  }
}

module.exports = { Base44Client, signBody, verifyBody };