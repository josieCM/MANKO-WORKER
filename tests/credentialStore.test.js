"use strict";

// keytar talks to the Windows Credential Manager in production. It is mocked
// here so the Phase 2 behavior can be tested on any platform.
jest.mock("keytar", () => ({
  findCredentials: jest.fn(),
  getPassword: jest.fn(),
  setPassword: jest.fn(),
  deletePassword: jest.fn(),
}));

const keytar = require("keytar");
const { CredentialStore, SERVICE_NAME, accountForWorker } = require("../src/main/credentialStore");

const WORKER_ID = "worker-01";
const SECRET = "s3cr3t-shared-value";
const API_URL = "https://session-sphere-flow.base44.app";

function record(overrides) {
  return JSON.stringify({
    worker_shared_secret: SECRET,
    base44_api_url: API_URL,
    paired_at: "2026-09-08T00:00:00.000Z",
    ...overrides,
  });
}

let store;
let logger;

beforeEach(() => {
  jest.clearAllMocks();
  logger = { warn: jest.fn() };
  store = new CredentialStore(logger);
  keytar.findCredentials.mockResolvedValue([]);
  keytar.getPassword.mockResolvedValue(null);
  keytar.setPassword.mockResolvedValue(undefined);
  keytar.deletePassword.mockResolvedValue(true);
});

describe("naming strategy", () => {
  test("uses one centralized service name", () => {
    expect(SERVICE_NAME).toBe("MANKO Worker");
    expect(store.serviceName).toBe(SERVICE_NAME);
  });

  test("account name is the worker id and requires one", () => {
    expect(accountForWorker(WORKER_ID)).toBe(WORKER_ID);
    expect(() => accountForWorker("")).toThrow(/workerId is required/);
    expect(() => accountForWorker(null)).toThrow(/workerId is required/);
  });
});

describe("save", () => {
  test("stores the pairing fields as a single record under the worker account", async () => {
    keytar.findCredentials.mockResolvedValue([{ account: WORKER_ID, password: record() }]);

    await expect(
      store.storeCredentials(WORKER_ID, SECRET, API_URL, { pairedAt: "2026-09-08T00:00:00.000Z" })
    ).resolves.toBe(true);

    expect(keytar.setPassword).toHaveBeenCalledTimes(1);
    const [service, account, blob] = keytar.setPassword.mock.calls[0];
    expect(service).toBe(SERVICE_NAME);
    expect(account).toBe(WORKER_ID);
    expect(JSON.parse(blob)).toEqual({
      worker_shared_secret: SECRET,
      base44_api_url: API_URL,
      paired_at: "2026-09-08T00:00:00.000Z",
    });
  });

  test("rejects a save without a worker id or secret", async () => {
    await expect(store.storeCredentials(null, SECRET, API_URL)).rejects.toThrow(/workerId is required/);
    await expect(store.storeCredentials(WORKER_ID, "", API_URL)).rejects.toThrow(
      /workerSharedSecret is required/
    );
    expect(keytar.setPassword).not.toHaveBeenCalled();
  });
});

describe("get", () => {
  test("returns the stored pairing fields", async () => {
    keytar.getPassword.mockResolvedValue(record());

    await expect(store.getCredentials(WORKER_ID)).resolves.toEqual({
      worker_id: WORKER_ID,
      worker_shared_secret: SECRET,
      base44_api_url: API_URL,
      paired_at: "2026-09-08T00:00:00.000Z",
    });
    expect(keytar.getPassword).toHaveBeenCalledWith(SERVICE_NAME, WORKER_ID);
  });

  test("returns null for a missing record, a missing worker id, and a corrupt record", async () => {
    await expect(store.getCredentials(WORKER_ID)).resolves.toBeNull();
    await expect(store.getCredentials(null)).resolves.toBeNull();

    keytar.getPassword.mockResolvedValue("not json");
    await expect(store.getCredentials(WORKER_ID)).resolves.toBeNull();
  });
});

describe("exists / isPaired", () => {
  test("reports paired only when a record exists", async () => {
    await expect(store.hasCredentials()).resolves.toBe(false);
    await expect(store.getPairedWorkerId()).resolves.toBeNull();

    keytar.findCredentials.mockResolvedValue([{ account: WORKER_ID, password: record() }]);
    await expect(store.hasCredentials()).resolves.toBe(true);
    await expect(store.getPairedWorkerId()).resolves.toBe(WORKER_ID);
  });
});

describe("clear", () => {
  test("deletes the record for a worker", async () => {
    await expect(store.deleteCredentials(WORKER_ID)).resolves.toBe(true);
    expect(keytar.deletePassword).toHaveBeenCalledWith(SERVICE_NAME, WORKER_ID);
  });

  test("delete of a non-existent record is safe", async () => {
    keytar.deletePassword.mockResolvedValue(false);
    await expect(store.deleteCredentials(WORKER_ID)).resolves.toBe(false);
  });

  test("clearAllCredentials removes every account under the service", async () => {
    keytar.findCredentials.mockResolvedValue([
      { account: WORKER_ID, password: record() },
      { account: "worker-02", password: record() },
    ]);

    await expect(store.clearAllCredentials()).resolves.toBe(true);
    expect(keytar.deletePassword).toHaveBeenCalledWith(SERVICE_NAME, WORKER_ID);
    expect(keytar.deletePassword).toHaveBeenCalledWith(SERVICE_NAME, "worker-02");
  });
});

describe("repeated save / update", () => {
  test("re-saving the same worker overwrites in place without deleting it", async () => {
    keytar.findCredentials.mockResolvedValue([{ account: WORKER_ID, password: record() }]);

    await store.storeCredentials(WORKER_ID, SECRET, API_URL);
    await store.storeCredentials(WORKER_ID, "rotated-secret", API_URL);

    expect(keytar.setPassword).toHaveBeenCalledTimes(2);
    expect(keytar.deletePassword).not.toHaveBeenCalled();
    expect(JSON.parse(keytar.setPassword.mock.calls[1][2]).worker_shared_secret).toBe("rotated-secret");
  });

  test("pairing under a new worker id removes the stale record", async () => {
    keytar.findCredentials.mockResolvedValue([
      { account: "worker-old", password: record() },
      { account: WORKER_ID, password: record() },
    ]);

    await store.storeCredentials(WORKER_ID, SECRET, API_URL);

    expect(keytar.deletePassword).toHaveBeenCalledTimes(1);
    expect(keytar.deletePassword).toHaveBeenCalledWith(SERVICE_NAME, "worker-old");
  });
});

describe("backend error handling", () => {
  const backendDown = new Error("Unknown or unsupported transport “disabled” for address “disabled:”");

  test("an unavailable backend reports unpaired instead of throwing", async () => {
    keytar.findCredentials.mockRejectedValue(backendDown);

    await expect(store.hasCredentials()).resolves.toBe(false);
    await expect(store.getPairedWorkerId()).resolves.toBeNull();
    expect(store.isBackendAvailable()).toBe(false);
    expect(store.getBackendError()).toContain("disabled");
  });

  test("checkBackend reports availability without writing", async () => {
    await expect(store.checkBackend()).resolves.toEqual({ available: true, error: null });
    expect(keytar.setPassword).not.toHaveBeenCalled();

    keytar.findCredentials.mockRejectedValue(backendDown);
    const result = await store.checkBackend();
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/disabled/);
  });

  test("a failed read returns null and a failed delete returns false", async () => {
    keytar.getPassword.mockRejectedValue(backendDown);
    keytar.deletePassword.mockRejectedValue(backendDown);

    await expect(store.getCredentials(WORKER_ID)).resolves.toBeNull();
    await expect(store.deleteCredentials(WORKER_ID)).resolves.toBe(false);
  });

  test("a failed save throws a typed error", async () => {
    keytar.setPassword.mockRejectedValue(backendDown);

    await expect(store.storeCredentials(WORKER_ID, SECRET, API_URL)).rejects.toMatchObject({
      code: "CREDENTIAL_BACKEND_UNAVAILABLE",
    });
  });
});

describe("no secret leakage", () => {
  test("backend errors quoting the secret are redacted in logs, state and thrown errors", async () => {
    keytar.setPassword.mockRejectedValue(new Error(`vault refused value ${SECRET} for ${WORKER_ID}`));

    const thrown = await store.storeCredentials(WORKER_ID, SECRET, API_URL).catch((err) => err);

    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).toContain("[redacted]");
    expect(store.getBackendError()).not.toContain(SECRET);

    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logger.warn).toHaveBeenCalled();
    expect(logged).not.toContain(SECRET);
  });

  test("a corrupt stored record is never echoed into the log", async () => {
    keytar.getPassword.mockResolvedValue(`{"worker_shared_secret":"${SECRET}"`);

    await expect(store.getCredentials(WORKER_ID)).resolves.toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET);
  });
});
