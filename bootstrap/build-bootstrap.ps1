param(
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$distDir = Join-Path $repoRoot "dist"
$stageDir = Join-Path $distDir "bootstrap-stage"

if (-not $OutputPath) {
  $OutputPath = Join-Path $distDir "ProbablyFae-Bootstrap.exe"
}

if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stageDir, $distDir | Out-Null

$filesToPackage = @(
  @{ Source = Join-Path $PSScriptRoot "bootstrap.cmd"; Name = "bootstrap.cmd" },
  @{ Source = Join-Path $PSScriptRoot "bootstrap.ps1"; Name = "bootstrap.ps1" }
)

foreach ($file in $filesToPackage) {
  Copy-Item -Path $file.Source -Destination (Join-Path $stageDir $file.Name) -Force
}

$sedPath = Join-Path $distDir "ProbablyFae-Bootstrap.SED"
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
FinishMessage=ProbablyFae bootstrap finished.
TargetName=$OutputPath
FriendlyName=ProbablyFae Bootstrap
AppLaunched=bootstrap.cmd
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
  throw "Expected bootstrapper was not created: $OutputPath"
}

Write-Host "Created bootstrapper: $OutputPath" -ForegroundColor Green
