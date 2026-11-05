# ssh4ai installer for Windows (PowerShell). Creates .\ssh4ai with a compose file
# and a generated .env (random database password and encryption key), then starts it.
# Read it before you run it: https://github.com/rosariosai/ssh4ai/blob/main/deploy/install.ps1
# Everything runs in its own scope (& { ... }) so the stricter error settings below
# do not leak into your PowerShell window when you start this with: irm ... | iex
& {
$ErrorActionPreference = "Stop"

$dir  = if ($env:SSH4AI_DIR) { $env:SSH4AI_DIR } else { "ssh4ai" }
$base = "https://raw.githubusercontent.com/rosariosai/ssh4ai/main"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker is not installed or not in PATH." }
$ErrorActionPreference = "Continue"
docker compose version 2>&1 | Out-Null
$ok = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = "Stop"
if (-not $ok) { throw "Docker Compose plugin not found (docker compose)." }

New-Item -ItemType Directory -Force $dir | Out-Null
Set-Location $dir

Invoke-WebRequest "$base/docker-compose.hub.yml" -OutFile "docker-compose.yml"

function New-HexSecret([int]$bytes) {
  $b = New-Object byte[] $bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  $rng.Dispose()
  -join ($b | ForEach-Object { $_.ToString("x2") })
}

if (Test-Path ".env") {
  Write-Host ".env already exists, keeping it."
} else {
  $envText = "PORT=7722`nDB_USER=webssh`nDB_NAME=webssh`nDB_PASSWORD=$(New-HexSecret 16)`nALLOWED_HOSTS=`nENCRYPTION_KEY=$(New-HexSecret 32)`n"
  [System.IO.File]::WriteAllText("$PWD\.env", $envText, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Created .env with a random database password and encryption key."
}

# Docker writes progress to stderr, which Windows PowerShell 5.1 would treat as an error
# under "Stop". Relax it for the docker calls and check the exit code instead.
$ErrorActionPreference = "Continue"
docker compose pull 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "docker compose pull failed." }
docker compose up -d 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "docker compose up failed." }

Write-Host ""
Write-Host "ssh4ai is starting at http://localhost:7722"
Write-Host "IMPORTANT: back up $PWD\.env (the ENCRYPTION_KEY inside it) somewhere safe."
Write-Host "Without that key, saved device passwords cannot be recovered."
Write-Host "The app has no login and is bound to localhost only. Do not expose it directly."
}
