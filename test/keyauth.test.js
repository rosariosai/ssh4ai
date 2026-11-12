'use strict';
// Unit tests for SSH key authentication helpers (keyauth.js). No database or SSH server needed.
process.env.ENCRYPTION_KEY = 'b'.repeat(64);

const test = require('node:test');
const assert = require('node:assert');
const { utils: sshUtils } = require('ssh2');
const { encryptPassword, decryptPassword } = require('../crypto');
const k = require('../keyauth');

const pair = sshUtils.generateKeyPairSync('ed25519', { comment: 'test' });
const encPair = sshUtils.generateKeyPairSync('ed25519', { comment: 'test', passphrase: 'secret-pass', cipher: 'aes256-ctr', rounds: 8 });

test('auth types', () => {
  assert.deepStrictEqual(k.AUTH_TYPES, ['password', 'key', 'key_password']);
  assert.strictEqual(k.keysEnabled(), true);
});

test('parsePrivateKey accepts an OpenSSH key and rejects garbage and public keys', () => {
  assert.ok(k.parsePrivateKey(pair.private));
  assert.throws(() => k.parsePrivateKey('not a key'), /Not a valid private key/);
  assert.throws(() => k.parsePrivateKey(pair.public), /valid private key|PRIVATE key/);
});

test('encrypted keys need the right passphrase', () => {
  assert.throws(() => k.parsePrivateKey(encPair.private, ''), /passphrase/i);
  assert.throws(() => k.parsePrivateKey(encPair.private, 'wrong'), /passphrase/i);
  assert.ok(k.parsePrivateKey(encPair.private, 'secret-pass'));
});

test('keyFromBody returns null when no key was sent', () => {
  assert.strictEqual(k.keyFromBody({}, 'h'), null);
  assert.strictEqual(k.keyFromBody({ private_key: '   ' }, 'h'), null);
});

test('keyFromBody stores the key encrypted and derives the public line', () => {
  const kp = k.keyFromBody({ private_key: pair.private }, 'host1');
  assert.ok(kp.priv.startsWith('enc1:'));
  assert.ok(!kp.priv.includes('BEGIN'));
  assert.strictEqual(kp.pass, null);
  assert.match(kp.pub, /^ssh-ed25519 \S+ ssh4ai-host1$/);
  assert.strictEqual(decryptPassword(kp.priv).trim(), pair.private.replace(/\r\n?/g, '\n').trim());
});

test('keyFromBody encrypts the passphrase too', () => {
  const kp = k.keyFromBody({ private_key: encPair.private, key_passphrase: 'secret-pass' }, 'h');
  assert.ok(kp.pass.startsWith('enc1:'));
  assert.strictEqual(decryptPassword(kp.pass), 'secret-pass');
});

test('loadKey round-trips and reports a missing key', () => {
  const kp = k.keyFromBody({ private_key: pair.private }, 'h');
  const got = k.loadKey({ private_key: kp.priv, key_passphrase: null });
  assert.ok(got.privateKey.includes('BEGIN OPENSSH PRIVATE KEY'));
  assert.throws(() => k.loadKey({ private_key: null }), /No private key stored/);
});

test('loadKey fails clearly when the encryption key changed', () => {
  const blob = encryptPassword(pair.private);
  const old = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'c'.repeat(64);
  try { assert.throws(() => k.loadKey({ private_key: blob }), /cannot be decrypted/); }
  finally { process.env.ENCRYPTION_KEY = old; }
});

test('generateKeyPair gives an encrypted private key and a public line that matches', () => {
  const g = k.generateKeyPair('h2');
  assert.ok(g.priv.startsWith('enc1:'));
  assert.match(g.pub, /^ssh-ed25519 \S+ ssh4ai-h2$/);
  assert.strictEqual(k.publicFromStored({ private_key: g.priv, key_passphrase: null, device_name: 'h2' }), g.pub);
});

test('buildSshOptions: password, key and key+password modes', () => {
  const base = { host: 'h', port: 22, username: 'u', password: 'pw', privateKey: 'KEY', passphrase: 'pp' };
  assert.deepStrictEqual(k.buildSshOptions({ ...base }), { host: 'h', port: 22, username: 'u', password: 'pw', tryKeyboard: true });
  const key = k.buildSshOptions({ ...base, auth_type: 'key' });
  assert.strictEqual(key.privateKey, 'KEY');
  assert.strictEqual(key.passphrase, 'pp');
  assert.strictEqual(key.password, undefined);
  const both = k.buildSshOptions({ ...base, auth_type: 'key_password' });
  assert.strictEqual(both.privateKey, 'KEY');
  assert.strictEqual(both.password, 'pw');
  assert.strictEqual(both.tryKeyboard, true);
});

test('publicDevice turns has_key into a boolean and never adds secrets', () => {
  assert.strictEqual(k.publicDevice({ id: 1, has_key: '1' }).has_key, true);
  assert.strictEqual(k.publicDevice({ id: 1, has_key: 0 }).has_key, false);
  const row = k.publicDevice({ id: 1 });
  assert.ok(!('private_key' in row) && !('key_passphrase' in row));
});
