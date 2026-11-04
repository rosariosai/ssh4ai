'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { hostnameOf, hostnameAllowed, originAllowed, hostGuard, wsAllowed, securityHeaders, CSP } = require('../security');

test('hostnameOf strips port and handles IPv6', () => {
  assert.strictEqual(hostnameOf('Example.com:7722'), 'example.com');
  assert.strictEqual(hostnameOf('localhost'), 'localhost');
  assert.strictEqual(hostnameOf('[::1]:7722'), '::1');
  assert.strictEqual(hostnameOf(''), '');
  assert.strictEqual(hostnameOf(undefined), '');
});

test('local names and IP literals are allowed', () => {
  for (const h of ['localhost', 'app.localhost', '127.0.0.1', '192.0.2.10', '::1']) {
    assert.strictEqual(hostnameAllowed(h, []), true, h);
  }
});

test('other names are rejected unless listed (DNS rebinding)', () => {
  assert.strictEqual(hostnameAllowed('evil.example', []), false);
  assert.strictEqual(hostnameAllowed('', []), false);
  assert.strictEqual(hostnameAllowed('ssh.example.com', ['ssh.example.com']), true);
  assert.strictEqual(hostnameAllowed('localhost.evil.example', []), false);
});

test('origin check', () => {
  assert.strictEqual(originAllowed(undefined, 'localhost:7722', []), true);
  assert.strictEqual(originAllowed('http://localhost:7722', 'localhost:7722', []), true);
  assert.strictEqual(originAllowed('http://192.0.2.10:7722', '192.0.2.10:7722', []), true);
  assert.strictEqual(originAllowed('https://evil.example', 'localhost:7722', []), false);
  assert.strictEqual(originAllowed('null', 'localhost:7722', []), false);
  assert.strictEqual(originAllowed('not a url', 'localhost:7722', []), false);
  assert.strictEqual(originAllowed('https://ssh.example.com', 'proxy:7722', ['ssh.example.com']), true);
});

test('hostGuard answers 403 for a foreign Host and passes localhost', () => {
  let status = null, called = false;
  const res = { status(c) { status = c; return this; }, type() { return this; }, send() { return this; } };
  hostGuard({ headers: { host: 'evil.example:7722' } }, res, () => { called = true; });
  assert.strictEqual(status, 403);
  assert.strictEqual(called, false);
  hostGuard({ headers: { host: 'localhost:7722' } }, res, () => { called = true; });
  assert.strictEqual(called, true);
});

test('wsAllowed needs both a good Host and a good Origin', () => {
  assert.strictEqual(wsAllowed({ headers: { host: 'localhost:7722', origin: 'http://localhost:7722' } }), true);
  assert.strictEqual(wsAllowed({ headers: { host: 'localhost:7722', origin: 'https://evil.example' } }), false);
  assert.strictEqual(wsAllowed({ headers: { host: 'evil.example', origin: 'http://evil.example' } }), false);
  assert.strictEqual(wsAllowed({ headers: { host: 'localhost:7722' } }), true);
});

test('securityHeaders sets CSP and friends', () => {
  const set = {};
  securityHeaders({ path: '/api/devices' }, { setHeader: (k, v) => { set[k] = v; } }, () => {});
  assert.strictEqual(set['Content-Security-Policy'], CSP);
  assert.strictEqual(set['X-Frame-Options'], 'DENY');
  assert.strictEqual(set['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(set['Cache-Control'], 'no-store');
  assert.ok(!CSP.includes("script-src 'self' 'unsafe-inline'"));
});
