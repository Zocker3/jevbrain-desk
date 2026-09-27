'use strict';
/**
 * jevClient.js - minimal client for the jevbrain.world HTTP API.
 *
 * Every endpoint used here was verified against the site's own frontend
 * (https://jevbrain.world/app.js) and against live responses. Nothing is
 * invented. The session token is kept in memory only and never returned to
 * the browser UI.
 *
 *   GET  /api/wallet/nonce?address=            -> { nonce, message, chain }
 *   POST /api/wallet/verify-signature          { address, signature(hex), message } -> { success, sessionToken, userTier, credits, ... }
 *   GET  /api/session/validate                 -> { valid, address }
 *   GET  /api/holder/eligibility?address=      -> { eligible, balanceUi, tier, tierLevel, creditRatePerHour, tokenPriceUsd, ... }
 *   GET  /api/credits/balance?address=         -> { availableCredits, earnedCredits, usedCredits, redeemedCredits, transferredCredits, boost, ... }
 *   GET  /api/credits/history?address=         -> { history: [{ type, amount, balanceAfter, timestamp, metadata }] }
 *   POST /api/credits/accrue                   { walletAddress } -> { accruedAmount, availableCredits, reason }
 *   GET  /api/boost/status?wallet=             -> { boostName, boostMultiplier, boostedCreditRatePerHour, ... }
 *   GET  /api/credits/burn-quote?credits=      -> { estimatedRewardSol, rateLamportsPerCredit, warning }   (public, read-only)
 *   GET  /api/market-info                      -> { marketData: { priceUsd, marketCap, ... } }             (public)
 *   GET  /api/p2p/orders?status=ACTIVE         -> { orders: [{ orderId, sellerWallet, creditsAmount, priceSol, priceLamports }] } (public)
 *   POST /api/p2p/orders/create                { sellerWallet, creditsAmount, priceSol } -> { success }
 *   POST /api/p2p/orders/cancel                { orderId, sellerWallet } -> { success }
 */

const REQUEST_TIMEOUT_MS = 20_000;
const SESSION_RECHECK_MS = 60_000;

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

class JevClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl
   * @param {{address: string, signLoginMessage: Function}} opts.signer
   * @param {import('./logger').Logger} opts.logger
   */
  constructor({ baseUrl, signer, logger }) {
    this.baseUrl = baseUrl;
    this.signer = signer;
    this.logger = logger;
    this.token = '';
    this.session = { valid: false, checkedAt: null, loggedInAt: null, lastError: null };
    this.loginInFlight = null;
  }

  get address() { return this.signer.address; }

  setBaseUrl(url) {
    if (url !== this.baseUrl) { this.baseUrl = url; this.clearSession(); }
  }

  clearSession() {
    this.token = '';
    this.session = { ...this.session, valid: false };
  }

  async request(path, { method = 'GET', body, auth = true } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && this.token) {
      headers.Authorization = `Bearer ${this.token}`;
      headers['X-Session-Token'] = this.token;
    }
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (err) {
      const reason = err.name === 'TimeoutError' ? 'request timed out' : (err.cause?.code || err.message);
      throw new ApiError(`Network error on ${path.split('?')[0]}: ${reason}`, 0, null);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
    return { ok: res.ok, status: res.status, data };
  }

  /** Throws ApiError unless the response is 2xx. */
  async requestOk(path, opts) {
    const r = await this.request(path, opts);
    if (!r.ok) {
      const msg = r.data?.error || r.data?.message || (r.data?.raw ? 'Unexpected non-JSON response (server may be waking up)' : `HTTP ${r.status}`);
      throw new ApiError(msg, r.status, r.data);
    }
    return r.data;
  }

  // ---------------------------------------------------------------- session

  async login() {
    if (this.loginInFlight) return this.loginInFlight;
    this.loginInFlight = (async () => {
      const addr = encodeURIComponent(this.address);
      const n = await this.request(`/api/wallet/nonce?address=${addr}`, { auth: false });
      if (!n.ok || typeof n.data?.message !== 'string') {
        throw new ApiError(n.data?.error || `Could not get login challenge (HTTP ${n.status}).`, n.status, n.data);
      }
      // The signer validates the message against the exact login template and refuses anything else.
      const signature = this.signer.signLoginMessage(n.data.message, n.data.nonce);
      this.token = '';
      const v = await this.request('/api/wallet/verify-signature', {
        method: 'POST', auth: false,
        body: { address: this.address, signature, message: n.data.message },
      });
      if (!v.ok || !v.data?.success || !v.data?.sessionToken) {
        const msg = v.data?.error || `Login rejected (HTTP ${v.status}).`;
        this.session = { ...this.session, valid: false, lastError: msg, checkedAt: new Date().toISOString() };
        throw new ApiError(msg, v.status, v.data);
      }
      this.token = v.data.sessionToken;
      const now = new Date().toISOString();
      this.session = { valid: true, checkedAt: now, loggedInAt: now, lastError: null };
      const tier = v.data.userTier?.tierName || v.data.userTier?.name || 'unknown tier';
      this.logger.success(`Logged in to ${new URL(this.baseUrl).host} (${tier}).`);
      return { tier, credits: v.data.credits || null, tokensHeld: v.data.tokensHeld ?? null };
    })();
    try { return await this.loginInFlight; } finally { this.loginInFlight = null; }
  }

  async validateSession() {
    if (!this.token) { this.session = { ...this.session, valid: false }; return false; }
    const s = await this.request('/api/session/validate');
    const valid = !!(s.ok && s.data?.valid && s.data?.address === this.address);
    this.session = { ...this.session, valid, checkedAt: new Date().toISOString() };
    if (!valid) this.token = '';
    return valid;
  }

  async ensureSession() {
    // Skip the round-trip if the session was confirmed very recently; a 401 still triggers re-login.
    const fresh = this.session.valid && this.session.checkedAt &&
      Date.now() - Date.parse(this.session.checkedAt) < SESSION_RECHECK_MS;
    if (this.token && fresh) return;
    if (this.token && await this.validateSession()) return;
    if (this.session.loggedInAt) this.logger.warn('Session expired or invalid, logging in again...');
    await this.login();
  }

  /** Run an authenticated call; on 401, log in again once and retry. */
  async authed(fn) {
    await this.ensureSession();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this.logger.warn('Server returned 401, re-authenticating...');
        this.clearSession();
        await this.login();
        return fn();
      }
      throw err;
    }
  }

  // ------------------------------------------------------------- read APIs

  getEligibility() {
    return this.requestOk(`/api/holder/eligibility?address=${encodeURIComponent(this.address)}`);
  }

  getBalance() {
    return this.authed(() => this.requestOk(`/api/credits/balance?address=${encodeURIComponent(this.address)}`));
  }

  async getHistory() {
    const d = await this.authed(() => this.requestOk(`/api/credits/history?address=${encodeURIComponent(this.address)}`));
    // The live API returns `history`; the site's frontend also handles `ledger`.
    const list = Array.isArray(d.history) ? d.history : (Array.isArray(d.ledger) ? d.ledger : []);
    return list.map(e => ({
      id: e.id,
      type: e.type,
      amount: Number(e.amount ?? e.delta ?? 0),
      balanceAfter: Number(e.balanceAfter ?? e.balance ?? 0),
      timestamp: e.timestamp,
      reference: e.referenceId || e.reference || e.reason || '',
      effectiveRatePerHour: e.metadata?.effectiveRatePerHour ?? null,
    }));
  }

  getBoostStatus() {
    return this.authed(() => this.requestOk(`/api/boost/status?wallet=${encodeURIComponent(this.address)}`));
  }

  getBurnQuote(credits) {
    const n = Math.max(1, Math.floor(Number(credits) || 0));
    return this.requestOk(`/api/credits/burn-quote?credits=${n}`, { auth: false });
  }

  getMarketInfo() {
    return this.requestOk('/api/market-info', { auth: false });
  }

  async listActiveOrders() {
    const d = await this.requestOk('/api/p2p/orders?status=ACTIVE', { auth: false });
    return Array.isArray(d.orders) ? d.orders : [];
  }

  // ------------------------------------------------------------ write APIs

  accrue() {
    return this.authed(() => this.requestOk('/api/credits/accrue', {
      method: 'POST', body: { walletAddress: this.address },
    }));
  }

  async createOrder(creditsAmount, priceSol) {
    const d = await this.authed(() => this.requestOk('/api/p2p/orders/create', {
      method: 'POST', body: { sellerWallet: this.address, creditsAmount, priceSol },
    }));
    if (!d.success) throw new ApiError(d.error || 'Failed to create listing', 200, d);
    return d;
  }

  async cancelOrder(orderId) {
    const d = await this.authed(() => this.requestOk('/api/p2p/orders/cancel', {
      method: 'POST', body: { orderId, sellerWallet: this.address },
    }));
    if (!d.success) throw new ApiError(d.error || 'Failed to cancel order', 200, d);
    return d;
  }
}

module.exports = { JevClient, ApiError };
