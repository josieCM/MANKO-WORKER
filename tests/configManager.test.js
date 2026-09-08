"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ConfigManager,
  DEFAULT_CONFIG,
  isSecretKey,
  stripSecrets,
} = require("../src/main/configManager");

const SECRET = "s3cr3t-shared-value";

let root;
let manager;
let logger;

function readConfigFile() {
  return JSON.parse(fs.readFileSync(manager.configPath, "utf8"));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "manko-config-"));
  logger = { warn: jest.fn() };
  manager = new ConfigManager({ appDataPath: root, logger });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("layout and defaults", () => {
  test("config, sessions and logs live under the MANKO Worker data directory", () => {
    manager.loadConfig();

    expect(manager.configPath).toBe(path.join(root, "config.json"));
    expect(manager.sessionsPath).toBe(path.join(root, "sessions"));
    expect(manager.getSessionConfigPath("abc")).toBe(path.join(root, "sessions", "abc", "session.json"));
    expect(fs.existsSync(manager.sessionsPath)).toBe(true);
    expect(fs.existsSync(manager.getLogsPath())).toBe(true);
  });

  test("defaults carry the documented worker runtime values", () => {
    expect(manager.loadConfig()).toMatchObject({
      maxSessions: 5,
      commandEndpointHost: "127.0.0.1",
      commandEndpointPort: 3939,
      heartbeatIntervalMs: 10000,
      ackDelayMs: 2500,
      navigationTimeoutMs: 45000,
      crashMaxRecoveryAttempts: 3,
      crashMaxBackoffMs: 60000,
      crashRecoveryBackoffMs: [5000, 15000, 30000],
      headless: false,
    });
  });

  test("defaults hold no secret-like keys and cannot be mutated through the manager", () => {
    expect(Object.keys(DEFAULT_CONFIG).filter(isSecretKey)).toEqual([]);

    const defaults = manager.getDefaults();
    defaults.maxSessions = 999;
    expect(manager.getDefaults().maxSessions).toBe(5);
  });
});

describe("creation and loading", () => {
  test("first load writes a config file containing the defaults", () => {
    expect(fs.existsSync(manager.configPath)).toBe(false);

    const config = manager.loadConfig();

    expect(fs.existsSync(manager.configPath)).toBe(true);
    expect(readConfigFile()).toEqual(config);
  });

  test("an existing file is merged over the defaults, so new keys appear", () => {
    fs.writeFileSync(manager.configPath, JSON.stringify({ maxSessions: 2 }));

    const config = manager.loadConfig();

    expect(config.maxSessions).toBe(2);
    expect(config.commandEndpointPort).toBe(3939);
  });

  test("get() loads lazily rather than throwing on a fresh manager", () => {
    expect(manager.get("maxSessions")).toBe(5);
  });
});

describe("persistence and updates", () => {
  test("updates are written to disk and survive a restart", () => {
    manager.loadConfig();
    manager.updateConfig({ maxSessions: 3, logLevel: "warn" });
    manager.set("minimizeToTray", false);

    const restarted = new ConfigManager({ appDataPath: root, logger });
    const config = restarted.loadConfig();

    expect(config.maxSessions).toBe(3);
    expect(config.logLevel).toBe("warn");
    expect(config.minimizeToTray).toBe(false);
  });

  test("saving leaves no temporary file behind", () => {
    manager.loadConfig();
    manager.updateConfig({ maxSessions: 4 });

    expect(fs.readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("session config is stored per session and reloads unchanged", () => {
    manager.loadConfig();
    const session = { session_id: "abc", target_url: "https://example.test", state: "assigned" };

    manager.saveSessionConfig("abc", session);

    expect(manager.loadSessionConfig("abc")).toEqual(session);
    expect(manager.listSessions()).toEqual(["abc"]);

    manager.deleteSession("abc");
    expect(manager.loadSessionConfig("abc")).toBeNull();
  });
});

describe("missing and malformed configuration", () => {
  test("malformed config.json falls back to defaults without throwing or echoing the file", () => {
    fs.writeFileSync(manager.configPath, `{"workerSharedSecret": "${SECRET}"`);

    const config = manager.loadConfig();

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET);
  });

  test("a config file that is not an object falls back to defaults", () => {
    fs.writeFileSync(manager.configPath, "[1,2,3]");

    expect(manager.loadConfig()).toEqual(DEFAULT_CONFIG);
  });

  test("a missing session.json returns null instead of throwing", () => {
    manager.loadConfig();
    expect(manager.loadSessionConfig("nope")).toBeNull();
  });

  test("a malformed session.json returns null and logs no file contents", () => {
    manager.loadConfig();
    fs.mkdirSync(manager.getSessionPath("abc"), { recursive: true });
    fs.writeFileSync(manager.getSessionConfigPath("abc"), `{"cookie":"${SECRET}"`);

    expect(manager.loadSessionConfig("abc")).toBeNull();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET);
  });
});

describe("secret boundary", () => {
  test("secret-like keys are recognised", () => {
    expect(isSecretKey("workerSharedSecret")).toBe(true);
    expect(isSecretKey("worker_shared_secret")).toBe(true);
    expect(isSecretKey("authToken")).toBe(true);
    expect(isSecretKey("cookies")).toBe(true);
    expect(isSecretKey("maxSessions")).toBe(false);
    expect(stripSecrets({ maxSessions: 1, workerSharedSecret: SECRET })).toEqual({ maxSessions: 1 });
  });

  test("updateConfig cannot write a secret into config.json", () => {
    manager.loadConfig();

    manager.updateConfig({ maxSessions: 2, workerSharedSecret: SECRET, pairingToken: SECRET });

    expect(manager.config.workerSharedSecret).toBeUndefined();
    expect(fs.readFileSync(manager.configPath, "utf8")).not.toContain(SECRET);
    expect(readConfigFile().maxSessions).toBe(2);
  });

  test("set() rejects a secret-like key outright", () => {
    manager.loadConfig();

    expect(() => manager.set("workerSharedSecret", SECRET)).toThrow(/Refusing to persist/);
    expect(fs.readFileSync(manager.configPath, "utf8")).not.toContain(SECRET);
  });

  test("a secret already present in config.json is dropped on load and on the next save", () => {
    fs.writeFileSync(
      manager.configPath,
      JSON.stringify({ maxSessions: 2, workerSharedSecret: SECRET })
    );

    const config = manager.loadConfig();
    expect(config.workerSharedSecret).toBeUndefined();

    manager.saveConfig();
    expect(fs.readFileSync(manager.configPath, "utf8")).not.toContain(SECRET);
  });

  test("session.json never receives secret-like fields", () => {
    manager.loadConfig();

    manager.saveSessionConfig("abc", {
      session_id: "abc",
      target_url: "https://example.test",
      cookies: [{ name: "sid", value: SECRET }],
      accessToken: SECRET,
    });

    expect(fs.readFileSync(manager.getSessionConfigPath("abc"), "utf8")).not.toContain(SECRET);
    expect(manager.loadSessionConfig("abc")).toEqual({
      session_id: "abc",
      target_url: "https://example.test",
    });
  });

  test("runtime secrets live only in the runtime view, never in the persisted config", () => {
    manager.loadConfig();

    const runtime = manager.buildRuntimeConfig({
      workerId: "worker-01",
      workerSharedSecret: SECRET,
      base44ApiBaseUrl: "https://api.test",
    });

    expect(runtime.workerSharedSecret).toBe(SECRET);
    expect(runtime.maxSessions).toBe(5);

    // Mutating the runtime view must not reach the persisted config.
    runtime.maxSessions = 99;
    manager.saveConfig();

    expect(manager.config.workerSharedSecret).toBeUndefined();
    expect(readConfigFile().maxSessions).toBe(5);
    expect(fs.readFileSync(manager.configPath, "utf8")).not.toContain(SECRET);
  });
});
