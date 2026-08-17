'use strict';

const crypto = require('crypto');

const PLUGIN_TOKEN = process.env.LMS_PLUGIN_TOKEN || '';
const ADMIN_PASSWORD = process.env.LMS_ADMIN_PASSWORD || 'admin';

const adminSessions = new Map(); // token -> { createdAt, expiresAt }

function createAdminSession() {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.set(token, {
    createdAt: Date.now(),
    expiresAt: Date.now() + 12 * 60 * 60 * 1000
  });
  return token;
}

function isValidAdminToken(token) {
  if (!token) return false;
  const session = adminSessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function revokeAdminSession(token) {
  adminSessions.delete(token);
}

function checkAdminPassword(password) {
  return password === ADMIN_PASSWORD;
}

function checkPluginToken(token) {
  if (!PLUGIN_TOKEN) return true; // open in dev when unset
  return token === PLUGIN_TOKEN;
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-admin-token'] || req.query.token);
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  req.adminToken = token;
  next();
}

module.exports = {
  createAdminSession,
  isValidAdminToken,
  revokeAdminSession,
  checkAdminPassword,
  checkPluginToken,
  requireAdmin,
  ADMIN_PASSWORD,
  PLUGIN_TOKEN
};
