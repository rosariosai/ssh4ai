'use strict';
// Request guards for a service that has no login of its own.
//
// 1. Host check  - blocks DNS-rebinding: a hostile website that points its own
//    domain at 127.0.0.1 would otherwise be able to talk to this server as
//    "same origin" and reach every saved device.
// 2. Origin check on the WebSocket upgrade - blocks cross-site WebSocket use.
// 3. Security headers (CSP, no framing, no sniffing).
//
// Allowed Host values: localhost, any IP address literal, and the names listed
// in ALLOWED_HOSTS (comma separated, hostnames only, no port) for use behind a
// reverse proxy, for example ALLOWED_HOSTS=ssh.example.com

const net = require('net');

function extraHosts() {
  return (process.env.ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

// "Example.com:7722" -> "example.com", "[::1]:7722" -> "::1"
function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : '';
  }
  return h.split(':')[0];
}

function hostnameAllowed(hostname, extra = extraHosts()) {
  if (!hostname) return false;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (net.isIP(hostname)) return true;      // an IP literal cannot be a rebound DNS name
  return extra.includes(hostname);
}

function originAllowed(origin, hostHeader, extra = extraHosts()) {
  if (!origin) return true;                 // non-browser clients send no Origin
  let u;
  try { u = new URL(origin); } catch { return false; }   // includes Origin: null
  if (u.host.toLowerCase() === String(hostHeader || '').toLowerCase()) return true;   // same origin
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || extra.includes(h);
}

function hostGuard(req, res, next) {
  if (hostnameAllowed(hostnameOf(req.headers.host))) return next();
  res.status(403).type('text/plain').send(
    'Host not allowed. If you reach this app through a domain name, add it to ALLOWED_HOSTS in .env.'
  );
}

// For new WebSocket({ verifyClient }) in the ws library.
function wsAllowed(req) {
  return hostnameAllowed(hostnameOf(req.headers.host)) &&
         originAllowed(req.headers.origin, req.headers.host);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = { hostnameOf, hostnameAllowed, originAllowed, hostGuard, wsAllowed, securityHeaders, CSP };
