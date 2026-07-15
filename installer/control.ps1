param(
  [string]$BotDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$envPath = Join-Path $BotDir ".env"
$botSlug = "faye"
if (Test-Path $envPath) {
  $envLines = Get-Content $envPath
  $slugLine = $envLines | Where-Object { $_ -match '^BOT_SLUG=' } | Select-Object -First 1
  if ($slugLine) { $botSlug = ($slugLine -replace '^BOT_SLUG=', '').Trim() }
  if (-not $slugLine) {
    $nameLine = $envLines | Where-Object { $_ -match '^(BOT_NAME|FAYE_NAME)=' } | Select-Object -First 1
    if ($nameLine) {
      $botName = ($nameLine -replace '^(BOT_NAME|FAYE_NAME)=', '').Trim()
      $derivedSlug = ($botName.ToLower() -replace '[^a-z0-9]+', '-' -replace '^-+|-+$', '')
      if (-not [string]::IsNullOrWhiteSpace($derivedSlug)) { $botSlug = $derivedSlug }
    }
  }
}
$KillSwitch = Join-Path $BotDir "$($botSlug.ToUpper())_KILL_SWITCH"
$PidFile = Join-Path $BotDir "bot.pid"

function Get-BotProcess {
  if (Test-Path $PidFile) {
    $pidText = (Get-Content $PidFile -Raw).Trim()
    if ($pidText -match '^\d+$') {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidText" -ErrorAction SilentlyContinue
      if ($process -and $process.Name -eq 'node.exe') { return $process }
    }
  }

  Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'bot\.js' }
}

function Show-Status {
  $version = if (Test-Path (Join-Path $BotDir "VERSION")) { Get-Content (Join-Path $BotDir "VERSION") -Raw } else { "unknown" }
  $model = "unknown"
  $channels = "unknown"
  if (Test-Path $envPath) {
    $envLines = Get-Content $envPath
    $model = ($envLines | Where-Object { $_ -match '^(BOT_MODEL|FAYE_MODEL)=' } | Select-Object -First 1) -replace '^(BOT_MODEL|FAYE_MODEL)=', ''
    $channels = ($envLines | Where-Object { $_ -match '^DISCORD_CHANNEL_IDS=' } | Select-Object -First 1) -replace '^DISCORD_CHANNEL_IDS=', ''
  }

  $proc = Get-BotProcess
  Write-Host ""
  Write-Host "ProbablyFae status" -ForegroundColor Cyan
  Write-Host "Bot dir:     $BotDir"
  Write-Host "Version:     $($version.Trim())"
  Write-Host "Model:       $model"
  Write-Host "Channels:    $channels"
  Write-Host "Kill switch: $(if (Test-Path $KillSwitch) { 'ACTIVE' } else { 'off' })"
  if ($proc) {
    $proc | Select-Object ProcessId,CreationDate,CommandLine | Format-List
  } else {
    Write-Host "Process:     stopped"
  }
}

function Start-Bot {
  if (Get-BotProcess) {
    Write-Host "Bot already appears to be running."
    return
  }
  $stdout = Join-Path $BotDir "bot-runtime.log"
  $stderr = Join-Path $BotDir "bot-runtime.err.log"
  $process = Start-Process -FilePath "node.exe" `
    -ArgumentList "bot.js" `
    -WorkingDirectory $BotDir `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -WindowStyle Hidden `
    -PassThru
  Set-Content -Path $PidFile -Value $process.Id -Encoding ASCII
  Start-Sleep -Seconds 2
  Show-Status
}

function Stop-Bot {
  $proc = Get-BotProcess
  if (-not $proc) {
    Write-Host "Bot is not running."
    return
  }
  foreach ($p in $proc) {
    Stop-Process -Id $p.ProcessId -Force
  }
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
  Write-Host "Stopped bot process."
}

function Enable-KillSwitch {
  Set-Content -Path $KillSwitch -Value "Stopped from ProbablyFae control app at $(Get-Date -Format o)" -Encoding UTF8
  Write-Host "Kill switch enabled."
}

function Disable-KillSwitch {
  if (Test-Path $KillSwitch) {
    Remove-Item $KillSwitch -Force
    Write-Host "Kill switch cleared."
  } else {
    Write-Host "Kill switch was not active."
  }
}

function Check-AppUpdates {
  Write-Host ""
  Write-Host "App update check" -ForegroundColor Cyan
  Write-Host "Alpha placeholder: future versions will check:"
  Write-Host "https://github.com/Prettychainsaw/ProbablyFae"
  Write-Host "Current local version:"
  if (Test-Path (Join-Path $BotDir "VERSION")) { Get-Content (Join-Path $BotDir "VERSION") } else { Write-Host "unknown" }
}

function Check-ModelUpdates {
  Write-Host ""
  Write-Host "Model update check" -ForegroundColor Cyan
  $ollama = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if (-not $ollama) {
    $default = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $default) { $ollama = @{ Source = $default } }
  }
  if (-not $ollama) {
    Write-Host "Ollama was not found."
    return
  }
  & $ollama.Source list
}

function Open-Logs {
  Start-Process explorer.exe $BotDir
}

function Uninstall-Bot {
  $uninstallScript = Join-Path $BotDir "uninstall.ps1"
  if (-not (Test-Path $uninstallScript)) {
    Write-Host "Uninstall script not found: $uninstallScript" -ForegroundColor Yellow
    return
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $uninstallScript -BotDir $BotDir
}

while ($true) {
  Show-Status
  Write-Host ""
  Write-Host "1. Start bot"
  Write-Host "2. Stop bot"
  Write-Host "3. Restart bot"
  Write-Host "4. Enable kill switch"
  Write-Host "5. Clear kill switch"
  Write-Host "6. Check app updates"
  Write-Host "7. Check model updates"
  Write-Host "8. Open logs folder"
  Write-Host "9. Uninstall this bot"
  Write-Host "10. Exit"
  $choice = Read-Host "Choice"

  switch ($choice) {
    "1" { Start-Bot }
    "2" { Stop-Bot }
    "3" { Stop-Bot; Start-Bot }
    "4" { Enable-KillSwitch }
    "5" { Disable-KillSwitch }
    "6" { Check-AppUpdates }
    "7" { Check-ModelUpdates }
    "8" { Open-Logs }
    "9" { Uninstall-Bot; break }
    "10" { break }
    default { Write-Host "Pick 1-10." -ForegroundColor Yellow }
  }
}
