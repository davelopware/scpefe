function Wait-ExecutableReleased {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [int]$TimeoutMilliseconds = 30000,
        [int]$PollMilliseconds = 100
    )

    $ExecutablePath = [System.IO.Path]::GetFullPath($Executable)
    $ProcessName = [System.IO.Path]::GetFileNameWithoutExtension($ExecutablePath)
    $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $LastError = $null
    $MatchingProcessIds = @()
    $ReportedProcesses = $false
    $ReportedFileLock = $false
    while ($Stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        $MatchingProcessIds = @(
            Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
                Where-Object {
                    try {
                        [System.IO.Path]::GetFullPath($_.Path) -ieq $ExecutablePath
                    } catch {
                        $false
                    }
                } |
                Select-Object -ExpandProperty Id
        )
        if ($MatchingProcessIds.Count -ne 0) {
            if (-not $ReportedProcesses) {
                Write-Host "Waiting for executable process IDs $($MatchingProcessIds -join ', '): $ExecutablePath"
                $ReportedProcesses = $true
            }
        } else {
            $Stream = $null
            try {
                $Stream = [System.IO.File]::Open(
                    $ExecutablePath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::None
                )
                return $Stopwatch.ElapsedMilliseconds
            } catch [System.IO.IOException] {
                $LastError = $_
                if (-not $ReportedFileLock) {
                    Write-Host "Waiting for executable file lock: $ExecutablePath"
                    $ReportedFileLock = $true
                }
            } catch [System.UnauthorizedAccessException] {
                $LastError = $_
                if (-not $ReportedFileLock) {
                    Write-Host "Waiting for executable file lock: $ExecutablePath"
                    $ReportedFileLock = $true
                }
            } finally {
                if ($null -ne $Stream) { $Stream.Dispose() }
            }
        }
        Start-Sleep -Milliseconds $PollMilliseconds
    }

    $ProcessDetail = if ($MatchingProcessIds.Count -eq 0) {
        "no process with that executable path remains"
    } else {
        "matching process IDs: $($MatchingProcessIds -join ', ')"
    }
    $OpenDetail = if ($null -eq $LastError) {
        "exclusive open was not attempted while the process remained live"
    } else {
        "last open error: $($LastError.Exception.Message)"
    }
    throw "Executable remained active or locked for ${TimeoutMilliseconds}ms " +
        "($ProcessDetail; $OpenDetail): $ExecutablePath"
}

function Invoke-PackagedTest {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(Mandatory = $true)][string]$Addon
    )

    Write-Host "> $Executable $Script $Addon"
    $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $Executable
    $StartInfo.Arguments = '"{0}" "{1}"' -f $Script, $Addon
    $StartInfo.UseShellExecute = $false
    $Process = [System.Diagnostics.Process]::Start($StartInfo)
    try {
        if (-not $Process.WaitForExit(120000)) {
            $Process.Kill()
            $Process.WaitForExit()
            throw "Packaged test timed out after 120 seconds: $Script"
        }
        if ($Process.ExitCode -ne 0) {
            throw "Packaged test failed with exit code $($Process.ExitCode): $Script"
        }
    } finally {
        $Process.Dispose()
    }

    $UnlockWait = Wait-ExecutableReleased $Executable
    if ($UnlockWait -gt 0) {
        Write-Host "Executable released after ${UnlockWait}ms: $Executable"
    }
}
