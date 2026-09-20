[CmdletBinding()]
param(
    [switch]$Launch,
    [string]$VcpkgRoot = $(if ($env:VCPKG_ROOT) {
        $env:VCPKG_ROOT
    } else {
        $env:VCPKG_INSTALLATION_ROOT
    })
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    Write-Host "> $FilePath $($Arguments -join ' ')"
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath"
    }
}

function Require-Command {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found on PATH. See apps/windows/README.md."
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "This script builds a native Windows preview and must run on Windows."
}
if ([Environment]::Is64BitOperatingSystem -ne $true) {
    throw "The Windows preview currently supports only x64 Windows."
}

foreach ($command in @("cmake", "ctest", "node", "npm.cmd", "tar")) {
    Require-Command $command
}
if (-not $VcpkgRoot) {
    throw "Set VCPKG_ROOT to a vcpkg checkout. See apps/windows/README.md."
}

$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WindowsRoot = Join-Path $RepositoryRoot "apps\windows"
$BuildRoot = Join-Path $RepositoryRoot "build\windows-preview"
$SdkRoot = Join-Path $BuildRoot "electron-sdk"
$HeadersRoot = Join-Path $SdkRoot "headers"
$NodeLibrary = Join-Path $SdkRoot "x64\node.lib"
$VcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
$VcpkgToolchain = Join-Path $VcpkgRoot "scripts\buildsystems\vcpkg.cmake"
$Triplet = "x64-windows"

if (-not (Test-Path $VcpkgExe)) {
    throw "vcpkg.exe was not found at '$VcpkgExe'. Bootstrap the VCPKG_ROOT checkout first."
}
if (-not (Test-Path $VcpkgToolchain)) {
    throw "The vcpkg CMake toolchain was not found at '$VcpkgToolchain'."
}

Push-Location $WindowsRoot
try {
    Invoke-Checked "npm.cmd" @("ci")
    $Package = Get-Content "package.json" -Raw | ConvertFrom-Json
    $ElectronVersion = [string]$Package.dependencies.electron
    if ($ElectronVersion -notmatch '^\d+\.\d+\.\d+$') {
        throw "package.json must pin Electron to an exact version; found '$ElectronVersion'."
    }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force $SdkRoot, (Split-Path $NodeLibrary) | Out-Null
$HeaderArchive = Join-Path $SdkRoot "node-v${ElectronVersion}-headers.tar.gz"
$HeaderUrl = "https://electronjs.org/headers/v${ElectronVersion}/node-v${ElectronVersion}-headers.tar.gz"
$NodeLibraryUrl = "https://electronjs.org/headers/v${ElectronVersion}/win-x64/node.lib"
if (-not (Test-Path $HeaderArchive)) {
    Write-Host "Downloading Electron $ElectronVersion headers..."
    Invoke-WebRequest -UseBasicParsing $HeaderUrl -OutFile $HeaderArchive
}
if (-not (Test-Path $NodeLibrary)) {
    Write-Host "Downloading Electron $ElectronVersion x64 import library..."
    Invoke-WebRequest -UseBasicParsing $NodeLibraryUrl -OutFile $NodeLibrary
}
$NodeInclude = Join-Path $HeadersRoot "node-v${ElectronVersion}\include\node"
if (-not (Test-Path (Join-Path $NodeInclude "node_api.h"))) {
    if (Test-Path $HeadersRoot) {
        Remove-Item $HeadersRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force $HeadersRoot | Out-Null
    Invoke-Checked "tar" @("-xzf", $HeaderArchive, "-C", $HeadersRoot)
}
if (-not (Test-Path (Join-Path $NodeInclude "node_api.h"))) {
    throw "Electron headers were extracted, but node_api.h was not found at '$NodeInclude'."
}

Invoke-Checked $VcpkgExe @("install", "libsodium:$Triplet")
$VcpkgBin = Join-Path $VcpkgRoot "installed\$Triplet\bin"
# CTest loads the freshly built addon before its runtime DLLs are staged.
$env:PATH = "$VcpkgBin;$env:PATH"
Invoke-Checked "cmake" @(
    "-S", $RepositoryRoot,
    "-B", $BuildRoot,
    "-G", "Visual Studio 17 2022",
    "-A", "x64",
    "-DCMAKE_TOOLCHAIN_FILE=$VcpkgToolchain",
    "-DVCPKG_TARGET_TRIPLET=$Triplet",
    "-DSCPEFE_BUILD_NODE_ADDON=ON",
    "-DNODE_API_INCLUDE_DIR=$NodeInclude",
    "-DNODE_API_LIBRARY=$NodeLibrary",
    "-DBUILD_TESTING=ON"
)
Invoke-Checked "cmake" @("--build", $BuildRoot, "--config", "Release", "--parallel")
Invoke-Checked "ctest" @("--test-dir", $BuildRoot, "-C", "Release", "--output-on-failure")

$NativeRoot = Join-Path $WindowsRoot "native"
$Addon = Join-Path $BuildRoot "Release\scpefe_electron_native.node"
$CoreDll = Join-Path $BuildRoot "Release\scpefe.dll"
$SodiumDll = Get-ChildItem $VcpkgBin -Filter "*sodium*.dll" |
    Select-Object -First 1
if (-not (Test-Path $Addon)) { throw "Native addon was not produced at '$Addon'." }
if (-not (Test-Path $CoreDll)) { throw "Core DLL was not produced at '$CoreDll'." }
if (-not $SodiumDll) { throw "The vcpkg libsodium runtime DLL was not found." }
Copy-Item $Addon, $CoreDll -Destination $NativeRoot -Force
Copy-Item $SodiumDll.FullName -Destination $NativeRoot -Force

Push-Location $WindowsRoot
try {
    Invoke-Checked "npm.cmd" @("test")
    Invoke-Checked "npm.cmd" @("run", "typecheck")
    Invoke-Checked "npm.cmd" @("run", "build")
} finally {
    Pop-Location
}

$ReleaseRoot = Join-Path $WindowsRoot "release"
$PackageRoot = Join-Path $ReleaseRoot "SCPEFE-win32-x64"
$Archive = "${PackageRoot}.zip"
$ElectronDist = Join-Path $WindowsRoot "node_modules\electron\dist"
if (-not (Test-Path (Join-Path $ElectronDist "electron.exe"))) {
    throw "npm did not install the Windows Electron runtime at '$ElectronDist'."
}
if (Test-Path $PackageRoot) { Remove-Item $PackageRoot -Recurse -Force }
if (Test-Path $Archive) { Remove-Item $Archive -Force }
New-Item -ItemType Directory -Force $PackageRoot | Out-Null
Copy-Item (Join-Path $ElectronDist "*") $PackageRoot -Recurse -Force
Rename-Item (Join-Path $PackageRoot "electron.exe") "SCPEFE.exe"
Copy-Item (Join-Path $RepositoryRoot "LICENSE") (Join-Path $PackageRoot "LICENSE.txt")
$LicenseRoot = Join-Path $PackageRoot "licenses"
New-Item -ItemType Directory -Force $LicenseRoot | Out-Null
Copy-Item (Join-Path $VcpkgRoot "installed\$Triplet\share\libsodium\copyright") `
    (Join-Path $LicenseRoot "libsodium.txt")

$AppRoot = Join-Path $PackageRoot "resources\app"
New-Item -ItemType Directory -Force $AppRoot | Out-Null
Copy-Item (Join-Path $WindowsRoot "package.json") $AppRoot
Copy-Item (Join-Path $WindowsRoot "src"), (Join-Path $WindowsRoot "dist"), $NativeRoot `
    -Destination $AppRoot -Recurse -Force

$PreviousRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:ELECTRON_RUN_AS_NODE = "1"
try {
    Invoke-Checked (Join-Path $PackageRoot "SCPEFE.exe") @(
        (Join-Path $WindowsRoot "test\native-head-witness-addon.integration.mjs"),
        (Join-Path $AppRoot "native\scpefe_electron_native.node")
    )
    Invoke-Checked (Join-Path $PackageRoot "SCPEFE.exe") @(
        (Join-Path $WindowsRoot "test\native-invitation-addon.integration.mjs"),
        (Join-Path $AppRoot "native\scpefe_electron_native.node")
    )
} finally {
    $env:ELECTRON_RUN_AS_NODE = $PreviousRunAsNode
}

Compress-Archive -Path $PackageRoot -DestinationPath $Archive -CompressionLevel Optimal
$Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash
Write-Host ""
Write-Host "Windows preview built successfully."
Write-Host "Executable: $PackageRoot\SCPEFE.exe"
Write-Host "Archive:    $Archive"
Write-Host "SHA-256:    $Hash"
Write-Host "This preview is unsigned and intended for development testing only."

if ($Launch) {
    Start-Process (Join-Path $PackageRoot "SCPEFE.exe")
}
