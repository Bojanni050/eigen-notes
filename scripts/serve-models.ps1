<#
.SYNOPSIS
  Starts this stack's two model servers from a locally fetched llama.cpp build.

.DESCRIPTION
  Two processes, not one: llama.cpp serves one model per process and the
  embedding model has to run in embedding mode with CLS pooling — a chat server
  is not an embedding server. The ports are the same ones docker-compose.yml
  publishes, so .env needs no change when you switch between the two ways of
  running.

  Needs .\models (scripts\fetch-models.ps1) and runtime\llama-<tag>
  (scripts\fetch-llama-server.ps1). Ctrl-C stops both servers.

.EXAMPLE
  .\scripts\serve-models.ps1
#>
[CmdletBinding()]
param(
    [string]$Tag = $(if ($env:LLAMA_TAG) { $env:LLAMA_TAG } else { 'b12340' }),
    [int]$ChatPort = 11500,
    [int]$EmbedPort = 11501,
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$bin = Join-Path $here "runtime\llama-$Tag\llama-server.exe"
$models = if ($env:MODELS_DIR) { $env:MODELS_DIR } else { Join-Path $here 'models' }
$chatModel = Join-Path $models 'qwen2.5-3b-instruct-q4_k_m.gguf'
$embedModel = Join-Path $models 'bge-m3-Q8_0.gguf'
$runtime = Join-Path $here 'runtime'

if (-not (Test-Path $bin)) { Write-Error "missing $bin — run .\scripts\fetch-llama-server.ps1 first"; exit 1 }
if (-not (Test-Path $chatModel)) { Write-Error "missing $chatModel — run .\scripts\fetch-models.ps1 (or set MODELS_DIR)"; exit 1 }
if (-not (Test-Path $embedModel)) { Write-Error "missing $embedModel — run .\scripts\fetch-models.ps1 (or set MODELS_DIR)"; exit 1 }

New-Item -ItemType Directory -Force -Path $runtime | Out-Null

function Start-LlamaServer {
    param([string[]]$Arguments, [string]$LogName)
    $out = Join-Path $runtime "$LogName.log"
    $err = Join-Path $runtime "$LogName.err.log"
    $p = Start-Process -FilePath $bin -ArgumentList $Arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err
    Write-Host "== $LogName started (pid $($p.Id)), log: $out"
    return $p
}

function Wait-ForServer {
    param([int]$Port, [string]$Name, [int]$Seconds, [System.Diagnostics.Process]$Process)
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            Write-Error "$Name exited with code $($Process.ExitCode) — see runtime\llama-*.log"
            return $false
        }
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 2
            Write-Host "== $Name is up on port $Port"
            return $true
        }
        catch {
            Start-Sleep -Seconds 1
        }
    }
    Write-Error "$Name did not come up on port $Port within $Seconds s — see runtime\llama-*.log"
    return $false
}

# One model per process, each with the flags that fit it: --jinja for the chat
# model's tool/JSON handling, --embeddings --pooling cls for bge-m3, whose
# sentence vectors are what the app compares.
$chat = Start-LlamaServer -LogName 'llama-chat' -Arguments @(
    '-m', $chatModel, '--host', '127.0.0.1', '--port', "$ChatPort", '--ctx-size', '8192', '--jinja'
)
$embed = Start-LlamaServer -LogName 'llama-embed' -Arguments @(
    '-m', $embedModel, '--host', '127.0.0.1', '--port', "$EmbedPort", '--ctx-size', '8192', '--embeddings', '--pooling', 'cls'
)

try {
    # Wait before the app starts: a silent start would send it into provider
    # errors instead of saying "the model server is not up yet".
    if (-not (Wait-ForServer -Port $ChatPort -Name 'chat' -Seconds $TimeoutSeconds -Process $chat)) { exit 1 }
    if (-not (Wait-ForServer -Port $EmbedPort -Name 'embed' -Seconds $TimeoutSeconds -Process $embed)) { exit 1 }

    Write-Host '== both servers are running; start the app with: npm run start:local'
    Write-Host '== Ctrl-C stops them'
    Wait-Process -Id $chat.Id, $embed.Id
}
finally {
    foreach ($p in @($chat, $embed)) {
        if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    }
}
