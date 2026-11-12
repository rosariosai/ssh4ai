'use strict';
// Optional access protection for ssh4ai web: shared-password login, IP allowlist, Origin checks.
// Everything here is OFF unless configured, so an unchanged deployment behaves as before.
// Ported from the SSH4AI web terminal (v8-access-protection). Node built-ins only.
const crypto  = require('crypto');
const express = require('express');
const { pool } = require('./db');

// ════════════════════════════════════════════════════════════════════
// Access protection (optional) - added in v8-access
//   Everything below is OFF unless configured, so an unchanged deployment behaves as before.
//   APP_PASSWORD_HASH   shared login password (hash made with tools/hash-password.js)
//   ALLOWED_CIDRS       comma-separated IPs / CIDR ranges allowed to reach the app
//   TRUSTED_PROXIES     comma-separated IPs / CIDR ranges of the reverse proxy (to read X-Forwarded-*)
//   ALLOWED_ORIGINS     extra allowed browser origins, e.g. https://ssh.example.org (same host is always allowed)
//   SESSION_IDLE_MINUTES (default 30)   SESSION_MAX_HOURS (default 12)
//   COOKIE_SECURE       auto (default) | always | never
//   No new dependencies: Node built-ins only (crypto.scrypt, net.BlockList).
// ════════════════════════════════════════════════════════════════════
const net = require('net');

function parseList(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }
function numEnv(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
function normIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '').split('%')[0];
}
function buildBlockList(entries, label) {
  const bl = new net.BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const fam = net.isIPv4(addr) ? 'ipv4' : net.isIPv6(addr) ? 'ipv6' : null;
    if (!fam) throw new Error(`${label}: invalid entry "${e}"`);
    if (bits === undefined) { bl.addAddress(addr, fam); continue; }
    const n = Number(bits);
    if (!/^\d+$/.test(bits) || n > (fam === 'ipv4' ? 32 : 128)) throw new Error(`${label}: invalid prefix in "${e}"`);
    bl.addSubnet(addr, n, fam);
  }
  return bl;
}
function inList(bl, ip) {
  const a = normIp(ip);
  const fam = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
  return !!(bl && fam && bl.check(a, fam));
}

const ALLOWED_CIDRS   = parseList(process.env.ALLOWED_CIDRS);
const TRUSTED_PROXIES = parseList(process.env.TRUSTED_PROXIES);
const ALLOWED_ORIGINS = parseList(process.env.ALLOWED_ORIGINS).map((o) => o.toLowerCase());
const envBL = ALLOWED_CIDRS.length ? buildBlockList(ALLOWED_CIDRS, 'ALLOWED_CIDRS') : null;
const proxyBL = buildBlockList(TRUSTED_PROXIES, 'TRUSTED_PROXIES');
const IDLE_MS = numEnv('SESSION_IDLE_MINUTES', 30) * 60000;
const MAX_MS  = numEnv('SESSION_MAX_HOURS', 12) * 3600000;
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();

// Password hash format: scrypt:N:r:p:salt(base64url):hash(base64url)   (no "$", safe in docker compose)
function parsePwHash(str) {
  const p = String(str).trim().split(':');
  const N = Number(p[1]), r = Number(p[2]), pp = Number(p[3]);
  const salt = Buffer.from(p[4] || '', 'base64url'), hash = Buffer.from(p[5] || '', 'base64url');
  if (p.length !== 6 || p[0] !== 'scrypt' || !(N >= 16384) || (N & (N - 1)) !== 0 || !(r >= 1) || !(pp >= 1) ||
      salt.length < 16 || hash.length < 32) {
    throw new Error('Password hash is malformed (expected scrypt:N:r:p:salt:hash from tools/hash-password.js)');
  }
  return { N, r, p: pp, salt, hash };
}

// Effective settings. Environment variables win; otherwise the values saved from the Security panel
// (table ssh_settings) apply. Both features are off when neither is set.
const cfg = {
  pw: process.env.APP_PASSWORD_HASH ? parsePwHash(process.env.APP_PASSWORD_HASH) : null,
  pwSource: process.env.APP_PASSWORD_HASH ? 'env' : 'off',      // 'env' | 'db' | 'off'
  bl: envBL, cidrs: ALLOWED_CIDRS,
  allowSource: envBL ? 'env' : 'off',
  dbCidrs: [],                                                  // list saved from the panel (kept while the allowlist is switched off)
};
let settingsDb = false;                                         // true once ssh_settings is ready
const passOn   = () => !!cfg.pw;
const accessOn = () => !!cfg.pw || !!cfg.bl;

function clientIp(req) {
  const peer = normIp(req.socket && req.socket.remoteAddress);
  if (inList(proxyBL, peer)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(normIp).filter(Boolean);
    for (let i = xff.length - 1; i >= 0; i--) if (!inList(proxyBL, xff[i])) return xff[i];
    if (xff.length) return xff[0];
  }
  return peer;
}
function peerIsProxy(req) { return inList(proxyBL, normIp(req.socket && req.socket.remoteAddress)); }
function isHttps(req) {
  if (COOKIE_SECURE === 'always') return true;
  if (COOKIE_SECURE === 'never') return false;
  if (req.socket && req.socket.encrypted) return true;
  return peerIsProxy(req) && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
function originOk(req) {
  const o = req.headers.origin;       // browsers always send Origin on POST/PUT/DELETE and on WebSocket
  if (!o) return false;
  let u; try { u = new URL(o); } catch { return false; }
  if (ALLOWED_ORIGINS.includes(String(o).toLowerCase())) return true;
  const host = String((peerIsProxy(req) && req.headers['x-forwarded-host']) || req.headers.host || '').toLowerCase();
  return !!host && u.host.toLowerCase() === host;
}
function getCookie(req, name) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
const cookieName = (secure) => (secure ? '__Host-sid' : 'sid');
function setSidCookie(res, req, value) {
  const secure = isHttps(req);
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) attrs.push('Secure');
  if (value === null) attrs.push('Max-Age=0');
  res.append('Set-Cookie', `${cookieName(secure)}=${value || ''}; ${attrs.join('; ')}`);
}
const sidFromReq = (req) => getCookie(req, cookieName(isHttps(req)));

// ── server-side sessions (in memory; a restart logs everybody out) ──
const authSessions = new Map();   // sid -> { created, last, ip }
const authSockets  = new Map();   // sid -> Set<ws>
function newSession(ip) {
  const sid = crypto.randomBytes(32).toString('base64url');   // 256 bits
  authSessions.set(sid, { created: Date.now(), last: Date.now(), ip });
  return sid;
}
function endSession(sid) {
  authSessions.delete(sid);
  const set = authSockets.get(sid);
  if (set) { for (const ws of set) { try { ws.close(4401, 'Session ended'); } catch {} } authSockets.delete(sid); }
}
function getSession(sid) {
  const s = sid && authSessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (now - s.last > IDLE_MS || now - s.created > MAX_MS) { endSession(sid); return null; }
  return s;
}

// ── login rate limiting: per IP progressive lock + a global cap ──
const loginFails = new Map();     // ip -> { n, last, until }
let loginAttempts = [];           // timestamps, last 60 s
function lockRemaining(ip) {
  const f = loginFails.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function globalLimited() {
  const cutoff = Date.now() - 60000;
  loginAttempts = loginAttempts.filter((t) => t > cutoff);
  return loginAttempts.length >= 30;
}
function recordFail(ip) {
  const now = Date.now();
  const f = loginFails.get(ip) || { n: 0, last: 0, until: 0 };
  if (now - f.last > 15 * 60000) f.n = 0;
  f.n += 1; f.last = now;
  if (f.n >= 5) f.until = now + Math.min(900, 30 * 2 ** (f.n - 5)) * 1000;   // 30 s, 60 s, ... max 15 min
  loginFails.set(ip, f);
}
setInterval(() => {
  for (const sid of [...authSessions.keys()]) getSession(sid);
  const old = Date.now() - 3600000;
  for (const [ip, f] of loginFails) if (f.last < old && f.until < Date.now()) loginFails.delete(ip);
}, 60000).unref();

// ── password check (scrypt, one at a time so a flood cannot exhaust memory) ──
let verifyChain = Promise.resolve();
function verifyPassword(pw) {
  const run = () => new Promise((resolve, reject) => {
    crypto.scrypt(String(pw).normalize('NFKC'), cfg.pw.salt, cfg.pw.hash.length,
      { N: cfg.pw.N, r: cfg.pw.r, p: cfg.pw.p, maxmem: 256 * cfg.pw.N * cfg.pw.r },
      (err, key) => (err ? reject(err) : resolve(crypto.timingSafeEqual(key, cfg.pw.hash))));
  });
  const next = verifyChain.then(run, run);
  verifyChain = next.catch(() => {});
  return next;
}

// ── login page (plain HTML form, no scripts) ──
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function safeNext(n) { return typeof n === 'string' && /^\/(?!\/)[\x21-\x7e]*$/.test(n) && !/^\/(login|logout)/.test(n) ? n : '/'; }
function loginPage(error, next) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SSH4AI Terminal - Sign in</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e6e6;font:15px system-ui,sans-serif}
form{width:min(340px,90vw);background:#171a21;border:1px solid #2a2f3a;border-radius:10px;padding:24px}
h1{font-size:18px;margin:0 0 16px}
input[type=password]{width:100%;box-sizing:border-box;padding:10px;border-radius:6px;border:1px solid #394150;background:#0f1115;color:inherit;font-size:15px}
button{margin-top:14px;width:100%;padding:10px;border:0;border-radius:6px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
.err{margin:0 0 12px;color:#f87171}
</style></head><body>
<form method="post" action="/login">
<h1>SSH4AI Terminal</h1>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
<input type="hidden" name="next" value="${esc(next || '/')}">
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required maxlength="1024">
<button type="submit">Sign in</button>
</form></body></html>`;
}
function logoutPage() {
  return loginPage('', '/').replace(/<form method="post" action="\/login">[\s\S]*<\/form>/,
    '<form method="post" action="/logout"><h1>SSH4AI Terminal</h1><button type="submit">Sign out</button></form>');
}
const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  // same-origin (not no-referrer): with no-referrer browsers send "Origin: null" on the sign-in form POST and the Origin check rejects it
  'Referrer-Policy': 'same-origin',
};

// ── middleware ──
function accessPre(req, res, next) {
  if (!accessOn()) return next();
  const ip = clientIp(req);
  if (cfg.bl && !inList(cfg.bl, ip)) {
    console.warn(`[access] blocked ${ip} (not in ALLOWED_CIDRS)`);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originOk(req)) {
    console.warn(`[access] blocked ${req.method} from ${ip}: bad Origin`);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  if (req.path === '/healthz') return res.type('text/plain').send('ok');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}
function authGate(req, res, next) {
  if (!passOn()) return next();
  const s = getSession(sidFromReq(req));
  if (s) { s.last = Date.now(); return next(); }
  if ((req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept || '').includes('text/html')) {
    return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
  }
  res.status(401).json({ error: 'Authentication required' });
}
function registerLoginRoutes(app) {
  const urlenc = express.urlencoded({ extended: false, limit: '4kb' });
  app.get('/login', (req, res) => {
    res.set(PAGE_HEADERS);
    if (!passOn()) return res.redirect(302, '/');
    if (getSession(sidFromReq(req))) return res.redirect(302, '/');
    res.send(loginPage('', safeNext(req.query.next)));
  });
  app.post('/login', urlenc, async (req, res) => {
    res.set(PAGE_HEADERS);
    if (!passOn()) return res.redirect(303, '/');
    const ip = clientIp(req);
    const next = safeNext(req.body && req.body.next);
    const wait = lockRemaining(ip);
    if (wait > 0 || globalLimited()) {
      res.set('Retry-After', String(wait || 60));
      return res.status(429).send(loginPage('Too many attempts. Try again later.', next));
    }
    loginAttempts.push(Date.now());
    const pw = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    let ok = false;
    if (pw.length > 0 && pw.length <= 1024) {
      try { ok = await verifyPassword(pw); } catch (e) { console.error('[auth] verify error:', e.message); }
    }
    if (!ok) {
      recordFail(ip);
      console.warn(`[auth] failed login from ${ip}`);
      return res.status(401).send(loginPage('Wrong password.', next));
    }
    loginFails.delete(ip);
    const old = sidFromReq(req);
    if (old) endSession(old);                    // new session id at every login (no fixation)
    setSidCookie(res, req, newSession(ip));
    console.log(`[auth] login from ${ip}`);
    res.redirect(303, next);
  });
  app.get('/logout', (req, res) => {
    res.set(PAGE_HEADERS).send(logoutPage());
  });
  app.post('/logout', (req, res) => {
    const sid = sidFromReq(req);
    if (sid) endSession(sid);
    setSidCookie(res, req, null);
    res.set(PAGE_HEADERS).redirect(303, '/login');
  });
}

// ── Security panel: settings saved in the database (table ssh_settings) ──
//   auth_hash   scrypt hash of the shared password (login is ON when present)
//   allow_on    '1' when the allowlist is ON      allow_cidrs   comma-separated IPs / CIDR ranges
// ACCESS_RESET=1 in the environment clears these three at start (recovery if you lock yourself out).
async function setSetting(k, v) {
  await pool.query('INSERT INTO ssh_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
}
async function delSetting(k) { await pool.query('DELETE FROM ssh_settings WHERE k = ?', [k]); }

async function loadAccessSettings() {
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS ssh_settings (k VARCHAR(64) PRIMARY KEY, v MEDIUMTEXT NOT NULL)');
    if (process.env.ACCESS_RESET === '1') {
      await pool.query("DELETE FROM ssh_settings WHERE k IN ('auth_hash','allow_on','allow_cidrs')");
      console.warn(' ! ACCESS_RESET=1: the login and allowlist saved from the Security panel were cleared. Remove ACCESS_RESET from the compose file now.');
    }
    const [rows] = await pool.query('SELECT k, v FROM ssh_settings');
    const m = {};
    for (const r of rows) m[r.k] = r.v;
    settingsDb = true;
    // A saved value that cannot be read stops the app (fail closed) instead of silently turning protection off.
    if (!cfg.pw && m.auth_hash) { cfg.pw = parsePwHash(m.auth_hash); cfg.pwSource = 'db'; }
    cfg.dbCidrs = parseList(m.allow_cidrs);
    if (!cfg.bl && m.allow_on === '1' && cfg.dbCidrs.length) {
      cfg.bl = buildBlockList(cfg.dbCidrs, 'Saved allowlist'); cfg.cidrs = cfg.dbCidrs; cfg.allowSource = 'db';
    }
  } catch (e) {
    console.error(' ! Security settings could not be loaded:', e.message);
    throw e;
  }
  logAccess();
}

async function makePwHash(pw) {
  const salt = crypto.randomBytes(16), N = 131072, r = 8, p = 1;
  const run = () => new Promise((resolve, reject) => {
    crypto.scrypt(String(pw).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r },
      (err, key) => (err ? reject(err) : resolve(['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':'))));
  });
  const next = verifyChain.then(run, run);
  verifyChain = next.catch(() => {});
  return next;
}
function endAllSessions() { for (const sid of [...authSessions.keys()]) endSession(sid); }

function securityState(req) {
  return {
    ok: true,
    canEdit: settingsDb,
    yourIp: clientIp(req),
    proxyTrusted: TRUSTED_PROXIES.length > 0,
    login: { on: passOn(), source: cfg.pwSource },
    allow: { on: !!cfg.bl, source: cfg.allowSource, cidrs: cfg.bl ? cfg.cidrs : cfg.dbCidrs },
    idleMinutes: IDLE_MS / 60000,
    maxHours: MAX_MS / 3600000,
  };
}

function registerSecurityRoutes(app) {
  // Writes always check the Origin, even while protection is off (so another website cannot switch it on for you).
  const guard = (req, res) => {
    if (!originOk(req)) { res.status(403).json({ error: 'Forbidden' }); return false; }
    if (!settingsDb) { res.status(503).json({ error: 'Settings storage is not available' }); return false; }
    return true;
  };

  app.get('/api/security', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(securityState(req)); });

  app.put('/api/security/login', async (req, res) => {
    if (!guard(req, res)) return;
    if (cfg.pwSource === 'env') {
      return res.status(409).json({ error: 'The login is set by the server environment (APP_PASSWORD_HASH). Change it in the compose file.' });
    }
    const b = req.body || {};
    const ip = clientIp(req);
    try {
      if (passOn()) {        // changing or turning off an existing login needs the current password
        if (lockRemaining(ip) > 0) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
        const good = typeof b.currentPassword === 'string' && b.currentPassword.length > 0 &&
                     b.currentPassword.length <= 1024 && await verifyPassword(b.currentPassword);
        if (!good) { recordFail(ip); console.warn(`[security] wrong current password from ${ip}`); return res.status(403).json({ error: 'Current password is wrong' }); }
        loginFails.delete(ip);
      }
      if (b.enabled === true) {
        const np = b.newPassword;
        if (typeof np !== 'string' || np.length < 12 || np.length > 1024) {
          return res.status(400).json({ error: 'The new password must have 12 to 1024 characters' });
        }
        const hash = await makePwHash(np);
        await setSetting('auth_hash', hash);
        cfg.pw = parsePwHash(hash); cfg.pwSource = 'db';
        endAllSessions();                              // every old session ends; this browser gets a new one
        setSidCookie(res, req, newSession(ip));
        console.log(`[security] login password set from ${ip}`);
      } else if (b.enabled === false) {
        await delSetting('auth_hash');
        cfg.pw = null; cfg.pwSource = 'off';
        endAllSessions();
        setSidCookie(res, req, null);
        console.log(`[security] login turned off from ${ip}`);
      } else {
        return res.status(400).json({ error: 'enabled must be true or false' });
      }
      res.json(securityState(req));
    } catch (e) {
      console.error('[security] login update failed:', e.message);
      res.status(500).json({ error: 'Could not save the change' });
    }
  });

  app.put('/api/security/allowlist', async (req, res) => {
    if (!guard(req, res)) return;
    if (cfg.allowSource === 'env') {
      return res.status(409).json({ error: 'The allowed addresses are set by the server environment (ALLOWED_CIDRS). Change them in the compose file.' });
    }
    const b = req.body || {};
    const ip = clientIp(req);
    try {
      if (b.enabled === true) {
        const raw = Array.isArray(b.cidrs) ? b.cidrs : String(b.cidrs || '').split(/[\s,]+/);
        const entries = raw.map((x) => String(x).trim()).filter(Boolean);
        if (!entries.length || entries.length > 100) return res.status(400).json({ error: 'Enter 1 to 100 addresses or ranges' });
        let bl;
        try { bl = buildBlockList(entries, 'Allowed addresses'); } catch (e) { return res.status(400).json({ error: e.message }); }
        if (!inList(bl, ip)) {
          return res.status(400).json({ error: `Your current address (${ip}) is not in the list. Saving it would lock you out.` });
        }
        await setSetting('allow_cidrs', entries.join(','));
        await setSetting('allow_on', '1');
        cfg.bl = bl; cfg.cidrs = entries; cfg.dbCidrs = entries; cfg.allowSource = 'db';
        console.log(`[security] allowlist set (${entries.length} entries) from ${ip}`);
      } else if (b.enabled === false) {
        await setSetting('allow_on', '0');
        cfg.bl = null; cfg.cidrs = []; cfg.allowSource = 'off';
        console.log(`[security] allowlist turned off from ${ip}`);
      } else {
        return res.status(400).json({ error: 'enabled must be true or false' });
      }
      res.json(securityState(req));
    } catch (e) {
      console.error('[security] allowlist update failed:', e.message);
      res.status(500).json({ error: 'Could not save the change' });
    }
  });
}

// WebSocket upgrade: same checks as HTTP (allowlist, Origin, session), then hand over to ws.
function handleUpgrade(server, wss) {
  server.on('upgrade', (req, socket, head) => {
    const deny = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let sid = null;
    if (accessOn()) {
      const ip = clientIp(req);
      if (cfg.bl && !inList(cfg.bl, ip)) { console.warn(`[access] blocked ws from ${ip}`); return deny(403, 'Forbidden'); }
      if (!originOk(req)) { console.warn(`[access] blocked ws from ${ip}: bad Origin`); return deny(403, 'Forbidden'); }
      let pathname = '';
      try { pathname = new URL(req.url, 'http://x').pathname; } catch {}
      if (pathname !== '/ws') return deny(404, 'Not Found');
    }
    if (passOn()) {
      sid = sidFromReq(req);
      const s = getSession(sid);
      if (!s) return deny(401, 'Unauthorized');
      s.last = Date.now();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (sid) {
        if (!authSockets.has(sid)) authSockets.set(sid, new Set());
        authSockets.get(sid).add(ws);
        ws.on('message', () => { const s = authSessions.get(sid); if (s) s.last = Date.now(); });   // typing keeps the session alive
        ws.on('close', () => { const set = authSockets.get(sid); if (set) set.delete(ws); });
      }
      wss.emit('connection', ws, req);
    });
  });
}

function logAccess() {
  console.log(` Access: login ${passOn() ? 'ON (' + cfg.pwSource + ')' : 'off'}, allowlist ${cfg.bl ? cfg.cidrs.length + ' entries (' + cfg.allowSource + ')' : 'off'}` +
    (passOn() ? `, idle ${IDLE_MS / 60000} min, max ${MAX_MS / 3600000} h` : ''));
  if (cfg.bl && !TRUSTED_PROXIES.length) {
    console.warn(' ! The allowlist is on but TRUSTED_PROXIES is empty: behind a reverse proxy every client looks like the proxy. Set TRUSTED_PROXIES.');
  }
}

module.exports = { accessPre, authGate, registerLoginRoutes, registerSecurityRoutes, handleUpgrade, loadAccessSettings, logAccess };
