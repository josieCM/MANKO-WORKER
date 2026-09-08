"use strict";

const path = require("path");
const { chromium } = require("playwright");

// Observable-only authentication heuristics. No bypassing, no automation of
// login - the operator authenticates manually in the visible browser window.
const LOGIN_RE = /(\blog ?in\b|\bsign ?in\b|\blogin\b|\bregister\b|\bjoin now\b)/i;
const LOGOUT_RE = /(\blog ?out\b|\bsign ?out\b)/i;

class BrowserManager {
  constructor(cfg, logger) {
    this.cfg = cfg;
    this.logger = logger;
    this.context = null;
    this.page = null;
    this.intentionalClose = false;
  }

  // Deterministic persistent profile path per session id.
  profilePath(sessionId, sessionDir) {
    return path.join(sessionDir, sessionId, "chromium-profile");
  }

  async launch(sessionId, sessionDir) {
    if (this.context) throw new Error("Browser already running for this session");
    this.intentionalClose = false;
    const profilePath = this.profilePath(sessionId, sessionDir);
    this.logger.info("browser_launching", { session: sessionId, profile: profilePath });
    this.context = await chromium.launchPersistentContext(profilePath, {
      headless: this.cfg.headless,
      viewport: { width: 1280, height: 800 },
    });
    this.context.on("close", () => {
      if (!this.intentionalClose) {
        this.logger.warn("browser_context_closed_unexpectedly", { session: sessionId });
        if (this.onUnexpectedClose) this.onUnexpectedClose(sessionId);
      }
    });
    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.page.on("crash", () => {
      this.logger.warn("page_crashed", { session: sessionId });
    });
    this.logger.info("browser_started", { session: sessionId });
    return { context: this.context, page: this.page };
  }

  async navigate(url) {
    if (!this.page) throw new Error("No page available");
    const response = await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.cfg.navigationTimeoutMs,
    });
    return {
      httpStatus: response ? response.status() : null,
      finalUrl: this.page.url(),
    };
  }

  // Cheap observable health probe. Collects no sensitive page content.
  async snapshot() {
    if (!this.context) {
      return { browserAlive: false, pageAlive: false, currentUrl: null, title: null, readyState: null, latencyMs: null };
    }
    const t0 = Date.now();
    let currentUrl = null;
    let title = null;
    let readyState = null;
    let pageAlive = false;
    try {
      currentUrl = this.page.url();
      readyState = await this.page.evaluate(() => document.readyState);
      title = await this.page.title();
      pageAlive = !this.page.isClosed();
    } catch (err) {
      this.logger.warn("page_probe_failed", { error: err.message });
    }
    return {
      browserAlive: true,
      pageAlive,
      currentUrl,
      title,
      readyState,
      latencyMs: Date.now() - t0,
    };
  }

  // Best-effort observable authentication state. Never automates or
  // bypasses anything - purely reads visible button/link labels.
  async detectAuthState() {
    if (!this.page) return { status: "unknown", evidence: "no page" };
    try {
      const labels = await this.page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, [role="button"]'));
        const out = [];
        for (const el of els) {
          const t = (el.innerText || el.textContent || "").trim();
          if (t && t.length < 40 && out.length < 6) out.push(t);
        }
        return out;
      });
      const logoutHit = labels.find((t) => LOGOUT_RE.test(t));
      if (logoutHit) return { status: "authenticated", evidence: logoutHit };
      const loginHit = labels.find((t) => LOGIN_RE.test(t));
      if (loginHit) return { status: "required", evidence: loginHit };
      return { status: "unknown", evidence: "no login indicators" };
    } catch (err) {
      return { status: "unknown", evidence: err.message };
    }
  }

  async openNewPageInContext() {
    if (!this.context) throw new Error("No browser context available");
    this.page = await this.context.newPage();
    return this.page;
  }

  async close() {
    if (!this.context) return false;
    this.intentionalClose = true;
    try {
      await this.context.close();
    } catch (err) {
      this.logger.warn("browser_close_error", { error: err.message });
    }
    this.context = null;
    this.page = null;
    return true;
  }

  isRunning() {
    return !!this.context;
  }
}

module.exports = { BrowserManager };