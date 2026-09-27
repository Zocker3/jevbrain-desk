'use strict';
/**
 * keeper.js - the auto-farm loop.
 *
 * Every `intervalMin` minutes it makes sure the session is valid (logging in
 * again if needed) and calls POST /api/credits/accrue. The server enforces its
 * own accrual interval, so "interval not yet reached" is a normal, non-error
 * result. Failures are retried with exponential backoff (1, 2, 4 ... 30 min).
 */
const { EventEmitter } = require('events');

const MAX_BACKOFF_MIN = 30;

class Keeper extends EventEmitter {
  /**
   * @param {object} opts
   * @param {() => import('./jevClient').JevClient} opts.getClient
   * @param {() => number} opts.getIntervalMin
   * @param {import('./logger').Logger} opts.logger
   * @param {(record: object) => void} opts.onAccrual
   */
  constructor({ getClient, getIntervalMin, logger, onAccrual }) {
    super();
    this.getClient = getClient;
    this.getIntervalMin = getIntervalMin;
    this.logger = logger;
    this.onAccrual = onAccrual;
    this.running = false;
    this.busy = false;
    this.timer = null;
    this.backoffMin = 1;
    this.consecutiveErrors = 0;
    this.nextRunAt = null;
    this.lastRunAt = null;
    this.lastResult = null;
    this.startedAt = null;
  }

  state() {
    return {
      running: this.running,
      busy: this.busy,
      nextRunAt: this.nextRunAt,
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      startedAt: this.startedAt,
      consecutiveErrors: this.consecutiveErrors,
      intervalMin: this.getIntervalMin(),
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.backoffMin = 1;
    this.consecutiveErrors = 0;
    this.logger.info(`Auto-farm started (every ${this.getIntervalMin()} min).`);
    this.schedule(0);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    this.logger.info('Auto-farm stopped.');
  }

  /** Re-apply the interval after a settings change. */
  reschedule() {
    if (!this.running || this.busy || !this.lastRunAt || this.consecutiveErrors > 0) return;
    const due = Date.parse(this.lastRunAt) + this.getIntervalMin() * 60_000;
    this.schedule(Math.max(0, due - Date.now()));
  }

  schedule(delayMs) {
    clearTimeout(this.timer);
    this.nextRunAt = new Date(Date.now() + delayMs).toISOString();
    this.timer = setTimeout(() => this.runCycle(), delayMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** One accrual cycle. Can also be triggered manually. */
  async runCycle({ manual = false } = {}) {
    if (this.busy) return this.lastResult;
    this.busy = true;
    const client = this.getClient();
    try {
      if (!client) throw new Error('Wallet is locked.');
      const a = await client.accrue();
      const accrued = Number(a.accruedAmount || 0);
      const record = {
        ts: new Date().toISOString(),
        ok: true,
        accrued,
        available: a.availableCredits ?? null,
        reason: accrued > 0 ? null : (a.reason || 'No new credits yet (server interval pending).'),
        manual,
      };
      if (accrued > 0) this.logger.success(`+${accrued} credits accrued (available: ${record.available}).`);
      else this.logger.info(`No new credits: ${record.reason}`);
      this.lastResult = record;
      this.onAccrual(record);
      this.consecutiveErrors = 0;
      this.backoffMin = 1;
      if (this.running) this.schedule(this.getIntervalMin() * 60_000);
      return record;
    } catch (err) {
      this.consecutiveErrors += 1;
      const record = { ts: new Date().toISOString(), ok: false, accrued: 0, available: null, reason: err.message, manual };
      this.lastResult = record;
      this.onAccrual(record);
      if (this.running) {
        const wait = this.backoffMin;
        this.logger.error(`Accrual failed: ${err.message} | retrying in ${wait} min`);
        this.backoffMin = Math.min(this.backoffMin * 2, MAX_BACKOFF_MIN);
        this.schedule(wait * 60_000);
      } else {
        this.logger.error(`Accrual failed: ${err.message}`);
      }
      return record;
    } finally {
      this.lastRunAt = new Date().toISOString();
      this.busy = false;
      this.emit('cycle', this.lastResult);
    }
  }
}

module.exports = { Keeper };
