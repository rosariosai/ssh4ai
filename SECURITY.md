# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version or commit.

This is a small hobby project maintained by one person. I will do my best to acknowledge a report within a week and to fix confirmed problems promptly, but I cannot promise a fixed timeline.

## Supported versions

Only the latest release on the `main` branch is supported.

## Known limitations (by design, not bugs)

These are documented so you can decide whether the tool fits your setup:

- **No authentication.** Anyone who can reach the port can use every saved device. Run it on localhost or behind an authenticating reverse proxy.
- **No TLS.** Terminate HTTPS at a reverse proxy.
- **SSH host keys are not verified**, so a man-in-the-middle between this server and a target would go unnoticed.
- **Password authentication only** (no SSH keys in this web version).
- **Device passwords are encrypted at rest** with AES-256-GCM using `ENCRYPTION_KEY`. Whoever holds both the database and that key can read them. Keep the key out of backups of the database.
- **Sessions are kept in memory.** A restart closes all open sessions.
- **No rate limiting** on the API.
- **The page loads xterm.js from the jsDelivr CDN.** If that matters to you, vendor the files locally.

## Using it with AI assistants

An assistant operating the terminal has the full permissions of the connected account and can see all output. Use a restricted account, review its commands, and never share secrets with it.
