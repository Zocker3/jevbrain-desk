'use strict';
/**
 * config.js - paths, defaults and persisted user settings.
 *
 * All runtime data lives in the data directory (default: ./data, git-ignored).
 * Override with the JEVDESK_DATA_DIR environment variable.
 */
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.JEVDESK_DATA_DIR || path.join(ROOT_DIR, 'data'));
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

const OFFICIAL_BASE_URL = 'https://jevbrain.world';
const JEVBRAIN_MINT = 'AxwSUUHx6hj8bgdtSxVUiKtKkZwmcDbNbEEtTvzfpump';

const DEFAULT_SETTINGS = Object.freeze({
  intervalMin: 60,
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  baseUrl: OFFICIAL_BASE_URL,
  autoStartKeeper: false,
  privacyMode: false,
});

const FILES = {
  vault: path.join(DATA_DIR, 'vault.json'),
  settings: path.join(DATA_DIR, 'settings.json'),
  history: path.join(DATA_DIR, 'accrual-history.json'),
  log: path.join(DATA_DIR, 'app.log'),
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

/** Write a file atomically with owner-only permissions. */
function writeFileSecure(file, content) {
  ensureDataDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function normaliseUrl(value, field) {
  let u;
  try { u = new URL(String(value).trim()); } catch { throw new Error(`${field} is not a valid URL.`); }
  const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) {
    throw new Error(`${field} must use https:// (http:// is only allowed for localhost).`);
  }
  if (u.username || u.password) throw new Error(`${field} must not contain credentials.`);
  return u.toString().replace(/\/+$/, '');
}

/** Validate a partial settings object, returning a clean copy. */
function validateSettings(input, current = DEFAULT_SETTINGS) {
  const out = { ...current };
  if (input.intervalMin !== undefined) {
    const n = Number(input.intervalMin);
    if (!Number.isFinite(n) || n < 1 || n > 1440) throw new Error('Interval must be between 1 and 1440 minutes.');
    out.intervalMin = Math.round(n);
  }
  if (input.rpcUrl !== undefined) out.rpcUrl = normaliseUrl(input.rpcUrl, 'RPC URL');
  if (input.baseUrl !== undefined) out.baseUrl = normaliseUrl(input.baseUrl, 'Base URL');
  if (input.autoStartKeeper !== undefined) out.autoStartKeeper = !!input.autoStartKeeper;
  if (input.privacyMode !== undefined) out.privacyMode = !!input.privacyMode;
  return out;
}

function loadSettings() {
  const stored = readJson(FILES.settings, {});
  try { return validateSettings(stored, DEFAULT_SETTINGS); } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(settings) {
  writeFileSecure(FILES.settings, JSON.stringify(settings, null, 2));
}

module.exports = {
  ROOT_DIR, DATA_DIR, PUBLIC_DIR, FILES, OFFICIAL_BASE_URL, JEVBRAIN_MINT, DEFAULT_SETTINGS,
  ensureDataDir, writeFileSecure, readJson, validateSettings, loadSettings, saveSettings,
};
