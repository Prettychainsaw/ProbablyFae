param(
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $repoRoot "dist"
$stageDir = Join-Path $distDir "installer-stage"

if (-not $OutputPath) {
  $OutputPath = Join-Path $distDir "ProbablyFae-Setup.exe"
}

if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stageDir, $distDir | Out-Null

$filesToPackage = @(
  @{ Source = Join-Path $PSScriptRoot "install.cmd"; Name = "install.cmd" },
  @{ Source = Join-Path $PSScriptRoot "install.ps1"; Name = "install.ps1" },
  @{ Source = Join-Path $PSScriptRoot "control.ps1"; Name = "control.ps1" },
  @{ Source = Join-Path $PSScriptRoot "uninstall.ps1"; Name = "uninstall.ps1" },
  @{ Source = Join-Path $repoRoot "bot.js"; Name = "bot.js" },
  @{ Source = Join-Path $repoRoot "package.json"; Name = "package.json" },
  @{ Source = Join-Path $repoRoot "package-lock.json"; Name = "package-lock.json" },
  @{ Source = Join-Path $repoRoot "README.md"; Name = "README.md" },
  @{ Source = Join-Path $repoRoot "KILL_SWITCH.md"; Name = "KILL_SWITCH.md" },
  @{ Source = Join-Path $repoRoot "VERSION"; Name = "VERSION" }
)

foreach ($file in $filesToPackage) {
  if (-not (Test-Path $file.Source)) {
    throw "Missing package file: $($file.Source)"
  }
  Copy-Item -Path $file.Source -Destination (Join-Path $stageDir $file.Name) -Force
}

$sedPath = Join-Path $distDir "ProbablyFae-Setup.SED"
$fileLines = @()
$stringLines = @()
for ($i = 0; $i -lt $filesToPackage.Count; $i++) {
  $fileLines += "%FILE$i%="
  $stringLines += "FILE$i=`"$($filesToPackage[$i].Name)`""
}

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=ProbablyFae setup finished.
TargetName=$OutputPath
FriendlyName=ProbablyFae Setup
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles

[SourceFiles]
SourceFiles0=$stageDir\

[SourceFiles0]
$($fileLines -join "`r`n")

[Strings]
$($stringLines -join "`r`n")
"@

Set-Content -Path $sedPath -Value $sed -Encoding ASCII

$iexpress = Get-Command iexpress.exe -ErrorAction Stop
& $iexpress.Source /N /Q $sedPath
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
  throw "IExpress failed with exit code $LASTEXITCODE."
}

for ($i = 0; $i -lt 20 -and -not (Test-Path $OutputPath); $i++) {
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $OutputPath)) {
  throw "Expected installer was not created: $OutputPath"
}

Write-Host "Created installer: $OutputPath" -ForegroundColor Green
