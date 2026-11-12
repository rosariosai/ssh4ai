'use strict';
// SSH key authentication (per host) for ssh4ai web.
//   auth_type: 'password' (default) | 'key' | 'key_password' (key first, then password)
//   private_key / key_passphrase are encrypted at rest with ENCRYPTION_KEY (AES-256-GCM, same
//   scheme as saved passwords) and are NEVER returned by any endpoint or written to the log.
// Ported from the SSH4AI web terminal (v6-key-auth).

const { utils: sshUtils } = require('ssh2');
const { encryptPassword: encSecret, decryptPassword: decSecret } = require('./crypto');

const AUTH_TYPES = ['password', 'key', 'key_password'];

// server.js refuses to start without a valid ENCRYPTION_KEY, so this is a belt-and-braces check.
function keysEnabled() {
  return /^[0-9a-fA-F]{64}$/.test(process.env.ENCRYPTION_KEY || '');
}

function disabledError() {
  const e = new Error('Key authentication is disabled: ENCRYPTION_KEY is not set on the server');
  e.status = 503;
  return e;
}

function normKey(pem) {
  return String(pem || '').replace(/\r\n?/g, '\n').trim() + '\n';
}

// Parse a private key; throws an Error with a readable message (never includes key material).
function parsePrivateKey(pem, passphrase) {
  let k;
  try { k = sshUtils.parseKey(pem, passphrase || undefined); } catch (e) { k = e; }
  const key = Array.isArray(k) ? k[0] : k;
  if (key instanceof Error) {
    if (/passphrase|encrypted|decrypt|integrity|bad/i.test(String(key.message))) {
      throw new Error('Wrong or missing key passphrase');
    }
    throw new Error('Not a valid private key (supported: OpenSSH or PEM RSA / ed25519 / ECDSA)');
  }
  if (typeof key.isPrivateKey === 'function' && !key.isPrivateKey()) {
    throw new Error('That is a public key - paste the PRIVATE key');
  }
  return key;
}

function publicLine(key, comment) {
  return key.type + ' ' + key.getPublicSSH().toString('base64') + (comment ? ' ' + comment : '');
}

function decryptStored(blob) {
  try {
    return decSecret(blob);
  } catch (e) {
    throw new Error('Stored key cannot be decrypted (ENCRYPTION_KEY missing or changed since it was saved)');
  }
}

// Validates + encrypts key fields from a request body. Returns null if no key was sent.
function keyFromBody(body, deviceName) {
  const raw = typeof body.private_key === 'string' ? body.private_key : '';
  if (!raw.trim()) return null;
  if (!keysEnabled()) throw disabledError();
  const pem = normKey(raw);
  const pass = body.key_passphrase ? String(body.key_passphrase) : '';
  const parsed = parsePrivateKey(pem, pass);
  return {
    priv: encSecret(pem),
    pass: pass ? encSecret(pass) : null,
    pub: publicLine(parsed, 'ssh4ai-' + deviceName),
  };
}

// Public view of a device row: has_key is a boolean, secrets are never included.
function publicDevice(r) {
  if (r && 'has_key' in r) r.has_key = !!Number(r.has_key);
  return r;
}

// Resolve + validate the stored key of a device row before a session is created.
// Returns { privateKey, passphrase }; throws a readable Error.
function loadKey(device) {
  if (!keysEnabled()) throw new Error('ENCRYPTION_KEY is not set on the server - cannot use key authentication');
  if (!device.private_key) throw new Error('No private key stored for this host - open Edit Host and add or generate one');
  const privateKey = decryptStored(device.private_key);
  const passphrase = device.key_passphrase ? decryptStored(device.key_passphrase) : '';
  parsePrivateKey(privateKey, passphrase);
  return { privateKey, passphrase };
}

// Generate an ed25519 key pair; the private key is returned already encrypted for storage.
function generateKeyPair(deviceName) {
  if (!keysEnabled()) throw disabledError();
  const pair = sshUtils.generateKeyPairSync('ed25519', { comment: 'ssh4ai-' + deviceName });
  return { pub: pair.public.trim(), priv: encSecret(pair.private) };
}

// Derive the public key line from a stored (encrypted) private key.
function publicFromStored(row) {
  const key = parsePrivateKey(decryptStored(row.private_key), row.key_passphrase ? decryptStored(row.key_passphrase) : '');
  return publicLine(key, 'ssh4ai-' + row.device_name);
}

// ssh2 connect options for a session (password mode is identical to before).
function buildSshOptions(session) {
  const o = { host: session.host, port: session.port, username: session.username };
  const mode = session.auth_type || 'password';
  if (mode === 'password') { o.password = session.password; o.tryKeyboard = true; return o; }
  o.privateKey = session.privateKey;
  if (session.passphrase) o.passphrase = session.passphrase;
  if (mode === 'key_password') { o.password = session.password; o.tryKeyboard = true; }
  return o;
}

module.exports = {
  AUTH_TYPES, keysEnabled, disabledError, parsePrivateKey, publicLine, keyFromBody, publicDevice,
  loadKey, generateKeyPair, publicFromStored, buildSshOptions,
};
