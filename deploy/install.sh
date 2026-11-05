#!/bin/sh
# ssh4ai installer for Linux/macOS. Creates ./ssh4ai with a compose file and a
# generated .env (random database password and encryption key), then starts it.
# Read it before you run it:  https://github.com/rosariosai/ssh4ai/blob/main/deploy/install.sh
set -eu

DIR="${SSH4AI_DIR:-ssh4ai}"
BASE="https://raw.githubusercontent.com/rosariosai/ssh4ai/main"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need docker
need curl
need openssl
docker compose version >/dev/null 2>&1 || { echo "Docker Compose plugin not found (docker compose)." >&2; exit 1; }

mkdir -p "$DIR"
cd "$DIR"

curl -fsSL "$BASE/docker-compose.hub.yml" -o docker-compose.yml

if [ -f .env ]; then
  echo ".env already exists, keeping it."
else
  umask 077
  cat > .env <<ENVEOF
PORT=7722
DB_USER=webssh
DB_NAME=webssh
DB_PASSWORD=$(openssl rand -hex 16)
ALLOWED_HOSTS=
ENCRYPTION_KEY=$(openssl rand -hex 32)
ENVEOF
  echo "Created .env with a random database password and encryption key."
fi

docker compose pull
docker compose up -d

echo
echo "ssh4ai is starting at http://localhost:7722"
echo "IMPORTANT: back up $(pwd)/.env (the ENCRYPTION_KEY inside it) somewhere safe."
echo "Without that key, saved device passwords cannot be recovered."
echo "The app has no login and is bound to localhost only. Do not expose it directly."
