$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "windows-preview-process.ps1")

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    "scpefe-process-test-$([System.Guid]::NewGuid())"
$HeldExecutable = Join-Path $TemporaryRoot "held-preview-process.exe"
$Process = $null
try {
    New-Item -ItemType Directory -Force $TemporaryRoot | Out-Null
    Copy-Item (Get-Command "node").Source $HeldExecutable

    $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $HeldExecutable
    $StartInfo.Arguments = '-e "setTimeout(() => {}, 750)"'
    $StartInfo.UseShellExecute = $false
    $Process = [System.Diagnostics.Process]::Start($StartInfo)

    $Elapsed = Wait-ExecutableReleased `
        -Executable $HeldExecutable `
        -TimeoutMilliseconds 10000 `
        -PollMilliseconds 25
    if ($Elapsed -lt 500) {
        throw "File-release barrier returned while the executable was still running " +
            "(${Elapsed}ms)."
    }
    $Process.WaitForExit()
    if ($Process.ExitCode -ne 0) {
        throw "Synthetic executable holder exited with $($Process.ExitCode)."
    }
    Write-Host "Windows executable-release regression passed (${Elapsed}ms)."
} finally {
    if ($null -ne $Process) {
        if (-not $Process.HasExited) {
            $Process.Kill()
            $Process.WaitForExit()
        }
        $Process.Dispose()
    }
    if (Test-Path $TemporaryRoot) {
        Remove-Item $TemporaryRoot -Recurse -Force
    }
}
