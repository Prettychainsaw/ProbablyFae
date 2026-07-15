param(
  [string]$BotDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Read-EnvValue($name) {
  $envPath = Join-Path $BotDir ".env"
  if (-not (Test-Path $envPath)) { return "" }
  $line = Get-Content $envPath | Where-Object { $_ -match "^$([regex]::Escape($name))=" } | Select-Object -First 1
  if (-not $line) { return "" }
  return ($line -replace "^$([regex]::Escape($name))=", "").Trim()
}

function Get-BotProcess {
  $pidFile = Join-Path $BotDir "bot.pid"
  if (Test-Path $pidFile) {
    $pidText = (Get-Content $pidFile -Raw).Trim()
    if ($pidText -match '^\d+$') {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidText" -ErrorAction SilentlyContinue
      if ($process -and $process.Name -eq 'node.exe') { return $process }
    }
  }

  $escapedBotDir = [regex]::Escape((Resolve-Path -LiteralPath $BotDir).Path)
  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'bot\.js' -and $_.CommandLine -match $escapedBotDir }
}

function Stop-Bot {
  $proc = Get-BotProcess
  if (-not $proc) { return }
  foreach ($p in $proc) {
    Stop-Process -Id $p.ProcessId -Force
  }
  Start-Sleep -Seconds 1
}

$resolvedBotDir = (Resolve-Path -LiteralPath $BotDir).Path
$botName = Read-EnvValue "BOT_NAME"
if ([string]::IsNullOrWhiteSpace($botName)) {
  $botName = Split-Path -Leaf $resolvedBotDir
}

Write-Host ""
Write-Host "ProbablyFae bot uninstall" -ForegroundColor Cyan
Write-Host "Bot name: $botName"
Write-Host "Bot folder: $resolvedBotDir"
Write-Host ""
Write-Host "This removes only this bot install folder and its desktop shortcuts."
Write-Host "It does NOT uninstall Ollama, Node.js, downloaded Ollama models, Discord apps, or other bot folders."
Write-Host ""
$confirm = Read-Host "Type DELETE to remove this bot"
if ($confirm -ne "DELETE") {
  Write-Host "Cancelled."
  return
}

Stop-Bot

$desktop = [Environment]::GetFolderPath("Desktop")
$shortcuts = @(
  Join-Path $desktop "Start $botName.lnk",
  Join-Path $desktop "Control $botName.lnk",
  Join-Path $desktop "Uninstall $botName.lnk"
)
foreach ($shortcut in $shortcuts) {
  Remove-Item -LiteralPath $shortcut -Force -ErrorAction SilentlyContinue
}

$parent = Split-Path -Parent $resolvedBotDir
$trashName = ".deleted-$($botName)-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
$stagingPath = Join-Path $parent $trashName
Set-Location -LiteralPath ([System.IO.Path]::GetTempPath())
Move-Item -LiteralPath $resolvedBotDir -Destination $stagingPath
Remove-Item -LiteralPath $stagingPath -Recurse -Force

Write-Host "Removed bot install: $resolvedBotDir" -ForegroundColor Green
