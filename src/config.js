'use strict';
// Central configuration. Everything can be overridden with environment variables.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  // Backward compatibility: the original app stored ./habit-tracker.db in the working directory.
  const legacy = path.join(process.cwd(), 'habit-tracker.db');
  if (fs.existsSync(legacy)) return legacy;
  return path.join(ROOT, 'data', 'habit-tracker.db');
}

function resolveJwtSecret(dbPath) {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (fromEnv) console.warn('[config] JWT_SECRET is shorter than 16 characters - ignoring it.');
  if (dbPath === ':memory:') return crypto.randomBytes(32).toString('hex');

  // No secret supplied: generate one once and keep it next to the database so
  // sessions survive restarts (and no secret is ever hard-coded in the source).
  const file = path.join(path.dirname(path.resolve(dbPath)), '.jwt_secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch (_) { /* not created yet */ }
  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.writeFileSync(file, secret, { mode: 0o600 });
  } catch (err) {
    console.warn('[config] Could not persist generated JWT secret (' + err.message + '). Sessions will reset on restart.');
  }
  return secret;
}

function load() {
  const dbPath = resolveDbPath();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  return {
    port: Number(process.env.PORT) || 8080,
    dbPath,
    jwtSecret: resolveJwtSecret(dbPath),
    authRateMax: Number(process.env.AUTH_RATE_MAX) || 30,
    publicDir: path.join(ROOT, 'public'),
  };
}

module.exports = { load };
