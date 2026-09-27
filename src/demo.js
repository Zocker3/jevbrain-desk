'use strict';
/**
 * demo.js - DEMO MODE with clearly fake data (npm run demo).
 *
 * Used for screenshots and for trying the UI without a wallet. No key is loaded,
 * nothing is signed, and no request is sent to jevbrain.world or any Solana RPC.
 * Every number and address below is made up.
 */
const { App } = require('./app');

const DEMO_ADDRESS = 'DemoWa11et1111111111111111111111111111111111';
const DEMO_SELLERS = [
  'DemoSe11erA111111111111111111111111111111111',
  'DemoSe11erB111111111111111111111111111111111',
  'DemoSe11erC111111111111111111111111111111111',
];
const RATE = 750; // fake tier rate (credits/hour)
const HOUR = 3600_000;

function disabled() {
  const e = new Error('Disabled in demo mode.');
  e.status = 400;
  throw e;
}

/** Fake API client exposing the same methods the app uses on JevClient. */
function createDemoClient() {
  const state = {
    available: 12480, earned: 15730, used: 2050, redeemed: 1200,
    orders: [
      { orderId: 'demo_order_1', sellerWallet: DEMO_ADDRESS, creditsAmount: 5000, priceSol: 0.05, status: 'ACTIVE' },
      { orderId: 'demo_order_2', sellerWallet: DEMO_SELLERS[0], creditsAmount: 1000, priceSol: 0.012, status: 'ACTIVE' },
      { orderId: 'demo_order_3', sellerWallet: DEMO_SELLERS[1], creditsAmount: 20000, priceSol: 0.18, status: 'ACTIVE' },
      { orderId: 'demo_order_4', sellerWallet: DEMO_SELLERS[2], creditsAmount: 2500, priceSol: 0.03, status: 'ACTIVE' },
    ],
    nextOrder: 5,
  };
  const now = Date.now();
  const session = { valid: true, checkedAt: new Date(now).toISOString(), loggedInAt: new Date(now - 2 * HOUR).toISOString(), lastError: null };

  return {
    address: DEMO_ADDRESS,
    session,
    setBaseUrl() {},
    clearSession() {},
    async login() { session.valid = true; session.loggedInAt = session.checkedAt = new Date().toISOString(); return { tier: 'Demo Tier' }; },
    async validateSession() { session.checkedAt = new Date().toISOString(); return true; },
    async getEligibility() {
      return { eligible: true, balanceUi: 250000, tier: 'Syndicate Director (demo)', tierLevel: 4, creditRatePerHour: RATE, tokenPriceUsd: 0.0000123, verifiedAt: new Date().toISOString() };
    },
    async getMarketInfo() { return { marketData: { priceUsd: 0.0000123, marketCap: 12300, priceChange24h: 1.23 } }; },
    async getBalance() {
      return { availableCredits: state.available, earnedCredits: state.earned, usedCredits: state.used, redeemedCredits: state.redeemed, transferredCredits: 0, updatedAt: new Date().toISOString(), boost: { multiplier: 1 } };
    },
    async getBoostStatus() { return { boostName: 'Base Holder', boostMultiplier: 1, boostedCreditRatePerHour: RATE, nextBoost: { name: 'Titan Boost' } }; },
    async getBurnQuote(credits) { return { creditsToBurn: credits, estimatedRewardSol: +(credits * 0.0000015).toFixed(6), warning: null }; },
    async getHistory() {
      const out = [];
      let bal = state.available;
      for (let i = 0; i < 12; i++) {
        const t = new Date(Date.now() - i * HOUR - 5 * 60_000).toISOString();
        if (i === 3) { out.push({ id: `demo_l${i}`, type: 'P2P_ESCROW', amount: -5000, balanceAfter: bal, timestamp: t, reference: 'demo_order_1', effectiveRatePerHour: null }); bal += 5000; continue; }
        out.push({ id: `demo_l${i}`, type: 'EARN', amount: RATE, balanceAfter: bal, timestamp: t, reference: 'demo', effectiveRatePerHour: RATE });
        bal -= RATE;
      }
      return out;
    },
    async listActiveOrders() { return state.orders.map(o => ({ ...o })); },
    async accrue() {
      const got = 12;
      state.available += got; state.earned += got;
      return { accruedAmount: got, availableCredits: state.available };
    },
    async createOrder(creditsAmount, priceSol) {
      if (creditsAmount > state.available) throw new Error('Insufficient credits (demo).');
      state.available -= creditsAmount;
      state.orders.unshift({ orderId: `demo_order_${state.nextOrder++}`, sellerWallet: DEMO_ADDRESS, creditsAmount, priceSol, status: 'ACTIVE' });
      return { success: true };
    },
    async cancelOrder(orderId) {
      const i = state.orders.findIndex(o => o.orderId === orderId && o.sellerWallet === DEMO_ADDRESS);
      if (i < 0) throw new Error('Order not found (demo).');
      state.available += state.orders[i].creditsAmount;
      state.orders.splice(i, 1);
      return { success: true };
    },
  };
}

class DemoApp extends App {
  constructor() {
    super();
    this.client = createDemoClient();
    this.settings = { ...this.settings, privacyMode: false };
    // Seed a fake accrual history and activity log so the UI looks alive.
    const t = h => new Date(Date.now() - h * HOUR).toISOString();
    this.history = [
      { ts: t(5), ok: true, accrued: RATE, available: 9480, reason: null, manual: false },
      { ts: t(4), ok: true, accrued: RATE, available: 10230, reason: null, manual: false },
      { ts: t(3.5), ok: true, accrued: 0, available: 10230, reason: 'Accrual interval not yet reached.', manual: true },
      { ts: t(3), ok: false, accrued: 0, available: null, reason: 'Network error on /api/credits/accrue: request timed out', manual: false },
      { ts: t(2.9), ok: true, accrued: RATE, available: 10980, reason: null, manual: false },
      { ts: t(2), ok: true, accrued: RATE, available: 11730, reason: null, manual: false },
      { ts: t(1), ok: true, accrued: RATE, available: 12480, reason: null, manual: false },
    ];
    const seed = [
      [2.1, 'info', 'DEMO MODE: all data is fake. No wallet loaded, no network requests.'],
      [2, 'success', 'Logged in (demo session, Syndicate Director (demo)).'],
      [2, 'success', `+${RATE} credits accrued (available: 11730).`],
      [1, 'success', `+${RATE} credits accrued (available: 12480).`],
      [0.5, 'info', 'No new credits: Accrual interval not yet reached.'],
    ];
    for (const [hAgo, level, message] of seed) {
      this.logger.entries.push({ id: ++this.logger.seq, ts: t(hAgo), level, message });
    }
  }

  status() {
    return { vaultExists: true, unlocked: true, address: DEMO_ADDRESS, demo: true, minPasswordLength: 8 };
  }

  fetchRpcBalance() { return Promise.resolve({ raw: '250000000000', decimals: 6, ui: 250000, accounts: 1 }); }

  setupVault() { disabled(); }
  unlock() { disabled(); }
  lock() { disabled(); }
  forget() { disabled(); }
  shutdown() { this.keeper.stop(); }
}

module.exports = { DemoApp, DEMO_ADDRESS };
