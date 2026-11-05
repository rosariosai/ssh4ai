# ssh4ai installer for Windows (PowerShell). Creates .\ssh4ai with a compose file
# and a generated .env (random database password and encryption key), then starts it.
# Read it before you run it: https://github.com/rosariosai/ssh4ai/blob/main/deploy/install.ps1
$ErrorActionPreference = "Stop"

$dir  = if ($env:SSH4AI_DIR) { $env:SSH4AI_DIR } else { "ssh4ai" }
$base = "https://raw.githubusercontent.com/rosariosai/ssh4ai/main"

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker is not installed or not in PATH." }
docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Docker Compose plugin not found (docker compose)." }

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

docker compose pull
docker compose up -d

Write-Host ""
Write-Host "ssh4ai is starting at http://localhost:7722"
Write-Host "IMPORTANT: back up $PWD\.env (the ENCRYPTION_KEY inside it) somewhere safe."
Write-Host "Without that key, saved device passwords cannot be recovered."
Write-Host "The app has no login and is bound to localhost only. Do not expose it directly."
