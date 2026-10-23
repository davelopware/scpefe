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
$SourceCommit = & git -C $RepositoryRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Cannot determine the preview source commit." }
$SourceChanges = & git -C $RepositoryRoot status --porcelain
if ($LASTEXITCODE -ne 0 -or $SourceChanges) {
    throw "Build the preview from a clean committed checkout so source metadata is exact."
}
$BuildRoot = Join-Path $RepositoryRoot "build\windows-diagnostic-preview"
$ReleaseRoot = Join-Path $BuildRoot "Release"
$PackageName = "scpefe-diagnostic-win-x64"
$PackageRoot = Join-Path $BuildRoot "package\$PackageName"
$VcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
$Toolchain = Join-Path $VcpkgRoot "scripts\buildsystems\vcpkg.cmake"
$Python = (Get-Command "python").Source
$env:PYTHONUTF8 = "1"
$env:PYTHONDONTWRITEBYTECODE = "1"

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

# Supply the shared regression executables with their dynamic CRT.
# These test-only DLLs are never copied into the single-EXE distribution.
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

# Preserve the default shared ABI regression gate above, then build and test
# the static diagnostic against those same public contracts.
& (Join-Path $PSScriptRoot "test-windows-static-diagnostic.ps1") -VcpkgRoot $VcpkgRoot
if (-not $?) { throw "Static diagnostic gate failed." }

if (Test-Path $PackageRoot) { Remove-Item $PackageRoot -Recurse -Force }
New-Item -ItemType Directory -Force $PackageRoot | Out-Null
$Executable = Join-Path $PackageRoot "scpefe-diagnostic.exe"
Copy-Item (Join-Path $RepositoryRoot "build\windows-static-diagnostic\Release\scpefe-diagnostic.exe") $Executable
$Dumpbin = Get-ChildItem (Join-Path $VisualStudio "VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe") |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $Dumpbin) { throw "dumpbin.exe was not found." }
$Manifest = Join-Path $PackageRoot "preview-manifest.json"
Invoke-Checked $Python @(
    (Join-Path $RepositoryRoot "tests\windows_diagnostic_preview.py"),
    "--executable", $Executable, "--repository", $RepositoryRoot,
    "--sodium-notice", (Join-Path $VcpkgRoot "installed\x64-windows-static\share\libsodium\copyright"),
    "--dumpbin", $Dumpbin.FullName, "--source-commit", $SourceCommit, "--manifest", $Manifest
)
$Hash = (Get-FileHash $Executable -Algorithm SHA256).Hash.ToLowerInvariant()
"$Hash  scpefe-diagnostic.exe" | Set-Content "$Executable.sha256" -Encoding ASCII
@'
SCPEFE diagnostic tool - unsigned Windows x64 developer preview

Copy scpefe-diagnostic.exe alone to a Windows x64 machine. No installer,
companion application DLLs or Visual C++ redistributable installation is needed.
The checksum, manifest and this README are verification information; the EXE
needs only standard Windows components and any input containers you supply.
Open PowerShell in the executable's folder, then run:

  .\scpefe-diagnostic.exe health
  .\scpefe-diagnostic.exe version
  .\scpefe-diagnostic.exe licenses
  .\scpefe-diagnostic.exe inspect "C:\path\document.scpefe"

The password prompt hides your input. Never put a password in arguments.
For automation, pipe one UTF-8 password line with --password-stdin.
Add --include-content only when you intend to emit historical document text.
Success writes diagnostic JSON to stdout; errors write safe JSON to stderr.

Redirect JSON to a file if desired:
  .\scpefe-diagnostic.exe inspect "C:\path\document.scpefe" > diagnostic.json

This tool reads supported revised-v3 containers and does not modify them.
Licence notices are embedded and available through licenses.
preview-manifest.json identifies the exact source commit, validation result,
allowed system imports and validated EXE SHA-256. This developer preview is unsigned.
The downloadable checksum is for the EXE itself, not the GitHub artifact ZIP.
Verify it in PowerShell before copying or running:

  $expected = (Get-Content .\scpefe-diagnostic.exe.sha256).Split(' ')[0]
  $actual = (Get-FileHash .\scpefe-diagnostic.exe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "EXE checksum mismatch" }
'@ | Set-Content (Join-Path $PackageRoot "README.txt") -Encoding UTF8
Invoke-Checked $Python @(
    (Join-Path $RepositoryRoot "tests\windows_diagnostic_preview.py"),
    "--verify-download", $PackageRoot, "--source-commit", $SourceCommit
)
Write-Host "Single-EXE Windows diagnostic preview validated: $Executable"
Write-Host "Source commit: $SourceCommit"
Write-Host "EXE SHA-256: $Hash"
