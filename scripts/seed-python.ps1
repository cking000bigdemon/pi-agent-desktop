<#
.SYNOPSIS
  Provision the bundled Python runtime at vendor/python with ppt-master's
  dependencies pre-installed, so the packaged app runs Python skills with ZERO
  system dependency and ZERO runtime pip install (offline).

.DESCRIPTION
  1. Downloads a relocatable python-build-standalone "install_only" Windows
     build (default mirror: npmmirror; falls back to GitHub).
  2. Extracts it to vendor/python (contains python.exe + pip + venv + stdlib).
  3. pip-installs scripts/vendor-python-requirements.txt into it (via a PyPI
     mirror for speed).

  Idempotent: skips re-download/extract if vendor/python already exists unless
  -Force. Mirrors the vendor/node provisioning model — vendor/ is gitignored and
  shipped into resources/python by electron-builder.

.EXAMPLE
  npm run seed:python
  powershell -ExecutionPolicy Bypass -File scripts/seed-python.ps1 -Force
#>
[CmdletBinding()]
param(
  [string]$PyVersion = "3.12.13",
  [string]$PbsTag    = "20260623",
  [string]$Mirror    = "https://registry.npmmirror.com/-/binary/python-build-standalone",
  [string]$GithubBase= "https://github.com/astral-sh/python-build-standalone/releases/download",
  [string]$PipIndex  = "https://pypi.tuna.tsinghua.edu.cn/simple",
  [switch]$Force
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo      = Split-Path -Parent $PSScriptRoot
$vendorDir = Join-Path $repo "vendor"
$pyDir     = Join-Path $vendorDir "python"
$pyExe     = Join-Path $pyDir "python.exe"
$asset     = "cpython-$PyVersion+$PbsTag-x86_64-pc-windows-msvc-install_only.tar.gz"
$reqFile   = Join-Path $PSScriptRoot "vendor-python-requirements.txt"

function Info($m) { Write-Host "[seed:python] $m" -ForegroundColor Cyan }

if ((Test-Path $pyExe) -and -not $Force) {
  Info "vendor/python already present ($pyExe). Use -Force to re-provision. Skipping download."
} else {
  if (Test-Path $pyDir) { Info "removing existing $pyDir"; Remove-Item -Recurse -Force $pyDir }
  New-Item -ItemType Directory -Force -Path $vendorDir | Out-Null
  $tmp = Join-Path $env:TEMP $asset

  $urls = @("$Mirror/$PbsTag/$asset", "$GithubBase/$PbsTag/$asset")
  $ok = $false
  foreach ($u in $urls) {
    Info "downloading $u"
    # curl.exe (Win10+) is far more TLS-robust here than Invoke-WebRequest.
    & curl.exe -fSL --retry 3 --retry-delay 2 --connect-timeout 20 -o $tmp $u
    if ($LASTEXITCODE -eq 0 -and (Test-Path $tmp) -and (Get-Item $tmp).Length -gt 1MB) { $ok = $true; break }
    Info "  failed from this source, trying next..."
  }
  if (-not $ok) { throw "Could not download $asset from any source." }
  Info "downloaded $([math]::Round((Get-Item $tmp).Length/1MB,1)) MB"

  Info "extracting to $vendorDir (install_only build unpacks to python/)"
  & tar.exe -xzf $tmp -C $vendorDir
  if ($LASTEXITCODE -ne 0) { throw "tar extraction failed" }
  Remove-Item -Force $tmp -ErrorAction SilentlyContinue
  if (-not (Test-Path $pyExe)) { throw "extraction did not yield $pyExe" }
}

Info "python: $(& $pyExe --version)"

Info "upgrading pip"
& $pyExe -m pip install --upgrade pip --index-url $PipIndex --quiet

Info "installing ppt-master deps from $reqFile (index: $PipIndex)"
& $pyExe -m pip install -r $reqFile --index-url $PipIndex
if ($LASTEXITCODE -ne 0) { throw "pip install of vendor-python-requirements failed" }

Info "verifying key imports"
& $pyExe -c "import pptx, fitz, svglib, reportlab, PIL, numpy, mammoth, openpyxl; print('  imports OK')"
if ($LASTEXITCODE -ne 0) { throw "import verification failed" }

$size = [math]::Round((Get-ChildItem $pyDir -Recurse -File | Measure-Object Length -Sum).Sum/1MB, 0)
Info "DONE. vendor/python provisioned (~$size MB). Ships to resources/python via electron-builder."
