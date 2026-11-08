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
    throw "This validation requires x64 Windows."
}
if (-not $VcpkgRoot) { throw "Set VCPKG_ROOT to a bootstrapped vcpkg checkout." }
$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$BuildRoot = Join-Path $RepositoryRoot "build\windows-static-diagnostic"
$ReleaseRoot = Join-Path $BuildRoot "Release"
$VcpkgExe = Join-Path $VcpkgRoot "vcpkg.exe"
$Toolchain = Join-Path $VcpkgRoot "scripts\buildsystems\vcpkg.cmake"
$Installed = Join-Path $VcpkgRoot "installed"
$Python = (Get-Command "python" -ErrorAction Stop).Source
$env:PYTHONUTF8 = "1"

# Keep the shared library and its ABI regression consumers on their default
# dynamic dependency; only the diagnostic gets the /MT static dependency.
Invoke-Checked $VcpkgExe @("install", "libsodium:x64-windows", "libsodium:x64-windows-static")
$StaticSodium = Join-Path $Installed "x64-windows-static\lib\libsodium.lib"
$SodiumNotice = Join-Path $Installed "x64-windows-static\share\libsodium\copyright"
Invoke-Checked "cmake" @(
    "-S", $RepositoryRoot, "-B", $BuildRoot, "-A", "x64",
    "-DCMAKE_TOOLCHAIN_FILE=$Toolchain", "-DVCPKG_TARGET_TRIPLET=x64-windows",
    "-DSCPEFE_BUILD_NODE_ADDON=OFF", "-DBUILD_TESTING=ON",
    "-DSCPEFE_STATIC_DIAGNOSTIC=ON", "-DSODIUM_STATIC_LIBRARY=$StaticSodium",
    "-DSCPEFE_SODIUM_LICENSE_FILE=$SodiumNotice", "-DPython3_EXECUTABLE=$Python"
)
Invoke-Checked "cmake" @("--build", $BuildRoot, "--config", "Release", "--parallel", "2")
$SodiumDlls = @(Get-ChildItem (Join-Path $Installed "x64-windows\bin") -Filter "*sodium*.dll")
if ($SodiumDlls.Count -ne 1) { throw "Expected exactly one shared libsodium DLL for ABI tests." }
Copy-Item $SodiumDlls[0].FullName $ReleaseRoot -Force
Invoke-Checked "ctest" @("--test-dir", $BuildRoot, "-C", "Release", "--output-on-failure", "--parallel", "1", "--timeout", "120")

$VsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$VisualStudio = & $VsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $VisualStudio) { throw "Visual C++ installation was not found." }
$Dumpbin = Get-ChildItem (Join-Path $VisualStudio "VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe") |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $Dumpbin) { throw "dumpbin.exe was not found." }
$Executable = Join-Path $ReleaseRoot "scpefe-diagnostic.exe"
$Dependencies = & $Dumpbin.FullName /DEPENDENTS $Executable
if ($LASTEXITCODE -ne 0) { throw "Cannot inspect the diagnostic import table." }
$Dependencies | Write-Host
$Imports = @($Dependencies | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_.-]+\.dll)\s*$') { $Matches[1].ToLowerInvariant() }
})
if ($Imports.Count -eq 0) { throw "No import-table evidence found." }
# Reject application DLLs and all MSVC/UCRT runtime imports, even on runners
# where those runtimes happen to be installed. Include delayed imports too.
$SystemDlls = @("kernel32.dll", "advapi32.dll", "bcrypt.dll", "crypt32.dll",
    "ws2_32.dll", "user32.dll", "shell32.dll", "ole32.dll", "ntdll.dll")
foreach ($Import in $Imports) {
    if ($Import -notin $SystemDlls -and $Import -notmatch '^api-ms-win-core-') {
        throw "Non-system dependency in static diagnostic: $Import"
    }
}

$IsolatedRoot = Join-Path $BuildRoot "isolated executable"
if (Test-Path $IsolatedRoot) { Remove-Item $IsolatedRoot -Recurse -Force }
New-Item -ItemType Directory -Force $IsolatedRoot | Out-Null
Copy-Item $Executable $IsolatedRoot
$IsolatedExecutable = Join-Path $IsolatedRoot "scpefe-diagnostic.exe"
$PreviousPath = $env:PATH
Push-Location $IsolatedRoot
try {
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    Invoke-Checked $IsolatedExecutable @("health")
    Invoke-Checked $IsolatedExecutable @("version")
    Invoke-Checked $IsolatedExecutable @("revision", (Join-Path $BuildRoot "snapshot-revision-v1.cbor"))
    Invoke-Checked $Python @(
        (Join-Path $RepositoryRoot "tests\diagnostic_licenses_test.py"),
        $IsolatedExecutable, $RepositoryRoot, $SodiumNotice
    )
    # The shared ABI is loaded by the test process only as an oracle. The child
    # CLI runs from a directory containing exactly one EXE and a system PATH.
    Invoke-Checked $Python @(
        (Join-Path $RepositoryRoot "tests\container_diagnostic_test.py"),
        $IsolatedExecutable, $RepositoryRoot, (Join-Path $ReleaseRoot "scpefe.dll")
    )
} finally {
    $env:PATH = $PreviousPath
    Pop-Location
}
if (@(Get-ChildItem $IsolatedRoot).Count -ne 1) {
    throw "Unexpected companion files appeared during isolated execution."
}
Write-Host "Static Windows diagnostic validated with system imports and a single isolated EXE: $Executable"
