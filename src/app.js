'use strict';
/**
 * app.js - application state: vault lock/unlock, API client, keeper, dashboard snapshot.
 * This is the only place that ever touches the decrypted secret key, and it
 * hands it straight to the login-only signer.
 */
const cfg = require('./config');
const vault = require('./vault');
const { parseSecretKey } = require('./keys');
const { createLoginSigner } = require('./wallet');
const { JevClient } = require('./jevClient');
const { Keeper } = require('./keeper');
const { Logger } = require('./logger');
const { getTokenBalance } = require('./solanaRpc');

const MIN_LISTING_CREDITS = 100;   // enforced by the site
const MIN_LISTING_PRICE_SOL = 0.001; // enforced by the site's frontend
const MAX_HISTORY = 1000;

class App {
  constructor() {
    this.logger = new Logger();
    this.settings = cfg.loadSettings();
    this.signer = null;
    this.client = null;
    this.refreshInFlight = null;
    this.snapshot = this.emptySnapshot();
    this.history = cfg.readJson(cfg.FILES.history, []);
    if (!Array.isArray(this.history)) this.history = [];
    this.keeper = new Keeper({
      getClient: () => this.client,
      getIntervalMin: () => this.settings.intervalMin,
      logger: this.logger,
      onAccrual: rec => this.recordAccrual(rec),
    });
    // Refresh dashboard numbers after every successful keeper cycle.
    this.keeper.on('cycle', rec => { if (rec?.ok) this.refresh({ quiet: true }).catch(() => {}); });
  }

  emptySnapshot() {
    return {
      updatedAt: null, eligibility: null, balance: null, boost: null,
      rpcBalance: null, rpcError: null, market: null, redeemQuote: null, errors: {},
    };
  }

  // ------------------------------------------------------------------ vault

  status() {
    const v = vault.loadVault();
    return {
      vaultExists: !!v,
      unlocked: !!this.signer,
      address: v?.address || null,
      minPasswordLength: vault.MIN_PASSWORD_LENGTH,
    };
  }

  async setupVault(secretKeyInput, password) {
    if (vault.vaultExists()) throw new Error('A wallet is already configured. Forget it first.');
    const { secretKey, address } = parseSecretKey(secretKeyInput);
    try {
      const enc = await vault.encryptSecretKey(secretKey, password);
      vault.saveVault(enc);
      this.activate(secretKey);
    } finally {
      secretKey.fill(0);
    }
    this.logger.info(`Wallet saved (encrypted) for ${address}.`);
    return { address };
  }

  async unlock(password) {
    const v = vault.loadVault();
    if (!v) throw new Error('No wallet configured.');
    if (this.signer) return { address: this.signer.address };
    const secretKey = await vault.decryptSecretKey(v, password);
    try { this.activate(secretKey); } finally { secretKey.fill(0); }
    this.logger.info('Wallet unlocked.');
    if (this.settings.autoStartKeeper) this.keeper.start();
    this.refresh({ quiet: true }).catch(() => {});
    return { address: this.signer.address };
  }

  activate(secretKey) {
    this.signer = createLoginSigner(secretKey);
    this.client = new JevClient({ baseUrl: this.settings.baseUrl, signer: this.signer, logger: this.logger });
    this.snapshot = this.emptySnapshot();
  }

  lock() {
    this.keeper.stop();
    const wasUnlocked = !!this.signer;
    if (this.signer) this.signer.destroy();
    this.signer = null;
    this.client = null;
    this.snapshot = this.emptySnapshot();
    if (wasUnlocked) this.logger.info('Wallet locked; key wiped from memory.');
  }

  forget() {
    this.lock();
    vault.deleteVault();
    this.logger.warn('Encrypted wallet deleted from this computer.');
  }

  requireClient() {
    if (!this.client) { const e = new Error('Wallet is locked.'); e.status = 423; throw e; }
    return this.client;
  }

  // -------------------------------------------------------------- dashboard

  /** Refresh the dashboard snapshot. Concurrent calls share one in-flight refresh. */
  refresh(opts = {}) {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh(opts).finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  async doRefresh({ quiet = false } = {}) {
    const client = this.requireClient();
    const errors = {};
    const settle = async (key, fn) => {
      try { return await fn(); } catch (err) { errors[key] = err.message; return null; }
    };

    // Public reads first, then authenticated reads (which share one login).
    const [eligibility, market] = await Promise.all([
      settle('eligibility', () => client.getEligibility()),
      settle('market', () => client.getMarketInfo()),
    ]);
    const balance = await settle('balance', () => client.getBalance());
    const boost = balance ? await settle('boost', () => client.getBoostStatus()) : null;
    const available = Number(balance?.availableCredits || 0);
    const redeemQuote = available > 0 ? await settle('redeemQuote', () => client.getBurnQuote(available)) : null;

    let rpcBalance = null; let rpcError = null;
    try {
      rpcBalance = await this.fetchRpcBalance(client.address);
    } catch (err) { rpcError = err.message; }

    this.snapshot = {
      updatedAt: new Date().toISOString(),
      eligibility: eligibility && {
        eligible: !!eligibility.eligible,
        balanceUi: eligibility.balanceUi ?? null,
        tier: eligibility.tier || eligibility.tierName || null,
        tierLevel: eligibility.tierLevel ?? null,
        creditRatePerHour: eligibility.creditRatePerHour ?? null,
        tokenPriceUsd: eligibility.tokenPriceUsd ?? null,
        verifiedAt: eligibility.verifiedAt || null,
      },
      balance: balance && {
        available: Number(balance.availableCredits ?? balance.available ?? 0),
        earned: Number(balance.earnedCredits ?? balance.earned ?? 0),
        used: Number(balance.usedCredits ?? 0),
        redeemed: Number(balance.redeemedCredits ?? 0),
        transferred: Number(balance.transferredCredits ?? 0),
        updatedAt: balance.updatedAt || null,
        boostMultiplier: Number(balance.boost?.multiplier ?? 1),
      },
      boost: boost && {
        name: boost.boostName || null,
        multiplier: Number(boost.boostMultiplier ?? 1),
        effectiveRatePerHour: boost.boostedCreditRatePerHour ?? null,
        nextBoostName: boost.nextBoost?.name || null,
      },
      market: market?.marketData && {
        priceUsd: market.marketData.priceUsd ?? null,
        marketCap: market.marketData.marketCap ?? null,
        priceChange24h: market.marketData.priceChange24h ?? null,
      },
      redeemQuote: redeemQuote && {
        credits: redeemQuote.creditsToBurn,
        estimatedRewardSol: redeemQuote.estimatedRewardSol,
        warning: redeemQuote.warning || null,
      },
      rpcBalance, rpcError, errors,
    };
    const errKeys = Object.keys(errors);
    if (!quiet || errKeys.length) {
      if (errKeys.length) this.logger.warn(`Refresh finished with issues: ${errKeys.map(k => `${k}: ${errors[k]}`).join(' | ')}`);
      else this.logger.info('Dashboard refreshed.');
    }
    return this.snapshot;
  }

  /** Read-only on-chain balance cross-check (overridden in demo mode). */
  fetchRpcBalance(address) {
    return getTokenBalance(this.settings.rpcUrl, address, cfg.JEVBRAIN_MINT);
  }

  async login() {
    const client = this.requireClient();
    client.clearSession();
    return client.login();
  }

  async validateSession() {
    const client = this.requireClient();
    return client.validateSession();
  }

  sessionState() {
    if (!this.client) return { valid: false, checkedAt: null, loggedInAt: null, lastError: null };
    return { ...this.client.session };
  }

  // ---------------------------------------------------------------- history

  recordAccrual(rec) {
    this.history.push(rec);
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
    try { cfg.writeFileSecure(cfg.FILES.history, JSON.stringify(this.history)); } catch { /* ignore */ }
  }

  async serverLedger() {
    return this.requireClient().getHistory();
  }

  // ------------------------------------------------------------ marketplace

  async orders() {
    const client = this.requireClient();
    const orders = await client.listActiveOrders();
    const me = client.address;
    return orders.map(o => ({
      orderId: o.orderId,
      sellerWallet: o.sellerWallet,
      creditsAmount: Number(o.creditsAmount || 0),
      priceSol: Number(o.priceSol || 0),
      ratePer1k: Number(o.creditsAmount) > 0 ? (Number(o.priceSol) / Number(o.creditsAmount)) * 1000 : 0,
      status: o.status || 'ACTIVE',
      createdAt: o.createdAt || null,
      mine: !!(o.sellerWallet && o.sellerWallet === me),
    }));
  }

  async createListing(creditsAmount, priceSol) {
    const credits = Number(creditsAmount);
    const price = Number(priceSol);
    if (!Number.isInteger(credits) || credits < MIN_LISTING_CREDITS) {
      throw new Error(`Minimum listing is ${MIN_LISTING_CREDITS} whole credits.`);
    }
    if (!Number.isFinite(price) || price < MIN_LISTING_PRICE_SOL || price > 1_000_000) {
      throw new Error(`Price must be at least ${MIN_LISTING_PRICE_SOL} SOL.`);
    }
    const client = this.requireClient();
    const res = await client.createOrder(credits, price);
    this.logger.success(`Listing created: ${credits} credits for ${price} SOL.`);
    this.refresh({ quiet: true }).catch(() => {});
    return res;
  }

  async cancelListing(orderId) {
    if (typeof orderId !== 'string' || !/^[A-Za-z0-9_\-:.]{1,128}$/.test(orderId)) throw new Error('Invalid order id.');
    const client = this.requireClient();
    const res = await client.cancelOrder(orderId);
    this.logger.success(`Listing ${orderId} cancelled; escrowed credits released.`);
    this.refresh({ quiet: true }).catch(() => {});
    return res;
  }

  // --------------------------------------------------------------- settings

  updateSettings(input) {
    const next = cfg.validateSettings(input, this.settings);
    const baseChanged = next.baseUrl !== this.settings.baseUrl;
    const intervalChanged = next.intervalMin !== this.settings.intervalMin;
    this.settings = next;
    cfg.saveSettings(next);
    if (baseChanged && this.client) {
      this.client.setBaseUrl(next.baseUrl);
      if (next.baseUrl !== cfg.OFFICIAL_BASE_URL) {
        this.logger.warn(`Base URL changed to a NON-OFFICIAL server: ${next.baseUrl}`);
      }
    }
    if (intervalChanged) this.keeper.reschedule();
    this.logger.info('Settings saved.');
    return next;
  }

  fullState(sinceLogId = 0) {
    return {
      status: this.status(),
      settings: this.settings,
      officialBaseUrl: cfg.OFFICIAL_BASE_URL,
      session: this.sessionState(),
      keeper: this.keeper.state(),
      snapshot: this.snapshot,
      history: this.history.slice(-200),
      logs: this.logger.since(sinceLogId),
      limits: { minListingCredits: MIN_LISTING_CREDITS, minListingPriceSol: MIN_LISTING_PRICE_SOL },
      serverTime: new Date().toISOString(),
    };
  }

  shutdown() {
    this.keeper.stop();
    if (this.signer) this.signer.destroy();
  }
}

module.exports = { App };
