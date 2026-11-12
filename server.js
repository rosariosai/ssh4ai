require('dotenv').config();
const express        = require('express');
const { WebSocketServer } = require('ws');
const { Client }     = require('ssh2');
const http           = require('http');
const path           = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const { pool, init } = require('./db');
const { encryptPassword, decryptPassword } = require('./crypto');
const { hostGuard, wsAllowed, securityHeaders } = require('./security');
const access  = require('./access');
const {
  AUTH_TYPES, keysEnabled, disabledError, keyFromBody, publicDevice, loadKey,
  generateKeyPair, publicFromStored, buildSshOptions,
} = require('./keyauth');

const app    = express();
const server = http.createServer(app);
// Upgrades go through access.handleUpgrade (IP allowlist, Origin, login session when enabled);
// verifyClient keeps the Host / Origin check that protects against DNS rebinding.
const wss    = new WebSocketServer({ noServer: true, verifyClient: ({ req }) => wsAllowed(req) });
access.handleUpgrade(server, wss);

// ── WebSocket heartbeat — keeps connections alive through proxies ──
// Sends a ping every 25s; if client doesn't pong within 35s, terminate.
const PING_INTERVAL = 25000;

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);

// Guards: security headers and Host check (DNS rebinding) always; the login, IP allowlist and
// Origin checks of access.js only when configured (APP_PASSWORD_HASH / ALLOWED_CIDRS / Security panel).
app.use(securityHeaders);
app.use(hostGuard);
app.use(access.accessPre);
access.registerLoginRoutes(app);
app.use(access.authGate);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
access.registerSecurityRoutes(app);

const DEVICE_COLS = "id, device_name, ip_address, username, port, pinned, sort_order, auth_type, public_key, " +
                    "(private_key IS NOT NULL AND private_key <> '') AS has_key";

// ── Active SSH sessions (in-memory) ────────────────────────────────
const sessions = new Map();

// ════════════════════════════════════════════════════════════════════
//  REST API — Devices (CRUD against MariaDB)
// ════════════════════════════════════════════════════════════════════

// List all devices — ordered by sort_order (drag-and-drop reorder), then id
// as a tiebreaker for rows that haven't been manually reordered yet.
app.get('/api/devices', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT ${DEVICE_COLS} FROM ssh_devices ORDER BY sort_order ASC, id ASC`
    );
    res.json(rows.map(publicDevice));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single device. Password is intentionally excluded here too — the
// frontend never needs it (the edit form leaves the password field blank
// and only overwrites it when the user types a new one), and there's no
// reason to ever put a device's decrypted password on the wire to the
// browser. It's only decrypted server-side, at the moment of connecting.
app.get('/api/devices/:id', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT ${DEVICE_COLS} FROM ssh_devices WHERE id = ?`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(publicDevice(rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add device — appended to the end of the current sort order, not pinned
// by default.
app.post('/api/devices', async (req, res) => {
  const device_name = req.body.device_name || req.body.name;
  const ip_address  = req.body.ip_address  || req.body.host;
  const username    = req.body.username;
  const password    = req.body.password;
  const port        = req.body.port;
  const auth_type   = req.body.auth_type || 'password';
  if (!AUTH_TYPES.includes(auth_type)) return res.status(400).json({ error: 'Invalid auth_type' });
  if (!device_name || !ip_address || !username || (auth_type !== 'key' && !password)) {
    return res.status(400).json({ error: auth_type === 'key'
      ? 'device_name, ip_address and username are required'
      : 'device_name, ip_address, username and password are required' });
  }
  if (auth_type !== 'password' && !keysEnabled()) return res.status(503).json({ error: disabledError().message });
  let kp = null;
  try { kp = keyFromBody(req.body, device_name); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const [[{ nextOrder }]] = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextOrder FROM ssh_devices'
    );
    const [result] = await pool.execute(
      'INSERT INTO ssh_devices (device_name, ip_address, username, password, port, sort_order, auth_type, private_key, key_passphrase, public_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [device_name, ip_address, username, encryptPassword(password || ''), port || 22, nextOrder,
       auth_type, kp ? kp.priv : null, kp ? kp.pass : null, kp ? kp.pub : null]
    );
    res.status(201).json({ id: result.insertId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Toggle/set a device's pinned state — used by the "show pinned only" filter
app.put('/api/devices/:id/pin', async (req, res) => {
  try {
    await pool.execute(
      'UPDATE ssh_devices SET pinned=? WHERE id=?',
      [req.body.pinned ? 1 : 0, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Persist a new manual sort order — body: { order: [deviceId, deviceId, ...] }
// in the exact order they should display, top to bottom.
app.put('/api/devices/reorder', async (req, res) => {
  const order = req.body.order;
  if (!Array.isArray(order) || !order.length) {
    return res.status(400).json({ error: 'order must be a non-empty array of device ids' });
  }
  try {
    await Promise.all(
      order.map((id, index) =>
        pool.execute('UPDATE ssh_devices SET sort_order=? WHERE id=?', [index, id])
      )
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update device. Empty password = keep the stored password; empty private_key = keep the stored key.
app.put('/api/devices/:id', async (req, res) => {
  const device_name = req.body.device_name || req.body.name;
  const ip_address  = req.body.ip_address  || req.body.host;
  const username    = req.body.username;
  const password    = req.body.password;
  const port        = req.body.port;
  const auth_type   = req.body.auth_type || 'password';
  if (!AUTH_TYPES.includes(auth_type)) return res.status(400).json({ error: 'Invalid auth_type' });
  if (auth_type !== 'password' && !keysEnabled()) return res.status(503).json({ error: disabledError().message });
  let kp = null;
  try { kp = keyFromBody(req.body, device_name); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const sets = ['device_name=?', 'ip_address=?', 'username=?', 'port=?', 'auth_type=?'];
    const vals = [device_name, ip_address, username, port || 22, auth_type];
    if (password) { sets.push('password=?'); vals.push(encryptPassword(password)); }
    if (kp) { sets.push('private_key=?', 'key_passphrase=?', 'public_key=?'); vals.push(kp.priv, kp.pass, kp.pub); }
    vals.push(req.params.id);
    await pool.execute('UPDATE ssh_devices SET ' + sets.join(', ') + ' WHERE id=?', vals);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate an ed25519 key pair on the server; the private key is stored encrypted, the public key returned.
app.post('/api/devices/:id/generate-key', async (req, res) => {
  if (!keysEnabled()) return res.status(503).json({ error: disabledError().message });
  try {
    const [rows] = await pool.execute('SELECT id, device_name, auth_type, private_key FROM ssh_devices WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const d = rows[0];
    if (d.private_key && !(req.body && req.body.replace === true)) {
      return res.status(409).json({ error: 'Host already has a private key; send {"replace":true} to overwrite it' });
    }
    const pair = generateKeyPair(d.device_name);
    const newAuth = d.auth_type === 'password' ? 'key' : d.auth_type;
    await pool.execute(
      'UPDATE ssh_devices SET auth_type=?, private_key=?, key_passphrase=NULL, public_key=? WHERE id=?',
      [newAuth, pair.priv, pair.pub, req.params.id]
    );
    res.json({ public_key: pair.pub, auth_type: newAuth });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public key of a host (derived from the stored private key if not saved yet).
app.get('/api/devices/:id/public-key', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT device_name, private_key, key_passphrase, public_key FROM ssh_devices WHERE id = ?', [req.params.id]);
    if (!rows.length || (!rows[0].private_key && !rows[0].public_key)) return res.status(404).json({ error: 'No key stored for this host' });
    const d = rows[0];
    if (d.public_key) return res.json({ public_key: d.public_key });
    const pub = publicFromStored(d);
    await pool.execute('UPDATE ssh_devices SET public_key=? WHERE id=?', [pub, req.params.id]);
    res.json({ public_key: pub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete device
app.delete('/api/devices/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM ssh_devices WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════
// ================================================================
//  REST API -- Buckets (persistent)
// ================================================================

app.get('/api/buckets', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM ssh_buckets ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/buckets/:id', async (req, res) => {
  try {
    await pool.execute('UPDATE ssh_buckets SET content=? WHERE id=?',
      [req.body.content || '', req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

//  REST API — Macros
// ════════════════════════════════════════════════════════════════════

// Get all 5 macros
app.get('/api/macros', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM ssh_macros ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a single macro
app.put('/api/macros/:id', async (req, res) => {
  const { name, command } = req.body;
  try {
    await pool.execute(
      'UPDATE ssh_macros SET name=?, command=? WHERE id=?',
      [name || '', command || '', req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
//  REST API — Web Links (4 URL launcher buttons in the sidebar)
// ════════════════════════════════════════════════════════════════════

const LINK_SLOTS = 4;

// Create the table on first boot and seed 4 slots (slot 1 = Presidio).
// Safe to run on every start: CREATE IF NOT EXISTS + seed only when empty.
async function initLinks() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ssh_links (
      id    INT AUTO_INCREMENT PRIMARY KEY,
      name  VARCHAR(60)   NOT NULL DEFAULT '',
      url   VARCHAR(1000) NOT NULL DEFAULT '',
      icon  MEDIUMTEXT
    )
  `);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM ssh_links');
  if (n === 0) {
    await pool.execute(
      'INSERT INTO ssh_links (name, url, icon) VALUES (?, ?, NULL)',
      ['Presidio', 'https://example.com/']
    );
    for (let i = 2; i <= LINK_SLOTS; i++) {
      await pool.execute('INSERT INTO ssh_links (name, url, icon) VALUES (?, ?, NULL)', ['', '']);
    }
  }
}

app.get('/api/links', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, name, url, icon FROM ssh_links ORDER BY id LIMIT ' + LINK_SLOTS);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/links/:id', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const url  = String(req.body.url  || '').trim();
  const icon = req.body.icon ? String(req.body.icon) : null;

  // Only http(s) URLs may be stored (blocks javascript:, data:, file: ...)
  if (url && !/^https?:\/\/[^\s]+$/i.test(url)) {
    return res.status(400).json({ error: 'URL must start with http:// or https://' });
  }
  if (url.length > 1000) return res.status(400).json({ error: 'URL too long' });
  // Icon must be a small raster/SVG data-URL image
  if (icon && (!/^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/i.test(icon) || icon.length > 200000)) {
    return res.status(400).json({ error: 'Invalid icon image' });
  }
  try {
    await pool.execute(
      'UPDATE ssh_links SET name=?, url=?, icon=? WHERE id=?',
      [name, url, icon, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════
//  REST API — SSH Sessions
// ════════════════════════════════════════════════════════════════════

// Connect to a saved device by DB id
app.post('/api/connect/:deviceId', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM ssh_devices WHERE id = ?', [req.params.deviceId]);
    if (!rows.length) return res.status(404).json({ error: 'Device not found' });

    const device    = rows[0];
    const sessionId = uuidv4();

    let plainPassword;
    try {
      plainPassword = decryptPassword(device.password);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    // Key authentication: resolve and validate the stored key before the session is created.
    let authType = 'password', privateKey, passphrase;
    if (device.auth_type && device.auth_type !== 'password') {
      authType = device.auth_type;
      try { ({ privateKey, passphrase } = loadKey(device)); }
      catch (e) { return res.status(400).json({ error: e.message }); }
    }

    sessions.set(sessionId, {
      id:        sessionId,
      deviceId:  device.id,
      label:     device.device_name,
      host:      device.ip_address,
      port:      device.port || 22,
      username:  device.username,
      password:  plainPassword,
      auth_type: authType,
      privateKey,
      passphrase,
      ws:        null,
      ssh:       null,
      stream:    null,
      connected: false,
    });

    res.json({ sessionId, label: device.device_name, host: device.ip_address, username: device.username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Connect using ad-hoc credentials (not saved)
app.post('/api/connect', async (req, res) => {
  const { host, port, username, password } = req.body;
  if (!host || !username) return res.status(400).json({ error: 'host and username required' });

  const sessionId = uuidv4();
  sessions.set(sessionId, {
    id: sessionId, deviceId: null,
    label: `${username}@${host}`,
    host, port: port || 22, username, password,
    ws: null, ssh: null, stream: null, connected: false,
  });
  res.json({ sessionId, label: `${username}@${host}`, host, username });
});

// Close a session
app.delete('/api/sessions/:id', (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  cleanupSession(s);
  res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════
//  WebSocket -- terminal I/O
//
//  Each browser tab opens its OWN WebSocket connection.
//  The first message must be { type:'attach', sessionId } which
//  binds THIS ws to that session.  Multiple sessions can exist
//  simultaneously -- they never share a ws instance.
// ════════════════════════════════════════════════════════════════════

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let bound = null;   // the session object this ws is attached to

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── attach: bind this ws to a session and start SSH ──────────
    if (msg.type === 'attach') {
      const s = sessions.get(msg.sessionId);
      if (!s) return ws.send(JSON.stringify({ type: 'error', data: 'Session not found' }));

      // Guard: if this session already has an active SSH stream
      // (shouldn't happen, but prevents double-connect on reconnect)
      if (s.stream) {
        // just re-attach the ws so output flows to the new browser tab
        bound = s;
        s.ws  = ws;
        ws.send(JSON.stringify({ type: 'status', data: 'connected' }));
        return;
      }

      bound  = s;
      s.ws   = ws;
      if (msg.cols) s.cols = msg.cols;
      if (msg.rows) s.rows = msg.rows;
      connectSSH(s);
      return;
    }

    if (!bound) return;

    if (msg.type === 'keepalive') return; // client heartbeat, ignore
    if (msg.type === 'input'  && bound.stream) bound.stream.write(msg.data);
    if (msg.type === 'resize' && bound.stream) bound.stream.setWindow(msg.rows, msg.cols, 0, 0);
  });

  ws.on('close', () => {
    // Only null out session.ws if it is still pointing at THIS ws.
    // This prevents a closing tab from silencing another tab's session.
    if (bound && bound.ws === ws) bound.ws = null;
  });

  ws.on('error', () => {
    if (bound && bound.ws === ws) bound.ws = null;
  });
});

// ════════════════════════════════════════════════════════════════════
//  SSH helpers
// ════════════════════════════════════════════════════════════════════

function connectSSH(session) {
  const conn = new Client();
  // Servers such as ESXi use keyboard-interactive instead of plain password auth.
  conn.on('keyboard-interactive', (n, i, l, prompts, finish) => finish(prompts.map(() => session.password)));
  session.ssh = conn;

  conn.on('ready', () => {
    session.connected = true;
    send(session, { type: 'status', data: 'connected' });

    const shellCols = session.cols || 220;
    const shellRows = session.rows || 50;
    conn.shell({ term: 'xterm-256color', cols: shellCols, rows: shellRows }, (err, stream) => {
      if (err) { send(session, { type: 'error', data: err.message }); return cleanupSession(session); }

      session.stream = stream;

      stream.on('data', (d) => sendRaw(session, d));
      stream.stderr.on('data', (d) => sendRaw(session, d));
      stream.on('close', () => {
        send(session, { type: 'status', data: 'disconnected' });
        cleanupSession(session);
      });
    });
  });

  conn.on('error', (err) => {
    send(session, { type: 'error', data: `SSH: ${err.message}` });
    cleanupSession(session);
  });

  conn.on('close', () => {
    session.connected = false;
    send(session, { type: 'status', data: 'disconnected' });
  });

  try {
    conn.connect(buildSshOptions(session));
  } catch (e) {
    send(session, { type: 'error', data: e.message });
  }
}

function sendRaw(session, buf) {
  // Encode SSH output as base64 string frame to survive any proxy
  // Format: "O" + base64(data)  -- guaranteed ASCII, no binary corruption
  if (!session.ws || session.ws.readyState !== 1) return;
  session.ws.send('O' + buf.toString('base64'));
}

function send(session, msg) {
  if (!session.ws || session.ws.readyState !== 1) return;
  // Control messages (status, error) as JSON text frame
  session.ws.send(JSON.stringify(msg));
}

function cleanupSession(session) {
  try { if (session.stream) session.stream.end(); } catch {}
  try { if (session.ssh)    session.ssh.end();    } catch {}
  session.stream = null;
  session.ssh    = null;
  session.connected = false;
  sessions.delete(session.id);
}

// ════════════════════════════════════════════════════════════════════
//  Boot
// ════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 7722;

// Fail fast and clearly if ENCRYPTION_KEY isn't set, rather than letting
// the first "add device" or "connect" request blow up with a confusing
// stack trace deep in crypto.js.
try {
  require('./crypto').encryptPassword('startup-check');
} catch (e) {
  console.error('\n  ✗  ' + e.message + '\n');
  process.exit(1);
}

init()
  .then(() => access.loadAccessSettings())
  .then(() => initLinks())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`\n  ⬡  ssh4ai  →  http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error('\n  ✗  Could not connect to MariaDB:', err.message);
    console.error('     Check .env settings and make sure the DB is reachable.\n');
    process.exit(1);
  });
