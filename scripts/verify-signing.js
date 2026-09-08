"use strict";

// Self-test for the HMAC signing rules, run with:  npm run verify
// 1. Round-trip: signBody -> verifyBody (constant-time compare).
// 2. Tampered body / bad signature must fail.
// 3. The Node crypto signature must be byte-identical to the WebCrypto
//    implementation used by the Base44 control plane (base44/shared/workerAuth.ts),
//    proving the worker's X-Worker-Signature will verify server-side.

const crypto = require("crypto");
const assert = require("assert");
const { signBody, verifyBody } = require("../src/base44Client");

async function main() {
  const secret = "poc-self-test-secret";
  const body = JSON.stringify({ session_id: "6a97b86f", worker_id: "worker-01", status: "active" });

  // 1. Round trip
  const sig = signBody(secret, body);
  assert.ok(!sig.includes("="), "signature must be base64url without padding");
  assert.ok(!sig.includes("+") && !sig.includes("/"), "signature must be base64url alphabet");
  assert.strictEqual(verifyBody(secret, body, sig), true, "valid signature must verify");

  // 2. Tampering must fail
  assert.strictEqual(verifyBody(secret, body + " ", sig), false, "tampered body must fail");
  assert.strictEqual(verifyBody(secret, body, sig.slice(0, -2) + "AA"), false, "bad signature must fail");
  assert.strictEqual(verifyBody(secret, body, ""), false, "empty signature must fail");
  assert.strictEqual(verifyBody("other-secret", body, sig), false, "wrong secret must fail");

  // 3. Equivalence with the control plane's WebCrypto implementation
  const enc = new TextEncoder();
  const key = await crypto.webcrypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const raw = await crypto.webcrypto.subtle.sign("HMAC", key, enc.encode(body));
  let bin = "";
  const bytes = new Uint8Array(raw);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const serverStyleSig = Buffer.from(bin, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.strictEqual(sig, serverStyleSig, "Node crypto and WebCrypto signatures must be identical");

  console.log("OK: signing rules verified (round-trip, tamper rejection, WebCrypto equivalence)");
}

main().catch((err) => {
  console.error("VERIFY FAILED:", err.message);
  process.exit(1);
});