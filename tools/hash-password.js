#!/usr/bin/env node
// Makes the APP_PASSWORD_HASH value for the web login.
//   node tools/hash-password.js            (prompts for the password, input hidden)
//   printf '%s' "$PW" | node tools/hash-password.js     (reads it from stdin)
// Output: scrypt:N:r:p:salt:hash  (no "$", safe to paste into docker compose / .env)
// Parameters: N=2^17, r=8, p=1 (OWASP minimum for scrypt). Keep it in sync with access.js.
const crypto = require('crypto');
const readline = require('readline');

const N = 131072, r = 8, p = 1;

function hashIt(pw) {
  if (!pw) { console.error('Empty password.'); process.exit(1); }
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r });
  console.log(['scrypt', N, r, p, salt.toString('base64url'), key.toString('base64url')].join(':'));
}

if (!process.stdin.isTTY) {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => hashIt(data.replace(/\r?\n$/, '')));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const ask = (q) => new Promise((res) => {
    rl._writeToOutput = (s) => { if (s.includes(q)) process.stderr.write(s); };   // hide what is typed
    rl.question(q, (a) => { process.stderr.write('\n'); res(a); });
  });
  (async () => {
    const a = await ask('Password: ');
    const b = await ask('Repeat:   ');
    rl.close();
    if (a !== b) { console.error('Passwords do not match.'); process.exit(1); }
    if (a.length < 12) { console.error('Use at least 12 characters.'); process.exit(1); }
    hashIt(a);
  })();
}
