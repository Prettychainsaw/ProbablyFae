param(
  [string]$ManifestUrl = "https://raw.githubusercontent.com/Prettychainsaw/ProbablyFae/main/latest.json"
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
  Write-Host ""
  Write-Host "== $message ==" -ForegroundColor Cyan
}

Write-Host "ProbablyFae bootstrap installer" -ForegroundColor Green
Write-Host "This downloads the current installer from GitHub before running setup."

$tempDir = Join-Path $env:TEMP ("ProbablyFae-bootstrap-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

try {
  Write-Step "Download install manifest"
  $manifestPath = Join-Path $tempDir "latest.json"
  Invoke-WebRequest -Uri $ManifestUrl -OutFile $manifestPath -UseBasicParsing
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json

  if (-not $manifest.install.assetUrl) {
    throw "Manifest does not contain install.assetUrl."
  }

  Write-Host "Latest install version: $($manifest.install.version)"
  Write-Host $manifest.install.notes

  $answer = Read-Host "Download and run this installer? (Y/n)"
  if ($answer -match '^(n|no)$') {
    Write-Host "Cancelled."
    return
  }

  Write-Step "Download installer"
  $installerPath = Join-Path $tempDir "ProbablyFae-Setup-Payload.exe"
  Invoke-WebRequest -Uri $manifest.install.assetUrl -OutFile $installerPath -UseBasicParsing

  if (-not (Test-Path $installerPath)) {
    throw "Installer payload did not download."
  }

  Write-Step "Run installer"
  Start-Process -FilePath $installerPath -Wait
} finally {
  if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
