param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\ProbablyFae"
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
  Write-Host ""
  Write-Host "== $message ==" -ForegroundColor Cyan
}

function Read-Required($prompt) {
  do {
    $value = Read-Host $prompt
  } while ([string]::IsNullOrWhiteSpace($value))
  return $value.Trim()
}

function Read-SecretPlainText($prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}

function Get-OllamaExe {
  $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $default = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (Test-Path $default) { return $default }

  $machine = "C:\Program Files\Ollama\ollama.exe"
  if (Test-Path $machine) { return $machine }

  return $null
}

function Ensure-Node {
  if (Get-Command node.exe -ErrorAction SilentlyContinue) { return }

  Write-Step "Node.js is missing"
  $answer = Read-Host "Install Node.js LTS with winget now? (Y/n)"
  if ($answer -match '^(n|no)$') {
    throw "Node.js is required. Install Node.js LTS and run this installer again."
  }

  winget install --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js was installed, but this PowerShell session cannot see it yet. Open a new terminal and run the installer again."
  }
}

function Ensure-Ollama {
  $ollama = Get-OllamaExe
  if ($ollama) { return $ollama }

  Write-Step "Ollama is missing"
  $answer = Read-Host "Install Ollama with winget now? (Y/n)"
  if ($answer -match '^(n|no)$') {
    throw "Ollama is required for local replies. Install Ollama and run this installer again."
  }

  winget install --id Ollama.Ollama --accept-package-agreements --accept-source-agreements
  $ollama = Get-OllamaExe
  if (-not $ollama) {
    throw "Ollama was installed, but this PowerShell session cannot find it yet. Open a new terminal and run the installer again."
  }
  return $ollama
}

function Select-BotName {
  $names = @(
    "Ada", "Alma", "Ash", "Basil", "Bloom", "Briar", "Cal", "Casey",
    "Cinder", "Clove", "Davis", "Echo", "Eli", "Fable", "Fae", "Finn",
    "Grey", "Harper", "Hex", "Iris", "Jules", "June", "Kit", "Lark",
    "Lemon", "Lena", "Luna", "Mara", "Mina", "Moth", "Nell", "Nyx",
    "Penny", "Pledge", "Quinn", "Remy", "Riley", "Rowan", "Rune",
    "Sable", "Sally", "Sam", "Static", "Tess", "Thorn", "Tim",
    "Vesper", "Vex", "Wisp"
  )

  while ($true) {
    $choices = $names | Get-Random -Count 3
    Write-Host ""
    Write-Host "Pick a bot name, or choose 4 for three more."
    for ($i = 0; $i -lt $choices.Count; $i++) {
      Write-Host "$($i + 1). $($choices[$i])"
    }
    Write-Host "4. None of these"
    $pick = Read-Host "Choice"
    switch ($pick) {
      "1" { return $choices[0] }
      "2" { return $choices[1] }
      "3" { return $choices[2] }
      "4" { continue }
      default { Write-Host "Pick 1-4." -ForegroundColor Yellow }
    }
  }
}

function Select-Model($ollama) {
  Write-Step "Model selection"
  Write-Host "Recommended:"
  Write-Host "1. qwen3:8b       balanced/current known-good"
  Write-Host "2. gemma3:12b     slower/better, if your machine can handle it"
  Write-Host "3. gemma3:4b      fallback for weaker machines"
  Write-Host "4. Type my own"

  $choice = Read-Host "Choice [1]"
  switch ($choice) {
    "2" { $model = "gemma3:12b" }
    "3" { $model = "gemma3:4b" }
    "4" { $model = Read-Required "Ollama model tag" }
    default { $model = "qwen3:8b" }
  }

  Write-Host "Checking installed Ollama models..."
  $list = & $ollama list 2>$null
  if ($LASTEXITCODE -ne 0 -or ($list -notmatch [regex]::Escape($model))) {
    $answer = Read-Host "Pull $model now? This can take a while. (Y/n)"
    if ($answer -notmatch '^(n|no)$') {
      & $ollama pull $model
      if ($LASTEXITCODE -ne 0) { throw "Failed to pull Ollama model $model." }
    }
  }

  return $model
}

Write-Host "ProbablyFae alpha installer 0.0.1" -ForegroundColor Green
Write-Host "This installer sets up a local Discord bot prototype."

Write-Step "Choose identity"
$botName = Select-BotName
$botSlug = ($botName.ToLower() -replace '[^a-z0-9]+', '-' -replace '^-+|-+$', '')
if ([string]::IsNullOrWhiteSpace($botSlug)) { $botSlug = "bot" }
$personality = Read-Host "Starting personality, one paragraph"
if ([string]::IsNullOrWhiteSpace($personality)) {
  $personality = "A sharp, playful local Discord bot with a tendency to tease and a bias toward honest answers."
}

Write-Step "Discord settings"
$discordToken = Read-SecretPlainText "Discord bot token"
$channelIds = Read-Required "Discord channel ID to watch"
$clientId = Read-Host "Discord application/client ID, used to open invite URL"
$triggerRoles = Read-Host "Optional trigger role IDs, comma-separated"

Write-Step "Dependencies"
Ensure-Node
$ollama = Ensure-Ollama
$model = Select-Model $ollama

Write-Step "Copy files"
$safeName = ($botName -replace '[^A-Za-z0-9_.-]', '-')
$installDir = Join-Path $InstallRoot $safeName
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$source = $PSScriptRoot
$files = @(
  "bot.js",
  "package.json",
  "package-lock.json",
  "README.md",
  "KILL_SWITCH.md",
  "VERSION",
  "control.ps1"
)

foreach ($file in $files) {
  Copy-Item -Path (Join-Path $source $file) -Destination (Join-Path $installDir $file) -Force
}

New-Item -ItemType Directory -Force -Path `
  (Join-Path $installDir "knowledge\books"), `
  (Join-Path $installDir "knowledge\notes"), `
  (Join-Path $installDir "knowledge\users"), `
  (Join-Path $installDir "knowledge\channel-sessions"), `
  (Join-Path $installDir "knowledge\personality-reverts") | Out-Null

$personalityText = @"
# $botName Personality

Installed bot display name: $botName

$personality
"@

Set-Content -Path (Join-Path $installDir "knowledge\notes\$botSlug-personality.md") -Value $personalityText -Encoding UTF8
Set-Content -Path (Join-Path $installDir "knowledge\notes\$botSlug-notes.md") -Value "# $botName Notes`r`n`r`n" -Encoding UTF8
Set-Content -Path (Join-Path $installDir "knowledge\notes\$botSlug-mental-state.md") -Value "# $botName Mental State`r`n`r`n" -Encoding UTF8

$envText = @"
DISCORD_TOKEN=$discordToken
DISCORD_CHANNEL_IDS=$channelIds
BOT_TRIGGER_ROLE_IDS=$triggerRoles
BOT_MODEL=$model
BOT_NAME=$botName
BOT_SLUG=$botSlug
BOT_ALIASES=$botName,$botSlug
BOT_WEB_SEARCH=1
"@
Set-Content -Path (Join-Path $installDir ".env") -Value $envText -Encoding UTF8

$startCmd = @"
@echo off
cd /d "%~dp0"
node bot.js >> bot-runtime.log 2>> bot-runtime.err.log
"@
Set-Content -Path (Join-Path $installDir "START_BOT.cmd") -Value $startCmd -Encoding ASCII

Write-Step "Install Node dependencies"
Push-Location $installDir
try {
  npm.cmd install --omit=dev
} finally {
  Pop-Location
}

Write-Step "Create shortcuts"
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")

$startShortcut = $shell.CreateShortcut((Join-Path $desktop "Start $botName.lnk"))
$startShortcut.TargetPath = Join-Path $installDir "START_BOT.cmd"
$startShortcut.WorkingDirectory = $installDir
$startShortcut.Save()

$controlShortcut = $shell.CreateShortcut((Join-Path $desktop "Control $botName.lnk"))
$controlShortcut.TargetPath = "powershell.exe"
$controlShortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$installDir\control.ps1`""
$controlShortcut.WorkingDirectory = $installDir
$controlShortcut.Save()

if ($clientId) {
  Write-Step "Open Discord invite"
  $permissions = 68672
  $invite = "https://discord.com/oauth2/authorize?client_id=$clientId&permissions=$permissions&scope=bot"
  Start-Process $invite
  Write-Host "Approve the Discord invite in your browser."
}

Write-Step "Done"
Write-Host "Installed to: $installDir"
Write-Host "Use the desktop shortcut 'Start $botName' to run the bot."
Write-Host "Use the desktop shortcut 'Control $botName' for kill switch, resume, and status."
Write-Host "If Discord does not show messages, check bot permissions and Message Content Intent in the Discord Developer Portal."
