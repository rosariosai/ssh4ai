// Tests for the optional access protection in access.js (wired into server.js).
// Run:  npm install && node --test test/
// The server is started in a temp folder with a stubbed database (no MariaDB needed).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'correct horse battery staple';
let tmp, hash;

function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4ai-access-'));
  for (const f of ['server.js', 'access.js', 'keyauth.js', 'crypto.js', 'security.js']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  }
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(__dirname, 'stub-db.js'), path.join(tmp, 'db.js'));
  hash = execFileSync('node', [path.join(ROOT, 'tools', 'hash-password.js')], { input: PASSWORD }).toString().trim();
}

const net = require('node:net');
function freePort() {                                   // ask the OS, so a leftover server can never answer for a new one
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function start(env) {
  const p = await freePort();
  const child = spawn('node', ['server.js'], { cwd: tmp, env: { PATH: process.env.PATH, PORT: String(p), ENCRYPTION_KEY: 'a'.repeat(64), ...env } });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) {             // the server prints its address only once it is listening
    if (child.exitCode !== null) throw new Error('server exited: ' + out);
    ready = /http:\/\/localhost:\d+/.test(out);
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) { child.kill(); throw new Error('server did not start: ' + out); }
  return { base: `http://127.0.0.1:${p}`, port: p, child, out: () => out, stop: () => child.kill() };
}

before(setup);
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const html = { Accept: 'text/html' };
const form = (o) => new URLSearchParams(o).toString();
async function login(srv, password, extra = {}) {
  return fetch(srv.base + '/login', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: srv.base, ...extra },
    body: form({ password, next: '/' }),
  });
}
const cookieOf = (r) => (r.headers.get('set-cookie') || '').split(';')[0];
function wsOpen(srv, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { headers });
    ws.on('open', () => resolve({ ok: true, ws }));
    ws.on('unexpected-response', (_q, res) => resolve({ ok: false, status: res.statusCode }));
    ws.on('error', () => resolve({ ok: false, status: 0 }));
  });
}

test('feature off: behaves as before (no login, no checks)', async () => {
  const srv = await start({});
  try {
    assert.equal((await fetch(srv.base + '/api/links')).status, 200);
    const lg = await fetch(srv.base + '/login', { redirect: 'manual' });
    assert.equal(lg.status, 302); assert.equal(lg.headers.get('location'), '/');   // nothing to sign in to
    const w = await wsOpen(srv, {});          // no Origin header at all
    assert.ok(w.ok); w.ws.close();
  } finally { srv.stop(); }
});

test('startup fails closed on bad config', async () => {
  for (const env of [{ APP_PASSWORD_HASH: 'nonsense' }, { ALLOWED_CIDRS: '10.0.0.0/99' }, { ALLOWED_CIDRS: 'not-an-ip' }]) {
    const child = spawn('node', ['server.js'], { cwd: tmp, env: { PATH: process.env.PATH, PORT: '0', ...env } });
    const code = await new Promise((r) => child.on('exit', r));
    assert.notEqual(code, 0);
  }
});

test('login on: everything needs a session', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    assert.equal((await fetch(srv.base + '/api/devices')).status, 401);
    assert.equal((await fetch(srv.base + '/api/connect/1', { method: 'POST', headers: { Origin: srv.base } })).status, 401);
    const r = await fetch(srv.base + '/', { headers: html, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), /^\/login/);
    assert.equal((await fetch(srv.base + '/js/app.js', { redirect: 'manual' })).status, 401);
    assert.equal((await fetch(srv.base + '/healthz')).status, 200);
    assert.equal((await wsOpen(srv, { Origin: srv.base })).status, 401);
  } finally { srv.stop(); }
});

test('login: wrong password, right password, cookie flags, session works, logout', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    const bad = await login(srv, 'wrong');
    assert.equal(bad.status, 401);
    assert.ok(!bad.headers.get('set-cookie'));
    assert.match(await bad.text(), /Wrong password/);

    const ok = await login(srv, PASSWORD);
    assert.equal(ok.status, 303);
    const sc = ok.headers.get('set-cookie');
    assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
    assert.doesNotMatch(sc, /Secure/);                       // plain http on a LAN address
    const cookie = cookieOf(ok);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: cookie } })).status, 200);

    const w = await wsOpen(srv, { Origin: srv.base, Cookie: cookie });
    assert.ok(w.ok, 'ws with session and Origin should open');
    const closed = new Promise((r) => w.ws.on('close', (code) => r(code)));

    const out = await fetch(srv.base + '/logout', { method: 'POST', redirect: 'manual', headers: { Origin: srv.base, Cookie: cookie } });
    assert.equal(out.status, 303);
    assert.equal(await closed, 4401);                         // open terminals are closed on logout
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: cookie } })).status, 401);
  } finally { srv.stop(); }
});

test('session id changes at login (no fixation) and old session dies', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    const c1 = cookieOf(await login(srv, PASSWORD));
    const c2 = cookieOf(await login(srv, PASSWORD, { Cookie: c1 }));
    assert.notEqual(c1, c2);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: c1 } })).status, 401);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: c2 } })).status, 200);
  } finally { srv.stop(); }
});

test('login page lets the browser send its real Origin on the form POST (regression: Origin "null" gave 403)', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    for (const url of ['/login', '/logout']) {
      const r = await fetch(srv.base + url);
      assert.equal(r.headers.get('referrer-policy'), 'same-origin');   // "no-referrer" makes browsers send Origin: null
    }
    // a form POST that arrives with Origin "null" is still refused
    assert.equal((await login(srv, PASSWORD, { Origin: 'null' })).status, 403);
  } finally { srv.stop(); }
});

test('Origin checks: bad or missing Origin refused on login, API writes and WebSocket', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    assert.equal((await login(srv, PASSWORD, { Origin: 'https://evil.example' })).status, 403);
    const noOrigin = await fetch(srv.base + '/login', { method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ password: PASSWORD }) });
    assert.equal(noOrigin.status, 403);
    const cookie = cookieOf(await login(srv, PASSWORD));
    assert.equal((await fetch(srv.base + '/api/macros/1', { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await wsOpen(srv, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await wsOpen(srv, { Cookie: cookie })).status, 403);
  } finally { srv.stop(); }
});

test('rate limit: repeated failures lock the address out, even for the right password', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await login(srv, 'bad' + i)).status, 401);
    const locked = await login(srv, PASSWORD);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  } finally { srv.stop(); }
});

test('idle timeout and absolute lifetime end the session', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash, SESSION_IDLE_MINUTES: '0.01' });   // 0.6 s
  try {
    const cookie = cookieOf(await login(srv, PASSWORD));
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: cookie } })).status, 200);
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: cookie } })).status, 401);
  } finally { srv.stop(); }
  const srv2 = await start({ APP_PASSWORD_HASH: hash, SESSION_MAX_HOURS: '0.0002' });   // 0.72 s
  try {
    const cookie = cookieOf(await login(srv2, PASSWORD));
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal((await fetch(srv2.base + '/api/links', { headers: { Cookie: cookie } })).status, 401);
  } finally { srv2.stop(); }
});

test('Secure cookie behind a trusted proxy (X-Forwarded-Proto) and __Host- prefix', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash, TRUSTED_PROXIES: '127.0.0.1' });
  try {
    const r = await login(srv, PASSWORD, { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.50' });
    const sc = r.headers.get('set-cookie');
    assert.match(sc, /^__Host-sid=/); assert.match(sc, /Secure/);
  } finally { srv.stop(); }
});

test('IP allowlist: allowed range passes, others refused on HTTP and WebSocket; XFF only trusted from the proxy', async () => {
  // allowlist without password
  const srv = await start({ ALLOWED_CIDRS: '192.0.2.0/24, 198.51.100.5', TRUSTED_PROXIES: '127.0.0.1' });
  try {
    const ok = await fetch(srv.base + '/api/links', { headers: { 'X-Forwarded-For': '192.0.2.77' } });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { 'X-Forwarded-For': '198.51.100.5' } })).status, 200);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { 'X-Forwarded-For': '8.8.8.8' } })).status, 403);
    // spoof attempt: attacker-supplied left entry, real client (right entry) is outside the range
    assert.equal((await fetch(srv.base + '/api/links', { headers: { 'X-Forwarded-For': '192.0.2.5, 8.8.8.8' } })).status, 403);
    assert.equal((await wsOpen(srv, { Origin: srv.base, 'X-Forwarded-For': '8.8.8.8' })).status, 403);
    const w = await wsOpen(srv, { Origin: srv.base, 'X-Forwarded-For': '192.0.2.9' });
    assert.ok(w.ok); w.ws.close();
  } finally { srv.stop(); }
  // no trusted proxy configured: X-Forwarded-For is ignored, the socket address (127.0.0.1) decides
  const srv2 = await start({ ALLOWED_CIDRS: '192.0.2.0/24' });
  try {
    assert.equal((await fetch(srv2.base + '/api/links', { headers: { 'X-Forwarded-For': '192.0.2.5' } })).status, 403);
  } finally { srv2.stop(); }
  const srv3 = await start({ ALLOWED_CIDRS: '127.0.0.1' });
  try {
    assert.equal((await fetch(srv3.base + '/api/links')).status, 200);
  } finally { srv3.stop(); }
});

test('no secrets in the server output', async () => {
  const srv = await start({ APP_PASSWORD_HASH: hash });
  try {
    await login(srv, PASSWORD);
    await login(srv, 'wrong-password-xyz');
    const o = srv.out();
    assert.ok(!o.includes(PASSWORD)); assert.ok(!o.includes('wrong-password-xyz')); assert.ok(!o.includes(hash));
  } finally { srv.stop(); }
});

// ───────────── Security panel (settings saved in the database) ─────────────
function put(srv, p, body, { cookie, origin, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(headers || {}) };
  if (origin !== null) h.Origin = origin || srv.base;
  if (cookie) h.Cookie = cookie;
  return fetch(srv.base + p, { method: 'PUT', headers: h, body: JSON.stringify(body) });
}
const dbfile = () => path.join(tmp, 'db-' + Math.random().toString(36).slice(2) + '.json');
const getJson = async (srv, p, cookie) => (await fetch(srv.base + p, { headers: cookie ? { Cookie: cookie } : {} })).json();

test('panel: defaults are all off and editable', async () => {
  const srv = await start({ STUB_DB_FILE: dbfile() });
  try {
    const s = await getJson(srv, '/api/security');
    assert.equal(s.ok, true); assert.equal(s.canEdit, true);
    assert.equal(s.login.on, false); assert.equal(s.allow.on, false);
    assert.equal(s.yourIp, '127.0.0.1');
    assert.equal((await fetch(srv.base + '/api/links')).status, 200);   // nothing changes until something is switched on
  } finally { srv.stop(); }
});

test('panel: a foreign or missing Origin cannot change settings, even while protection is off', async () => {
  const srv = await start({ STUB_DB_FILE: dbfile() });
  try {
    for (const origin of ['https://evil.example', null, 'null']) {
      assert.equal((await put(srv, '/api/security/login', { enabled: true, newPassword: 'a-long-password-1' }, { origin })).status, 403);
      assert.equal((await put(srv, '/api/security/allowlist', { enabled: true, cidrs: '127.0.0.1' }, { origin })).status, 403);
    }
    assert.equal((await getJson(srv, '/api/security')).login.on, false);
  } finally { srv.stop(); }
});

test('panel: login on/off, change password, persistence across restart', async () => {
  const file = dbfile();
  let srv = await start({ STUB_DB_FILE: file });
  try {
    assert.equal((await put(srv, '/api/security/login', { enabled: true, newPassword: 'short' })).status, 400);
    const on = await put(srv, '/api/security/login', { enabled: true, newPassword: 'first-long-password' });
    assert.equal(on.status, 200);
    const c1 = cookieOf(on);
    assert.ok(c1, 'the browser that turned login on stays signed in');
    assert.equal((await fetch(srv.base + '/api/links')).status, 401);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: c1 } })).status, 200);
    assert.deepEqual((await getJson(srv, '/api/security', c1)).login, { on: true, source: 'db' });

    // any change needs the current password
    assert.equal((await put(srv, '/api/security/login', { enabled: true, newPassword: 'second-long-password' }, { cookie: c1 })).status, 403);
    assert.equal((await put(srv, '/api/security/login', { enabled: true, currentPassword: 'wrong', newPassword: 'second-long-password' }, { cookie: c1 })).status, 403);
    const ch = await put(srv, '/api/security/login', { enabled: true, currentPassword: 'first-long-password', newPassword: 'second-long-password' }, { cookie: c1 });
    assert.equal(ch.status, 200);
    const c2 = cookieOf(ch);
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: c1 } })).status, 401);   // old sessions end
    assert.equal((await fetch(srv.base + '/api/links', { headers: { Cookie: c2 } })).status, 200);
    srv.stop();

    // restart: the saved login still applies
    srv = await start({ STUB_DB_FILE: file });
    assert.equal((await fetch(srv.base + '/api/links')).status, 401);
    assert.equal((await login(srv, 'first-long-password')).status, 401);
    const back = await login(srv, 'second-long-password');
    assert.equal(back.status, 303);
    const c3 = cookieOf(back);

    // turning it off needs the current password too
    assert.equal((await put(srv, '/api/security/login', { enabled: false }, { cookie: c3 })).status, 403);
    assert.equal((await put(srv, '/api/security/login', { enabled: false, currentPassword: 'second-long-password' }, { cookie: c3 })).status, 200);
    assert.equal((await fetch(srv.base + '/api/links')).status, 200);
    assert.ok(!srv.out().includes('first-long-password') && !srv.out().includes('second-long-password'));
  } finally { srv.stop(); }
});

test('panel: allowlist refuses to lock you out, enforces, persists, can be turned off', async () => {
  const file = dbfile();
  const env = { STUB_DB_FILE: file, TRUSTED_PROXIES: '127.0.0.1' };
  const as = (ip) => ({ headers: { 'X-Forwarded-For': ip } });
  let srv = await start(env);
  try {
    // 192.0.2.5 is "you"
    const lock = await put(srv, '/api/security/allowlist', { enabled: true, cidrs: '10.0.0.0/8' }, as('192.0.2.5'));
    assert.equal(lock.status, 400); assert.match((await lock.json()).error, /lock you out/);
    assert.equal((await put(srv, '/api/security/allowlist', { enabled: true, cidrs: 'not-an-ip' }, as('192.0.2.5'))).status, 400);
    assert.equal((await put(srv, '/api/security/allowlist', { enabled: true, cidrs: '192.0.2.0/24, 198.51.100.5' }, as('192.0.2.5'))).status, 200);
    assert.equal((await fetch(srv.base + '/api/links', as('8.8.8.8'))).status, 403);
    assert.equal((await fetch(srv.base + '/api/links', as('192.0.2.9'))).status, 200);
    assert.equal((await fetch(srv.base + '/api/links', as('198.51.100.5'))).status, 200);
    srv.stop();

    srv = await start(env);                                     // restart: still enforced
    assert.equal((await fetch(srv.base + '/api/links', as('8.8.8.8'))).status, 403);
    const s = await (await fetch(srv.base + '/api/security', as('192.0.2.5'))).json();
    assert.equal(s.allow.on, true); assert.equal(s.allow.source, 'db'); assert.deepEqual(s.allow.cidrs, ['192.0.2.0/24', '198.51.100.5']);

    assert.equal((await put(srv, '/api/security/allowlist', { enabled: false }, as('192.0.2.5'))).status, 200);
    assert.equal((await fetch(srv.base + '/api/links', as('8.8.8.8'))).status, 200);
    const s2 = await (await fetch(srv.base + '/api/security', as('192.0.2.5'))).json();
    assert.equal(s2.allow.on, false); assert.deepEqual(s2.allow.cidrs, ['192.0.2.0/24', '198.51.100.5']);   // list is kept for next time
  } finally { srv.stop(); }
});

test('panel: values set by the environment are read-only', async () => {
  const srv = await start({ STUB_DB_FILE: dbfile(), APP_PASSWORD_HASH: hash, ALLOWED_CIDRS: '127.0.0.1' });
  try {
    const cookie = cookieOf(await login(srv, PASSWORD));
    const s = await getJson(srv, '/api/security', cookie);
    assert.equal(s.login.source, 'env'); assert.equal(s.allow.source, 'env');
    assert.equal((await put(srv, '/api/security/login', { enabled: false, currentPassword: PASSWORD }, { cookie })).status, 409);
    assert.equal((await put(srv, '/api/security/allowlist', { enabled: false }, { cookie })).status, 409);
  } finally { srv.stop(); }
});

test('recovery: ACCESS_RESET=1 clears what the panel saved', async () => {
  const file = dbfile();
  let srv = await start({ STUB_DB_FILE: file });
  try {
    assert.equal((await put(srv, '/api/security/login', { enabled: true, newPassword: 'first-long-password' })).status, 200);
    srv.stop();
    srv = await start({ STUB_DB_FILE: file });
    assert.equal((await fetch(srv.base + '/api/links')).status, 401);
    srv.stop();
    srv = await start({ STUB_DB_FILE: file, ACCESS_RESET: '1' });
    assert.equal((await fetch(srv.base + '/api/links')).status, 200);
    assert.match(srv.out(), /ACCESS_RESET=1/);
  } finally { srv.stop(); }
});

test('a saved password hash that cannot be read stops the app (fails closed)', async () => {
  const file = dbfile();
  fs.writeFileSync(file, JSON.stringify({ auth_hash: 'garbage' }));
  const child = spawn('node', ['server.js'], { cwd: tmp, env: { PATH: process.env.PATH, PORT: '0', STUB_DB_FILE: file } });
  const code = await new Promise((r) => child.on('exit', r));
  assert.notEqual(code, 0);
});
