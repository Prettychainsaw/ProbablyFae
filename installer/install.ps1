param(
  [string]$InstallRoot = "$env:LOCALAPPDATA\ProbablyFae"
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
  Write-Host ""
  Write-Host "== $message ==" -ForegroundColor Cyan
}

function Show-InputHelp($title, $help, $url = "") {
  Write-Host ""
  Write-Host $title -ForegroundColor Yellow
  Write-Host $help
  if (-not [string]::IsNullOrWhiteSpace($url)) {
    Write-Host "Opening: $url"
    Start-Process $url
  }
}

function Escape-PowerShellSingleQuoted($value) {
  return [string]$value -replace "'", "''"
}

function Invoke-VisibleCommand($title, $command) {
  $safeTitle = Escape-PowerShellSingleQuoted $title
  $safeCommandForDisplay = Escape-PowerShellSingleQuoted $command
  $scriptPath = Join-Path $env:TEMP ("ProbablyFae-visible-command-" + [guid]::NewGuid().ToString("N") + ".ps1")
  $script = @"
`$Host.UI.RawUI.WindowTitle = '$safeTitle'
Write-Host '$safeTitle' -ForegroundColor Cyan
Write-Host 'Command: $safeCommandForDisplay'
Write-Host ''
$command
`$code = if (`$LASTEXITCODE -ne `$null) { `$LASTEXITCODE } else { 0 }
if (`$code -ne 0) {
  Write-Host ''
  Write-Host "Command failed with exit code `$code." -ForegroundColor Red
  Read-Host "Press Enter to close this window"
  exit `$code
}
Write-Host ''
Write-Host 'Finished. This window will close in 3 seconds.' -ForegroundColor Green
Start-Sleep -Seconds 3
exit 0
"@

  Set-Content -Path $scriptPath -Value $script -Encoding UTF8
  try {
    $process = Start-Process -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath) `
      -WindowStyle Normal `
      -Wait `
      -PassThru
    if ($process.ExitCode -ne 0) {
      throw "$title failed with exit code $($process.ExitCode)."
    }
  } finally {
    Remove-Item $scriptPath -Force -ErrorAction SilentlyContinue
  }
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

function Get-DiscordChannelInfo($discordToken, $channelId) {
  $headers = @{ Authorization = "Bot $discordToken" }
  try {
    return Invoke-RestMethod `
      -Uri "https://discord.com/api/v10/channels/$channelId" `
      -Headers $headers `
      -Method Get
  } catch {
    Write-Host "Could not verify channel ID $channelId with Discord: $($_.Exception.Message)" -ForegroundColor Yellow
    return $null
  }
}

function Confirm-DiscordChannels($discordToken) {
  while ($true) {
    $rawChannelIds = Read-Required "Discord channel ID to watch"
    $ids = $rawChannelIds -split '[,\s]+' | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($ids.Count -eq 0) {
      Write-Host "Enter at least one channel ID." -ForegroundColor Yellow
      continue
    }

    Write-Host ""
    Write-Host "Verifying Discord channel IDs..." -ForegroundColor Cyan
    $allVerified = $true
    foreach ($id in $ids) {
      $info = Get-DiscordChannelInfo $discordToken $id
      if (-not $info) {
        $allVerified = $false
        continue
      }
      $name = if ($info.name) { "#$($info.name)" } else { "(no channel name returned)" }
      $guild = if ($info.guild_id) { $info.guild_id } else { "(DM or no guild ID returned)" }
      Write-Host "- $id -> $name, type=$($info.type), guild=$guild"
    }

    if (-not $allVerified) {
      $answer = Read-Host "One or more channels could not be verified. Re-enter channel IDs? (Y/n)"
      if ($answer -notmatch '^(n|no)$') { continue }
    }

    $answer = Read-Host "Use these channel IDs? (Y/n)"
    if ($answer -notmatch '^(n|no)$') {
      return ($ids -join ',')
    }
  }
}

function Prepare-InstallDirectory($installDir, $botName) {
  $parent = Split-Path -Parent $installDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null

  if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Force -Path $installDir | Out-Null
    return
  }

  Write-Step "Existing install found"
  Write-Host "An install folder already exists for ${botName}:"
  Write-Host $installDir
  Write-Host ""
  Write-Host "1. Clean reinstall: back up the old folder, then create a fresh install. Recommended after a failed or half-finished install."
  Write-Host "2. Update existing folder: keep existing knowledge/state/env files and overwrite app files."
  Write-Host "3. Cancel install."
  $choice = Read-Host "Choice [1]"

  switch ($choice) {
    "2" {
      New-Item -ItemType Directory -Force -Path $installDir | Out-Null
      return
    }
    "3" {
      throw "Install cancelled because an existing install folder was found."
    }
    default {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $backupPath = "$installDir.backup-$stamp"
      Move-Item -LiteralPath $installDir -Destination $backupPath
      Write-Host "Backed up old install to: $backupPath"
      New-Item -ItemType Directory -Force -Path $installDir | Out-Null
      return
    }
  }
}

function Get-OllamaExe {
  $cmd = Get-Command ollama.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return [string]$cmd.Source }

  $default = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
  if (Test-Path $default) { return [string]$default }

  $machine = "C:\Program Files\Ollama\ollama.exe"
  if (Test-Path $machine) { return [string]$machine }

  return $null
}

function Get-NodeExe {
  $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return [string]$cmd.Source }

  $machine = "C:\Program Files\nodejs\node.exe"
  if (Test-Path $machine) { return [string]$machine }

  $local = Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe"
  if (Test-Path $local) { return [string]$local }

  return $null
}

function Get-NpmCmd {
  $cmd = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return [string]$cmd.Source }

  $machine = "C:\Program Files\nodejs\npm.cmd"
  if (Test-Path $machine) { return [string]$machine }

  $local = Join-Path $env:LOCALAPPDATA "Programs\nodejs\npm.cmd"
  if (Test-Path $local) { return [string]$local }

  return $null
}

function Ensure-Node {
  $node = Get-NodeExe
  if ($node) { return [string]$node }

  Write-Step "Node.js is missing"
  Show-InputHelp `
    "Node.js install question" `
    "Node.js runs the Discord bot. Choose Y to let this installer install Node.js LTS with winget, or N if you want to install it yourself first." `
    "https://nodejs.org/"
  $answer = Read-Host "Install Node.js LTS with winget now? (Y/n)"
  if ($answer -match '^(n|no)$') {
    throw "Node.js is required. Install Node.js LTS and run this installer again."
  }

  Invoke-VisibleCommand `
    "Installing Node.js LTS" `
    "winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements" | Out-Null
  $node = Get-NodeExe
  if (-not $node) {
    throw "Node.js was installed, but this installer cannot find node.exe. Open a new terminal and run the installer again."
  }
  return [string]$node
}

function Ensure-Ollama {
  $ollama = Get-OllamaExe
  if ($ollama) { return $ollama }

  Write-Step "Ollama is missing"
  Show-InputHelp `
    "Ollama install question" `
    "Ollama runs the local language model. Choose Y to let this installer install Ollama with winget, or N if you want to install it yourself first." `
    "https://ollama.com/download"
  $answer = Read-Host "Install Ollama with winget now? (Y/n)"
  if ($answer -match '^(n|no)$') {
    throw "Ollama is required for local replies. Install Ollama and run this installer again."
  }

  Invoke-VisibleCommand `
    "Installing Ollama" `
    "winget install --id Ollama.Ollama --source winget --accept-package-agreements --accept-source-agreements" | Out-Null
  $ollama = Get-OllamaExe
  if (-not $ollama) {
    throw "Ollama was installed, but this PowerShell session cannot find it yet. Open a new terminal and run the installer again."
  }
  return [string]$ollama
}

function Resolve-OllamaPath($value) {
  $candidates = @($value) | ForEach-Object {
    [string]$_ -split '\r?\n'
  } | ForEach-Object {
    $_.Trim().Trim("'`"")
  } | Where-Object {
    $_ -and $_.ToLower().EndsWith("ollama.exe") -and (Test-Path $_)
  }

  $path = $candidates | Select-Object -Last 1
  if ($path) { return [string]$path }

  $path = Get-OllamaExe
  if ($path) { return [string]$path }

  throw "Could not find a usable ollama.exe path after install."
}

function Select-BotName {
  $personNames = @'
Ada
Adair
Adler
Afton
Aiko
Ainsley
Alba
Alex
Alma
Alton
Amari
Amos
Anya
Arden
Ari
Arlo
Ash
Aster
Aubrey
Auden
August
Avery
Bailey
Basil
Bea
Beck
Bell
Benny
Blaise
Blair
Blake
Blythe
Briar
Bryn
Cal
Calla
Cam
Casey
Cass
Cedar
Celia
Chase
Clair
Clara
Claude
Cleo
Clove
Cora
Corey
Dana
Dane
Daria
Davis
Della
Devon
Drew
Eden
Edie
Eli
Elio
Ellis
Ember
Emery
Enid
Erin
Esme
Evan
Ever
Ezra
Fable
Faye
Felix
Fern
Finn
Flora
Flynn
Frey
Gale
Garnet
Gemma
Gideon
Glen
Grace
Grey
Hadley
Hale
Harper
Hayes
Hazel
Hollis
Hope
Ira
Iris
Ivy
Jade
Jasper
Jem
Jesse
Joss
Jude
Jules
June
Kai
Keir
Kelsey
Kenna
Kit
Lane
Lark
Leah
Lena
Leo
Liam
Lina
Logan
Luca
Luna
Lyra
Mabel
Mae
Mara
Maren
Marlow
Mason
Maya
Mina
Mira
Morgan
Nash
Nell
Nico
Nina
Noah
Nolan
Nora
Nova
Nyx
Olive
Oren
Orla
Owen
Paige
Parker
Pearl
Penny
Perry
Piper
Poe
Quinn
Reed
Remy
Ren
Rhea
Riley
River
Robin
Rory
Rowan
Ruby
Rue
Sage
Sally
Sam
Scout
Selah
Shay
Sidney
Silas
Skye
Sloane
Sol
Sora
Talia
Tate
Tess
Theo
Tim
Toby
Uma
Vale
Vera
Vesper
Violet
Wade
Willa
Wren
Wyatt
Yael
Zane
Zara
Zoe
Abel
Abram
Ace
Addison
Agnes
Alaric
Alice
Amelia
Anders
Ansel
April
Arthur
Aspen
Aurora
Beau
Beryl
Bette
Bianca
Birdie
Bran
Bria
Bridget
Brooke
Byron
Callum
Camille
Carson
Carys
Celine
Chance
Conrad
Dahlia
Dakota
Daphne
Darcy
Delia
Dorian
Eira
Elaine
Elena
Elian
Elise
Elodie
Emmett
Etta
Ewan
Faith
Farah
Fia
Finley
Galen
Gia
Greer
Gwen
Hanna
Harlan
Hattie
Heath
Hera
Hugo
Ida
Imogen
Indigo
Isla
Ives
Jonah
Jordan
Josie
Kara
Kian
Kira
Laine
Lana
Laurel
Leif
Lila
Linus
Lucia
Macy
Maisie
Malin
Maris
Micah
Milo
Misha
Naomi
Noel
Ocean
Opal
Orion
Otis
Petra
Pia
Pledge
Raine
Raven
Rex
Rina
Rosa
Sasha
Shiloh
Simone
Sonya
Soren
Stella
Sutton
Tamsin
Tara
Tilda
'@ -split "`r?`n" | Where-Object { $_ }

  $wordNames = @'
Anchor
Anvil
Apple
Arc
Arrow
Ashen
Atlas
Badge
Bandit
Beacon
Bean
Belfry
Berry
Birch
Blade
Blanket
Blaze
Bloom
Bolt
Bone
Book
Boot
Bottle
Brass
Brick
Bridge
Brook
Broom
Button
Candle
Canvas
Card
Charm
Cinder
Cipher
Clock
Clover
Comet
Copper
Cricket
Crown
Cup
Dagger
Daisy
Dawn
Dice
Doll
Door
Drift
Dust
Echo
Engine
Flicker
Fang
Feather
Ferry
Fig
Flint
Frost
Gear
Ghost
Glass
Glimmer
Glow
Gold
Grain
Grove
Harbor
Hearth
Honey
Hook
Ink
Ivory
Jacket
Juniper
Key
Kettle
Knife
Lantern
Lavender
Leaf
Lemon
Locket
Maple
Marble
Mask
Meadow
Mercy
Mint
Mirror
Mist
Moon
Moth
Needle
Nickel
Night
Noble
North
Oak
Oath
Onyx
Orbit
Patch
Pebble
Porch
Pepper
Pine
Pocket
Poppy
Quartz
Quill
Rain
Riddle
Rift
Rivet
Rocket
Root
Rose
Rune
Sable
Saffron
Salt
Shadow
Shard
Shell
Signal
Silver
Sketch
Smoke
Spark
Sparrow
Spindle
Static
Stone
Storm
String
Sugar
Switch
Tangle
Thimble
Thorn
Thread
Tiger
Tin
Toast
Token
Tower
Tulip
Velvet
Vex
Voyage
Warden
Whisper
Wick
Willow
Wind
Wisp
Wolf
Wool
Wreath
Yarrow
Zinc
Acorn
Amulet
Apricot
Basket
Beetle
Biscuit
Bonfire
Cabin
Caravan
Chalk
Cherry
Cloud
Compass
Dandelion
Dusk
Finch
Forge
Foxglove
Ginger
Lace
Lotus
Mosaic
Nest
Parchment
Pear
Plum
Ramble
Rook
Sleet
Spice
Sprig
Tinker
Umber
Verge
Wander
Wicker
Winter
Wonder
'@ -split "`r?`n" | Where-Object { $_ }

  if ($personNames.Count -ne 300 -or $wordNames.Count -ne 200) {
    throw "Curated name pool must contain 300 person names and 200 word names. Current counts: $($personNames.Count) and $($wordNames.Count)."
  }

  $names = @($personNames + $wordNames)
  $duplicateNames = $names | Group-Object | Where-Object { $_.Count -gt 1 }
  if ($duplicateNames) {
    throw "Curated name pool contains duplicate names: $($duplicateNames.Name -join ', ')"
  }

  Show-InputHelp `
    "Bot name choice" `
    "Pick one of the displayed curated names, ask for three more, or let the installer randomly choose one from the 500-name pool. There is no custom-name option."

  while ($true) {
    $choices = $names | Get-Random -Count 3
    Write-Host ""
    Write-Host "Pick a bot name, or choose 4 for three more."
    for ($i = 0; $i -lt $choices.Count; $i++) {
      Write-Host "$($i + 1). $($choices[$i])"
    }
    Write-Host "4. None of these"
    Write-Host "5. Random pick for me"
    $pick = Read-Host "Choice"
    switch ($pick) {
      "1" { return $choices[0] }
      "2" { return $choices[1] }
      "3" { return $choices[2] }
      "4" { continue }
      "5" { return ($names | Get-Random) }
      default { Write-Host "Pick 1-5." -ForegroundColor Yellow }
    }
  }
}

function Select-Model($ollama) {
  $ollama = Resolve-OllamaPath $ollama
  Write-Step "Model selection"
  Show-InputHelp `
    "Ollama model choice" `
    "Choose the local model this bot will use. Larger models are usually more coherent but slower. The installer can pull the selected model if it is missing." `
    "https://ollama.com/search"
  Write-Host "Recommended:"
  Write-Host "1. qwen3:8b       balanced/current known-good"
  Write-Host "2. gemma3:12b     slower/better, if your machine can handle it"
  Write-Host "3. gemma3:4b      fallback for weaker machines"
  Write-Host "4. Type my own"

  $choice = Read-Host "Choice [1]"
  switch ($choice) {
    "2" { $model = "gemma3:12b" }
    "3" { $model = "gemma3:4b" }
    "4" {
      Show-InputHelp `
        "Custom Ollama model tag" `
        "Copy a model tag from Ollama's model library, for example qwen3:8b or gemma3:12b." `
        "https://ollama.com/search"
      $model = Read-Required "Ollama model tag"
    }
    default { $model = "qwen3:8b" }
  }

  Write-Host "Checking installed Ollama models..."
  $list = & $ollama list 2>$null
  if ($LASTEXITCODE -ne 0 -or ($list -notmatch [regex]::Escape($model))) {
    Show-InputHelp `
      "Ollama model pull question" `
      "The selected model is not installed locally. Choose Y to download it now. This may take a while and can be several GB." `
      "https://ollama.com/search"
    $answer = Read-Host "Pull $model now? This can take a while. (Y/n)"
    if ($answer -notmatch '^(n|no)$') {
      $safeOllama = Escape-PowerShellSingleQuoted $ollama
      $safeModel = Escape-PowerShellSingleQuoted $model
      Invoke-VisibleCommand `
        "Downloading Ollama model $model" `
        "& '$safeOllama' pull '$safeModel'" | Out-Null
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
Show-InputHelp `
  "Discord visible bot name" `
  "The installer name controls the bot's local identity files. Discord's visible APP name comes from Developer Portal -> your application -> Bot -> Username. Make that match $botName if you want Discord and the local personality to agree." `
  "https://discord.com/developers/applications"
Show-InputHelp `
  "Starting personality" `
  "Write one short paragraph describing the bot's starting personality. Leave it blank to use the default sharp/playful local Discord companion personality."
$personality = Read-Host "Starting personality, one paragraph"
if ([string]::IsNullOrWhiteSpace($personality)) {
  $personality = "A sharp, playful local Discord bot with a tendency to tease and a bias toward honest answers."
}

Write-Step "Discord settings"
Show-InputHelp `
  "Discord bot token" `
  "Use the Bot page token, not the client secret or public key. Developer Portal -> your application -> Bot -> Reset Token or View Token." `
  "https://discord.com/developers/applications"
$discordToken = Read-SecretPlainText "Discord bot token"
Show-InputHelp `
  "Message Content Intent" `
  "Before testing replies, enable Developer Portal -> your application -> Bot -> Privileged Gateway Intents -> Message Content Intent. Without it, the bot may see messages but not understand what people typed." `
  "https://discord.com/developers/applications"
Show-InputHelp `
  "Discord channel ID" `
  "Turn on Discord Developer Mode, right-click the target channel, then Copy Channel ID. The bot will watch this channel. You can paste multiple channel IDs separated by commas." `
  "https://support.discord.com/hc/en-us/articles/206346498"
$channelIds = Confirm-DiscordChannels $discordToken
Show-InputHelp `
  "Discord application/client ID" `
  "Use the Application ID from Developer Portal -> your application -> General Information. This is only used to open the bot invite URL." `
  "https://discord.com/developers/applications"
$clientId = Read-Host "Discord application/client ID, used to open invite URL"
Show-InputHelp `
  "Optional trigger role IDs" `
  "If you want a Discord role mention to trigger the bot, enable Developer Mode, right-click the role, and copy its ID. Leave blank if you do not need role-triggered replies." `
  "https://support.discord.com/hc/en-us/articles/206346498"
$triggerRoles = Read-Host "Optional trigger role IDs, comma-separated"

Write-Step "Dependencies"
$nodeExe = Ensure-Node
$npmCmd = Get-NpmCmd
if (-not $npmCmd) {
  throw "Node.js is installed, but this installer cannot find npm.cmd. Open a new terminal and run the installer again."
}
$ollama = Ensure-Ollama
$model = Select-Model $ollama

Write-Step "Copy files"
$safeName = ($botName -replace '[^A-Za-z0-9_.-]', '-')
$installDir = Join-Path $InstallRoot $safeName
Prepare-InstallDirectory $installDir $botName

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
"$nodeExe" bot.js >> bot-runtime.log 2>> bot-runtime.err.log
"@
Set-Content -Path (Join-Path $installDir "START_BOT.cmd") -Value $startCmd -Encoding ASCII

Write-Step "Install Node dependencies"
Push-Location $installDir
try {
  & $npmCmd install --omit=dev
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
