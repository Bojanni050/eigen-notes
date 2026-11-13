<#
.SYNOPSIS
  Runs eigen-notes on Windows with nothing installed but Node 22.

.DESCRIPTION
  One command, start to finish: check Node, install the app's four dependencies,
  write a .env with a token of its own, download the two models and a llama.cpp
  build, start both model servers, and run the app on the app's own database.

  The database is PGlite: Postgres compiled to wasm, in .\data\pglite. That is
  what makes this a download-and-run instead of an install Postgres first. Only
  the two model servers are separate processes — the same ones the Docker path
  starts, just without Docker.

  Everything it downloads is skipped when it is already there, so a second run is
  quick.

.EXAMPLE
  .\start-windows.ps1
  .\start-windows.ps1 -Port 8900 -SkipModels
#>
[CmdletBinding()]
param(
    [int]$Port = 8899,
    [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Step($message) { Write-Host "`n=== $message" -ForegroundColor Cyan }

Step 'Node 22 or newer'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'Node is not on PATH. Install the LTS build (22 or newer) from https://nodejs.org/en/download' -ForegroundColor Yellow
    Write-Host 'then run this script again.'
    exit 1
}
$version = (& node -v).TrimStart('v')
if ([int]($version.Split('.')[0]) -lt 22) {
    Write-Host "Node $version is too old: the app uses node --test, --env-file-if-exists and ESM without a build step." -ForegroundColor Yellow
    Write-Host 'Install Node 22 or newer from https://nodejs.org/en/download and run this script again.'
    exit 1
}
Write-Host "== node $version"

Step 'Dependencies'
if (Test-Path (Join-Path $here 'node_modules')) {
    Write-Host '== node_modules already present'
}
else {
    & npm ci
    if ($LASTEXITCODE -ne 0) { Write-Error 'npm ci failed'; exit 1 }
}

Step '.env'
$envFile = Join-Path $here '.env'
if (Test-Path $envFile) {
    Write-Host '== .env already present, leaving it alone'
}
else {
    # Generate the token rather than shipping a known one: the API is fail-closed
    # without it, and "change this later" never happens.
    $bytes = New-Object byte[] 24
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $token = [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')

    $lines = Get-Content (Join-Path $here '.env.example')
    $lines = $lines | ForEach-Object {
        if ($_ -match '^DB_BACKEND=') { 'DB_BACKEND=pglite' }
        elseif ($_ -match '^DB_DIR=') { 'DB_DIR=./data/pglite' }
        elseif ($_ -match '^NOTES_TOKEN=') { "NOTES_TOKEN=$token" }
        elseif ($_ -match '^API_PORT=') { "API_PORT=$Port" }
        else { $_ }
    }
    Set-Content -Path $envFile -Value $lines -Encoding utf8
    Write-Host "== wrote $envFile (database: pglite, token generated)"
}

Step 'Models'
if ($SkipModels) { Write-Host '== skipped (-SkipModels)' } else { & (Join-Path $here 'scripts\fetch-models.ps1') }

Step 'llama.cpp'
& (Join-Path $here 'scripts\fetch-llama-server.ps1')

Step 'Model servers'
$tag = if ($env:LLAMA_TAG) { $env:LLAMA_TAG } else { 'b12340' }
$bin = Join-Path $here "runtime\llama-$tag\llama-server.exe"
if (-not (Test-Path $bin)) { Write-Error "no llama-server.exe found under runtime\ — run .\scripts\fetch-llama-server.ps1"; exit 1 }

$models = Join-Path $here 'models'
$runtime = Join-Path $here 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

function Start-Llama([string[]]$Arguments, [string]$Name) {
    $p = Start-Process -FilePath $bin -ArgumentList $Arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime "$Name.log") `
        -RedirectStandardError (Join-Path $runtime "$Name.err.log")
    Write-Host "== $Name started (pid $($p.Id))"
    return $p
}

function Wait-For([int]$P, [string]$Name, [System.Diagnostics.Process]$Process) {
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) { Write-Error "$Name exited with $($Process.ExitCode) — see runtime\$Name.err.log"; return $false }
        try { $null = Invoke-WebRequest -Uri "http://127.0.0.1:$P/health" -UseBasicParsing -TimeoutSec 2; Write-Host "== $Name is up"; return $true }
        catch { Start-Sleep -Seconds 1 }
    }
    Write-Error "$Name did not come up on port $P — see runtime\$Name.err.log"
    return $false
}

$chat = Start-Llama -Name 'llama-chat' -Arguments @(
    '-m', (Join-Path $models 'qwen2.5-3b-instruct-q4_k_m.gguf'), '--host', '127.0.0.1', '--port', '11500', '--ctx-size', '8192', '--jinja'
)
$embed = Start-Llama -Name 'llama-embed' -Arguments @(
    '-m', (Join-Path $models 'bge-m3-Q8_0.gguf'), '--host', '127.0.0.1', '--port', '11501', '--ctx-size', '8192', '--embeddings', '--pooling', 'cls'
)

try {
    if (-not (Wait-For -P 11500 -Name 'chat' -Process $chat)) { exit 1 }
    if (-not (Wait-For -P 11501 -Name 'embed' -Process $embed)) { exit 1 }

    Step "The app on http://127.0.0.1:$Port"
    Write-Host '== Ctrl-C stops the app and both model servers'
    & node --env-file-if-exists=.env src/http/server.js
}
finally {
    foreach ($p in @($chat, $embed)) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
}
