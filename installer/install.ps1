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
