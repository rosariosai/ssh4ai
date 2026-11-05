# ssh4ai

A small, self-hosted SSH terminal manager that runs in your browser. Save your servers once, open them in tabs with a double-click, and keep your commands and notes next to the terminal. **SSH for AI**: a plain, predictable interface that is easy for a person and for a browser-driving assistant such as Claude in Chrome.

Source, docs and issues: https://github.com/rosariosai/ssh4ai (MIT)

## Quick start

Needs Docker with the Compose plugin. This starts the app and its own MariaDB.

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/rosariosai/ssh4ai/main/deploy/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/rosariosai/ssh4ai/main/deploy/install.ps1 | iex
```

Then open http://localhost:7722. The script creates a `.env` with a random database password and `ENCRYPTION_KEY`. **Back up that file**: without the key, saved device passwords cannot be recovered.

## Manual run

Use `docker-compose.hub.yml` from the repository, create a `.env` from `.env.example`, then:

```bash
docker compose up -d
```

## Tags

- `latest`, `1.0.x`, `1.0`: release versions
- `sha-xxxxxxx`: a specific commit

Images are built for `linux/amd64` and `linux/arm64`.

## Security (read before exposing it)

- **There is no login.** Anyone who can reach the port can use every saved device. The compose file publishes the port on `127.0.0.1` only. Put an authenticating reverse proxy with HTTPS in front before exposing it, and set `ALLOWED_HOSTS=your.domain`.
- SSH server host keys are not verified, and only password login is supported.
- Device passwords are encrypted at rest (AES-256-GCM) with your `ENCRYPTION_KEY`.
- An AI assistant driving the terminal has the permissions of the account you connect with. Use a limited account and review what it runs.

See SECURITY.md in the repository for details.
