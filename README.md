# ssh4ai

A small, self-hosted SSH terminal manager that runs in your browser. Save your servers once, open them in tabs with a double-click, and keep your commands and notes next to the terminal. The Windows twin is [ssh4ai-windows](https://github.com/rosariosai/ssh4ai-windows), also available from the [Microsoft Store](https://apps.microsoft.com/detail/9np25s5l8ck2).

The name means **SSH for AI**: the interface is deliberately plain and predictable, so it is easy for a person to use and easy for a browser-driving AI assistant (for example Claude in Chrome) to operate. There is no built-in AI integration and no MCP server; see [Using it with an AI assistant](#using-it-with-an-ai-assistant) before you give an assistant access to a live shell.

It runs as one Node.js service backed by MariaDB. No accounts, no telemetry. The only third-party request the page makes is loading the xterm.js terminal library from the jsDelivr CDN.

<!-- Add a screenshot here: docs/screenshot.png, using demo hosts only. -->

## Features

- **Multi-tab SSH terminal** ([xterm.js](https://xtermjs.org/)), several sessions at once
- **Device manager**: save SSH targets (host, port, username, password or key) and connect with a double-click
- **Per-host login method**: password, private key, or key with password fallback. Paste a key, load it from a file, or generate an ed25519 key pair and copy the public key (see [SSH keys](#ssh-keys)). Servers that use keyboard-interactive login, such as ESXi, work too
- **Pin and reorder** hosts, filter to pinned only; the order is saved
- **Quick Command macros**: 5 programmable buttons, lockable, optional auto-Enter
- **Scratchpad**: 5 persistent text buckets with 3 layouts
- **Web Links dock**: 4 launcher buttons (slot 1 is a placeholder named "Presidio" pointing to example.com; edit it to anything you like)
- **Copy / Save log** with terminal escape codes stripped
- **Passwords and private keys encrypted at rest** with AES-256-GCM, using a key only you hold
- **Optional login and IP allowlist**, both off by default (see [Login and IP allowlist](#login-and-ip-allowlist-optional))

## Quick start (Docker Compose)

Requires Docker with the Compose plugin. This starts the app and its own MariaDB.

```bash
git clone https://github.com/rosariosai/ssh4ai.git
cd ssh4ai

cp .env.example .env
# 1) set DB_PASSWORD to a long random value
# 2) generate and set ENCRYPTION_KEY:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

docker compose up -d --build
```

Open <http://localhost:7722>. The tables are created on first start.

The port is published on `127.0.0.1` only, on purpose: the app has no login unless you switch one on (see [Security](#security)). Turn on the built-in login, or put an authenticating reverse proxy in front, before you expose it to other machines.

## Quick start (prebuilt image)

No clone and no build. This pulls the published image (`ghcr.io/rosariosai/ssh4ai`, also on [Docker Hub](https://hub.docker.com/r/sareju74/ssh4ai) as `sareju74/ssh4ai`), creates a `.env` with a random database password and encryption key, and starts everything. Read [the script](deploy/install.sh) first if you like.

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/rosariosai/ssh4ai/main/deploy/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rosariosai/ssh4ai/main/deploy/install.ps1 | iex
```

To use the Docker Hub copy instead of GitHub's, add `SSH4AI_IMAGE=sareju74/ssh4ai:latest` to `.env`, or just run `docker pull sareju74/ssh4ai`.

Open <http://localhost:7722>. **Back up the generated `.env`**: the `ENCRYPTION_KEY` in it is the only way to recover saved device passwords. Images are built for amd64 and arm64.

## Run without Docker

You need Node.js 18 or newer and a reachable MariaDB/MySQL database with a user that can create tables.

```bash
cp .env.example .env     # set DB_HOST, DB_USER, DB_PASSWORD, DB_NAME and ENCRYPTION_KEY
npm install
npm start
```

## Configuration

Everything is set in `.env` (see `.env.example`).

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (7722) | Port the app listens on |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` | set them explicitly | MariaDB connection. The built-in defaults are placeholders. |
| `DB_PASSWORD` | yes | MariaDB password. No default. |
| `ALLOWED_HOSTS` | only behind a proxy | Comma-separated hostnames (no port) the app may be reached by, besides localhost and IP addresses |
| `ENCRYPTION_KEY` | yes | 64 hex characters (32 bytes) that encrypt device passwords and private keys. The app refuses to start without it. |
| `APP_PASSWORD_HASH` | no | Turns the shared-password login on. Make the value with `node tools/hash-password.js`. Beats a password set in the Security panel. |
| `ALLOWED_CIDRS` | no | Comma-separated IPs or CIDR ranges allowed to reach the app. Empty means no restriction. |
| `TRUSTED_PROXIES` | with a proxy | IPs or ranges of your reverse proxy, so the real client address is read from `X-Forwarded-For`. Needed for `ALLOWED_CIDRS` behind a proxy. |
| `ALLOWED_ORIGINS` | no | Extra browser origins (for example `https://ssh.example.org`) allowed to use the app. The same host is always allowed. |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS` | no (30, 12) | Login session timeouts |
| `COOKIE_SECURE` | no (`auto`) | `auto`, `always` or `never` for the login cookie's Secure flag |
| `ACCESS_RESET` | recovery only | Set to `1` for one start to clear the login and allowlist saved from the Security panel (see [Locked out?](#locked-out)) |

Back up `ENCRYPTION_KEY` separately from the database. If you lose it, the saved device passwords and private keys cannot be recovered.

## SSH keys

In **Edit Host**, choose the login method:

- **Password**: as before.
- **Private key**: paste a key, load it from a file, or click **Generate key pair** (ed25519). The public key is shown with a copy button: add that line to `~/.ssh/authorized_keys` on the server.
- **Key + password fallback**: tries the key first, then the password.

Supported keys: OpenSSH or PEM RSA, ed25519 and ECDSA, with or without a passphrase. Keys and passphrases are encrypted with `ENCRYPTION_KEY`, are never sent back to the browser, and are never written to the log. When you edit a host, leave the key empty to keep the stored one. Upgrading from 1.0.x needs nothing: the new database columns are added at start and existing hosts keep using their password.

## Login and IP allowlist (optional)

Both are **off by default**, so an upgrade changes nothing until you switch them on. Open **Settings > Security**, or set the variables above.

- **Login**: one shared password (no user accounts). Sessions expire after 30 minutes idle or 12 hours in total, wrong passwords are slowed down, and the terminal WebSocket needs a valid session. Set it in the panel, or put `APP_PASSWORD_HASH` in `.env` (the environment value wins over the panel); with Docker you can make the hash with `docker compose exec app node tools/hash-password.js`.
- **IP allowlist**: only the listed IPs or CIDR ranges can reach the app at all (pages, API and terminal). Behind a reverse proxy, also set `TRUSTED_PROXIES`, otherwise every client looks like the proxy. The panel shows the address it sees for you, so you can add it before you switch the list on.
- **Origin check**: while either feature is on, requests that change data and WebSocket connections must come from the app's own origin (add others with `ALLOWED_ORIGINS`).

This is a deliberately small protection for a self-hosted tool, not a replacement for HTTPS and a proper reverse proxy.

### Locked out?

If you saved a wrong allowlist or forgot the password: add `ACCESS_RESET: "1"` to the `app` service in your compose file (or `ACCESS_RESET=1` to `.env`), restart once, and the login and allowlist saved from the panel are cleared. Remove the setting again afterwards. Values set through `APP_PASSWORD_HASH` and `ALLOWED_CIDRS` are not saved in the database; change those in `.env`.

## Security

Read this before you expose anything beyond your own machine. See also [SECURITY.md](SECURITY.md).

- **There is no login unless you switch one on.** Out of the box, anyone who can reach the port can open every saved device. Keep it on localhost or a trusted network, or turn on the built-in login, or put it behind a reverse proxy that authenticates (basic auth, Authentik, Authelia, and so on). Never expose the port directly to the internet.
- **No TLS.** Use a reverse proxy with HTTPS and WebSocket support.
- **Host and Origin checks.** To defeat DNS-rebinding and cross-site WebSocket attacks, the server only answers requests whose Host is `localhost`, an IP address, or a name listed in `ALLOWED_HOSTS` (see `.env.example`), and it rejects WebSocket connections from other origins. Behind a reverse proxy, set `ALLOWED_HOSTS=your.domain` or you will get "Host not allowed".
- **Security headers.** A Content-Security-Policy, `X-Frame-Options: DENY` and `nosniff` are sent with every response.
- **SSH server host keys are not verified.** A man-in-the-middle on the path to a server would not be detected. Use it on networks you trust.
- **Passwords and private keys are encrypted at rest** (AES-256-GCM, key from `ENCRYPTION_KEY`). A decrypted secret only lives in server memory while a connection is active and is never sent to the browser. Older rows saved as plaintext keep working and are encrypted the next time you save that device.
- **Root logins.** `PermitRootLogin no` or `prohibit-password` on the server blocks root logins; connect as a normal user with `sudo` instead of loosening that setting. Key login works with `prohibit-password`.

## Using it with an AI assistant

An assistant that types into your terminal has exactly the permissions of the account you connected with. If you let one drive ssh4ai:

- connect with a limited, non-root account, ideally one that can only read;
- keep a person in the loop for anything that changes or deletes data, and read what it ran;
- never paste passwords, keys or tokens into the chat;
- remember that terminal output may contain secrets and is visible to the assistant.

## How it works

```
Browser (xterm.js)
    <-> WebSocket
Express + ws server (server.js)
    <-> ssh2  ->  SSH to your devices
    <-> MariaDB (devices, macros, buckets; passwords encrypted)
```

`POST /api/connect/:deviceId` creates a session and returns a `sessionId`. The browser then opens a WebSocket and sends `{ "type": "attach", "sessionId": "..." }`. Terminal input and output travel over that socket.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Run the tests with `npm test`. They cover the host and origin guards, the login and allowlist, and the key-authentication helpers; more are welcome.

## License

MIT, see [LICENSE](LICENSE).

## Story behind it

Why I built ssh4ai and how it works with Claude: [I built a tool so Claude could work on my servers](https://rosariosai.substack.com/p/i-built-a-tool-so-claude-could-work) (The Daily Calf).

