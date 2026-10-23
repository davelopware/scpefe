[CmdletBinding()]
param(
    [string]$VcpkgRoot = $(if ($env:VCPKG_ROOT) {
        $env:VCPKG_ROOT
    } else {
        $env:VCPKG_INSTALLATION_ROOT
    })
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$FilePath, [string[]]$Arguments)
    Write-Host "> $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

if ($env:OS -ne "Windows_NT" -or -not [Environment]::Is64BitOperatingSystem) {
    throw "This preview must be built on x64 Windows."
}
foreach ($Command in @("cmake", "ctest", "python", "git")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "Required command '$Command' was not found."
    }
}
if (-not $VcpkgRoot) { throw "Set VCPKG_ROOT to a bootstrapped vcpkg checkout." }

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BuildRoot = Join-Path $RepositoryRoot "build\windows-diagnostic-preview"
$ReleaseRoot = Join-Path $BuildRoot "Release"
$PackageName = "scpefe-diagnostic-win-x64"
$PackageRoot = Join-Path $BuildRoot "package\$PackageName"
$Archive = Join-Path $BuildRoot "$PackageName.zip"
$VcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
$Toolchain = Join-Path $VcpkgRoot "scripts\buildsystems\vcpkg.cmake"
$Python = (Get-Command "python").Source
$env:PYTHONUTF8 = "1"

if (-not (Test-Path $VcpkgExe) -or -not (Test-Path $Toolchain)) {
    throw "The vcpkg checkout is not bootstrapped."
}
Invoke-Checked $VcpkgExe @("install", "libsodium:x64-windows")
Invoke-Checked "cmake" @(
    "-S", $RepositoryRoot, "-B", $BuildRoot, "-A", "x64",
    "-DCMAKE_TOOLCHAIN_FILE=$Toolchain", "-DVCPKG_TARGET_TRIPLET=x64-windows",
    "-DSCPEFE_BUILD_NODE_ADDON=OFF", "-DBUILD_TESTING=ON",
    "-DPython3_EXECUTABLE=$Python"
)
Invoke-Checked "cmake" @("--build", $BuildRoot, "--config", "Release", "--parallel", "2")

$SodiumDlls = @(Get-ChildItem (Join-Path $VcpkgRoot "installed\x64-windows\bin") -Filter "*sodium*.dll")
if ($SodiumDlls.Count -ne 1) { throw "Expected exactly one libsodium runtime DLL." }
Copy-Item $SodiumDlls[0].FullName $ReleaseRoot -Force

# Include the Visual C++ runtime so the extracted preview needs no installer.
$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$VisualStudio = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $VisualStudio) { throw "Visual C++ installation was not found." }
$RuntimeRoot = Get-ChildItem (Join-Path $VisualStudio "VC\Redist\MSVC\*\x64\Microsoft.VC*.CRT") -Directory |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $RuntimeRoot) { throw "The x64 Visual C++ redistributable DLLs were not found." }
$RuntimeDlls = @(Get-ChildItem $RuntimeRoot.FullName -Filter "*.dll")
if ($RuntimeDlls.Count -eq 0) { throw "No Visual C++ runtime DLLs were found." }
Copy-Item $RuntimeDlls.FullName $ReleaseRoot -Force

# This configuration runs only native C/C++ and Python tests, without Electron.
Invoke-Checked "ctest" @("--test-dir", $BuildRoot, "-C", "Release", "--output-on-failure", "--parallel", "1", "--timeout", "120")

if (Test-Path $PackageRoot) { Remove-Item $PackageRoot -Recurse -Force }
New-Item -ItemType Directory -Force $PackageRoot | Out-Null
Copy-Item (Join-Path $ReleaseRoot "scpefe-diagnostic.exe"), (Join-Path $ReleaseRoot "scpefe.dll"), `
    $SodiumDlls[0].FullName -Destination $PackageRoot
Copy-Item $RuntimeDlls.FullName -Destination $PackageRoot
Copy-Item (Join-Path $RepositoryRoot "LICENSE") (Join-Path $PackageRoot "LICENSE.txt")
$LicenseRoot = Join-Path $PackageRoot "licenses"
New-Item -ItemType Directory -Force $LicenseRoot | Out-Null
Copy-Item (Join-Path $VcpkgRoot "installed\x64-windows\share\libsodium\copyright") `
    (Join-Path $LicenseRoot "libsodium.txt")
Copy-Item (Join-Path $RepositoryRoot "third_party\zxcvbn-c\LICENSE.txt") `
    (Join-Path $LicenseRoot "zxcvbn.txt")
Copy-Item (Join-Path $RepositoryRoot "docs\format\container-diagnostic-json-v1.md") `
    (Join-Path $PackageRoot "JSON-CONTRACT.md")

$SourceCommit = & git -C $RepositoryRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot determine the preview source commit." }
@{
    tool = "scpefe-diagnostic"
    source_commit = $SourceCommit
    platform = "win-x64"
    configuration = "Release"
    unsigned = $true
    validation = "Native suite and extracted-package authenticated diagnostics passed"
} | ConvertTo-Json | Set-Content (Join-Path $PackageRoot "preview-manifest.json") -Encoding UTF8
@'
SCPEFE diagnostic tool - unsigned Windows x64 developer preview

Extract the entire ZIP into one folder. Keep the EXE and DLLs together.
Open PowerShell in that folder, then run:

  .\scpefe-diagnostic.exe version
  .\scpefe-diagnostic.exe inspect "C:\path\document.scpefe"

The password prompt hides your input. Never put a password in arguments.
For automation, pipe one UTF-8 password line with --password-stdin.
Add --include-content only when you intend to emit historical document text.
Success writes diagnostic JSON to stdout; errors write safe JSON to stderr.

Redirect JSON to a file if desired:
  .\scpefe-diagnostic.exe inspect "C:\path\document.scpefe" > diagnostic.json

This tool reads supported revised-v3 containers and does not modify them.
JSON-CONTRACT.md describes fields, omission rules and resource limits.
preview-manifest.json identifies the exact source commit.
'@ | Set-Content (Join-Path $PackageRoot "README.txt") -Encoding UTF8

if (Test-Path $Archive) { Remove-Item $Archive -Force }
Compress-Archive -Path $PackageRoot -DestinationPath $Archive -CompressionLevel Optimal
$ValidationRoot = Join-Path $BuildRoot "extracted preview"
if (Test-Path $ValidationRoot) { Remove-Item $ValidationRoot -Recurse -Force }
Expand-Archive $Archive -DestinationPath $ValidationRoot
$Extracted = Join-Path $ValidationRoot $PackageName
$Executable = Join-Path $Extracted "scpefe-diagnostic.exe"
$PreviousPath = $env:PATH
try {
    # Prove that packaged dependencies suffice without the development PATH.
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    Invoke-Checked $Executable @("health")
    Invoke-Checked $Executable @("version")
    Invoke-Checked $Python @(
        (Join-Path $RepositoryRoot "tests\container_diagnostic_test.py"),
        $Executable, $RepositoryRoot, (Join-Path $Extracted "scpefe.dll")
    )
} finally {
    $env:PATH = $PreviousPath
}
$Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  $PackageName.zip" | Set-Content "$Archive.sha256" -Encoding ASCII
Write-Host "Windows diagnostic preview validated: $Archive"
Write-Host "Source commit: $SourceCommit"
Write-Host "SHA-256: $Hash"
