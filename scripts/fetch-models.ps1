<#
.SYNOPSIS
  Downloads this stack's two GGUF models into .\models.

.DESCRIPTION
  The Docker path does this in a one-shot container (docker-compose.yml, the
  `models` service). This is the same job without Docker, for a native run:
  idempotent, so running it twice costs nothing.

  Models are fetched from their published sources, not bundled: 2.5 GB in a
  repository nobody wants.

.EXAMPLE
  .\scripts\fetch-models.ps1
#>
[CmdletBinding()]
param(
    [string]$ModelsDir = $(if ($env:MODELS_DIR) { $env:MODELS_DIR } else { Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) 'models' })
)

$ErrorActionPreference = 'Stop'

$models = @(
    @{ File = 'qwen2.5-3b-instruct-q4_k_m.gguf'; Url = 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf' },
    @{ File = 'bge-m3-Q8_0.gguf';                Url = 'https://huggingface.co/gpustack/bge-m3-GGUF/resolve/main/bge-m3-Q8_0.gguf' }
)

New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null

foreach ($m in $models) {
    $target = Join-Path $ModelsDir $m.File
    if ((Test-Path $target) -and ((Get-Item $target).Length -gt 0)) {
        Write-Host "== have $($m.File)"
        continue
    }

    Write-Host "== downloading $($m.File)"
    $part = "$target.part"
    # curl.exe ships with Windows 10 1803+ and is far quicker than
    # Invoke-WebRequest on a 2 GB file; fall back when it is not there.
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    try {
        if ($curl) {
            & $curl.Source --fail --location --retry 3 --retry-delay 5 -o $part $m.Url
            if ($LASTEXITCODE -ne 0) { throw "curl exited with $LASTEXITCODE" }
        }
        else {
            $ProgressPreference = 'SilentlyContinue'
            Invoke-WebRequest -Uri $m.Url -OutFile $part -UseBasicParsing
        }
    }
    catch {
        Remove-Item $part -Force -ErrorAction SilentlyContinue
        Write-Error "could not download $($m.Url)`n$($_.Exception.Message)"
        exit 1
    }
    # Rename only a complete file: a half-downloaded .part can never be mistaken
    # for a model, which is exactly how a broken install gets hard to explain.
    Move-Item $part $target -Force
    Write-Host "== done $($m.File)"
}

Get-ChildItem $ModelsDir | Format-Table Name, @{ Label = 'GB'; Expression = { [math]::Round($_.Length / 1GB, 2) } }
Write-Host '== models ready'
