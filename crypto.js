// ════════════════════════════════════════════════════════════════════
//  Password encryption at rest (AES-256-GCM)
//
//  SSH device passwords are stored in MariaDB. Historically they were
//  stored in plaintext — fine for a private LAN tool, not something we
//  want to hand out as the default in a public repo. This module
//  encrypts them with a key you control (ENCRYPTION_KEY in .env),
//  never committed, never the same across deployments.
//
//  Format stored in the DB: "enc1:<iv>:<authTag>:<ciphertext>" (all
//  base64). The "enc1:" prefix is how we tell an encrypted value apart
//  from a legacy plaintext password — anything without that prefix is
//  treated as plaintext and used as-is, so existing installs upgrading
//  to this version keep working without a forced migration. Passwords
//  get encrypted automatically the next time each device is saved.
// ════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

const ALGO   = 'aes-256-gcm';
const PREFIX = 'enc1:';

function getKey() {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY is missing or invalid in .env — it must be a 64-character hex string (32 bytes).\n' +
      '  Generate one with:\n' +
      '    node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      '  then add it to .env as ENCRYPTION_KEY=<the value>\n' +
      '  Keep this key secret and back it up — losing it makes every stored device password unrecoverable.'
    );
  }
  return Buffer.from(key, 'hex');
}

function encryptPassword(plaintext) {
  if (!plaintext) return '';
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map((b) => b.toString('base64')).join(':');
}

function decryptPassword(stored) {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext, unmigrated row

  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) return stored; // malformed, don't crash the connect flow

  try {
    const [iv, tag, enc] = parts.map((b) => Buffer.from(b, 'base64'));
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('Failed to decrypt stored password — ENCRYPTION_KEY may have changed since this device was saved.');
  }
}

module.exports = { encryptPassword, decryptPassword };
