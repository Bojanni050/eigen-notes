<#
.SYNOPSIS
  Fetches a llama.cpp Windows build into runtime\llama-<tag>\.

.DESCRIPTION
  One binary plus a GGUF file is all a model server needs, which is why this app
  uses llama.cpp instead of a daemon with its own model registry. The tag is
  pinned on purpose: the app was tested against one release, not against
  "latest".

  -Variant picks a faster build where one exists (vulkan, cuda-13.5, cuda-12.4,
  sycl). The default CPU build is the one that always works.

.EXAMPLE
  .\scripts\fetch-llama-server.ps1
  .\scripts\fetch-llama-server.ps1 -Variant vulkan
#>
[CmdletBinding()]
param(
    [string]$Tag = $(if ($env:LLAMA_TAG) { $env:LLAMA_TAG } else { 'b12340' }),
    [string]$Variant = $(if ($env:LLAMA_VARIANT) { $env:LLAMA_VARIANT } else { 'cpu' })
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $here "runtime\llama-$Tag"
$exe = Join-Path $dest 'llama-server.exe'

if (Test-Path $exe) {
    Write-Host "== already have $exe"
}
else {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $asset = if ($Variant -eq 'cpu') { "llama-$Tag-bin-win-cpu-$arch.zip" } else { "llama-$Tag-bin-win-$Variant-$arch.zip" }
    if ($env:LLAMA_ASSET) { $asset = $env:LLAMA_ASSET }

    Write-Host "== downloading $asset"
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $zip = Join-Path $dest '.download.zip'
    $url = "https://github.com/ggml-org/llama.cpp/releases/download/$Tag/$asset"
    try {
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    catch {
        Write-Error "could not download $url`n$($_.Exception.Message)"
        exit 1
    }
    Expand-Archive -Path $zip -DestinationPath $dest -Force
    Remove-Item $zip -Force

    # These archives put everything at the root of the zip (verified against
    # b12340). If a release ever nests it, move the files up instead of leaving
    # a path nobody can guess.
    if (-not (Test-Path $exe)) {
        $inner = Get-ChildItem $dest -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName 'llama-server.exe') } |
            Select-Object -First 1
        if ($inner) {
            Get-ChildItem $inner.FullName | Move-Item -Destination $dest -Force
            Remove-Item $inner.FullName -Recurse -Force
        }
    }
    if (-not (Test-Path $exe)) {
        Write-Error "no llama-server.exe after extracting $asset"
        exit 1
    }
    Write-Host "== extracted into $dest"
}

# Say out loud that the binary runs here, so a wrong architecture fails now
# instead of at first use.
Write-Host '== version:'
& $exe --version | Select-Object -First 3
Write-Host '== done. Start the servers with: .\scripts\serve-models.ps1'
