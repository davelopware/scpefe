[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Executable = Join-Path $PackageRoot "SCPEFE.exe"
if (-not (Test-Path $Executable)) {
    throw "Packaged SCPEFE executable was not found at '$Executable'."
}

function Quote-Argument {
    param([string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Start-Preview {
    param(
        [string[]]$Arguments,
        [string]$SmokeDirectory,
        [hashtable]$ExtraEnvironment = @{}
    )
    $StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $StartInfo.FileName = $Executable
    $StartInfo.WorkingDirectory = $PackageRoot
    $StartInfo.UseShellExecute = $false
    $StartInfo.Arguments = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join " "
    $StartInfo.EnvironmentVariables["SCPEFE_SINGLE_INSTANCE_SMOKE_DIR"] = $SmokeDirectory
    foreach ($Entry in $ExtraEnvironment.GetEnumerator()) {
        $StartInfo.EnvironmentVariables[[string]$Entry.Key] = [string]$Entry.Value
    }
    return [System.Diagnostics.Process]::Start($StartInfo)
}

function Read-Events {
    param([string]$SmokeDirectory)
    $Log = Join-Path $SmokeDirectory "events.jsonl"
    if (-not (Test-Path $Log)) { return @() }
    return @(
        Get-Content $Log -ErrorAction SilentlyContinue |
            Where-Object { $_ } |
            ForEach-Object {
                try { $_ | ConvertFrom-Json } catch { $null }
            } |
            Where-Object { $null -ne $_ }
    )
}

function Wait-Until {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Condition,
        [Parameter(Mandatory = $true)][string]$Description,
        [int]$TimeoutMilliseconds = 20000
    )
    $Watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($Watch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "Timed out waiting for $Description."
}

function Stop-Preview {
    param([System.Diagnostics.Process]$Process)
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            $Process.Kill()
            $Process.WaitForExit(10000) | Out-Null
        }
    } finally {
        $Process.Dispose()
    }
}

$TemporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) `
    "scpefe-single-instance-$([System.Guid]::NewGuid())"
$ResponsivePrimary = $null
$Second = $null
$Third = $null
$Focus = $null
$UnresponsivePrimary = $null
$TimedOutSecondary = $null
try {
    New-Item -ItemType Directory -Force $TemporaryRoot | Out-Null
    $ResponsiveSmoke = Join-Path $TemporaryRoot "responsive-events"
    $ResponsiveUserData = Join-Path $TemporaryRoot "responsive-user-data"
    $StartupTarget = Join-Path $TemporaryRoot "startup.scpefe"
    $SecondTarget = Join-Path $TemporaryRoot "second.scpefe"
    $ThirdTarget = Join-Path $TemporaryRoot "third.scpefe"
    New-Item -ItemType File -Force $StartupTarget, $SecondTarget, $ThirdTarget | Out-Null

    $ResponsivePrimary = Start-Preview `
        -Arguments @("--user-data-dir=$ResponsiveUserData", $StartupTarget) `
        -SmokeDirectory $ResponsiveSmoke `
        -ExtraEnvironment @{
            SCPEFE_SINGLE_INSTANCE_SMOKE_READY_DELAY_MS = "1000"
            SCPEFE_SINGLE_INSTANCE_SMOKE_COMPLETE_MS = "5000"
        }
    Wait-Until -Description "the startup request to survive renderer startup" -Condition {
        $Events = Read-Events $ResponsiveSmoke
        @($Events | Where-Object { $_.event -eq "presented" }).Count -ge 1
    }

    $Second = Start-Preview `
        -Arguments @("--user-data-dir=$ResponsiveUserData", $SecondTarget) `
        -SmokeDirectory $ResponsiveSmoke
    Start-Sleep -Milliseconds 100
    $Third = Start-Preview `
        -Arguments @("--user-data-dir=$ResponsiveUserData", $ThirdTarget) `
        -SmokeDirectory $ResponsiveSmoke
    Start-Sleep -Milliseconds 3500
    if ($Second.HasExited -or $Third.HasExited) {
        throw "Queued launches did not wait for their authenticated terminal outcomes."
    }
    if ($ResponsivePrimary.HasExited) {
        throw "The responsive primary was killed or bypassed while a request was queued."
    }
    if (@((Read-Events $ResponsiveSmoke) |
        Where-Object { $_.event -eq "handoff-timeout" }).Count -ne 0) {
        throw "A queued acknowledgement was incorrectly treated as an unresponsive primary."
    }
    if (-not $Second.WaitForExit(20000) -or -not $Third.WaitForExit(20000)) {
        throw "Responsive secondary launches did not receive routed acknowledgements."
    }
    if ($Second.ExitCode -ne 0 -or $Third.ExitCode -ne 0) {
        throw "Responsive secondary launch exited unsuccessfully."
    }
    $Focus = Start-Preview `
        -Arguments @("--user-data-dir=$ResponsiveUserData") `
        -SmokeDirectory $ResponsiveSmoke
    if (-not $Focus.WaitForExit(20000) -or $Focus.ExitCode -ne 0) {
        throw "Focus-only second launch did not complete successfully."
    }
    Wait-Until -Description "ordered completion of all responsive requests" -Condition {
        @((Read-Events $ResponsiveSmoke) |
            Where-Object { $_.event -eq "presented" }).Count -ge 4
    }
    $Presented = @((Read-Events $ResponsiveSmoke) |
        Where-Object { $_.event -eq "presented" })
    $Expected = @("startup.scpefe", "second.scpefe", "third.scpefe", $null)
    for ($Index = 0; $Index -lt $Expected.Count; $Index += 1) {
        if ($Presented[$Index].target -ne $Expected[$Index]) {
            throw "Request order mismatch at ${Index}: expected '$($Expected[$Index])', " +
                "observed '$($Presented[$Index].target)'."
        }
    }
    $Events = Read-Events $ResponsiveSmoke
    $Completed = @($Events | Where-Object { $_.event -eq "completed" })
    if ($Completed.Count -ne 3) {
        throw "Expected three renderer-completed target requests."
    }
    for ($Index = 0; $Index -lt 3; $Index += 1) {
        if ($Completed[$Index].target -ne $Expected[$Index] `
            -or $Completed[$Index].outcome -ne "renderer-canceled") {
            throw "Renderer completion order or outcome mismatch at ${Index}."
        }
    }
    $Acknowledged = @($Events | Where-Object { $_.event -eq "handoff-acknowledged" })
    if ($Acknowledged.Count -ne 3 `
        -or @($Acknowledged | Where-Object {
            $_.status -notin @("canceled", "focused") -or $_.sequence -ne 3
        }).Count -ne 0) {
        throw "Secondary launches did not observe authenticated terminal outcomes."
    }
    $ReadyIndex = [array]::IndexOf(@($Events.event), "renderer-ready")
    $FirstPresentedIndex = [array]::IndexOf(@($Events.event), "presented")
    if ($ReadyIndex -lt 0 -or $FirstPresentedIndex -le $ReadyIndex) {
        throw "The startup request was not staged until renderer readiness."
    }
    if ($ResponsivePrimary.HasExited) {
        throw "The responsive primary exited during routed launches."
    }

    Stop-Preview $ResponsivePrimary
    $ResponsivePrimary = $null
    Start-Sleep -Milliseconds 500

    $UnresponsiveSmoke = Join-Path $TemporaryRoot "unresponsive-events"
    $UnresponsiveUserData = Join-Path $TemporaryRoot "unresponsive-user-data"
    $UnresponsivePrimary = Start-Preview `
        -Arguments @("--user-data-dir=$UnresponsiveUserData") `
        -SmokeDirectory $UnresponsiveSmoke `
        -ExtraEnvironment @{ SCPEFE_SINGLE_INSTANCE_SMOKE_STALL = "1" }
    Wait-Until -Description "the unresponsive fixture primary to become ready" -Condition {
        @((Read-Events $UnresponsiveSmoke) |
            Where-Object { $_.event -eq "renderer-ready" }).Count -ge 1
    }
    $TimedOutSecondary = Start-Preview `
        -Arguments @("--user-data-dir=$UnresponsiveUserData", $SecondTarget) `
        -SmokeDirectory $UnresponsiveSmoke
    if (-not $TimedOutSecondary.WaitForExit(15000) -or $TimedOutSecondary.ExitCode -ne 0) {
        throw "Unresponsive-instance timeout launch did not exit cleanly."
    }
    if ($UnresponsivePrimary.HasExited) {
        throw "The unresponsive existing instance was killed or bypassed."
    }
    $Timeout = @((Read-Events $UnresponsiveSmoke) |
        Where-Object { $_.event -eq "handoff-timeout" })
    if ($Timeout.Count -ne 1 -or $Timeout[0].existingInstancePreserved -ne $true) {
        throw "The unresponsive handoff did not record a safe timeout."
    }
    Write-Host "Packaged Windows single-instance smoke passed."
} finally {
    foreach ($Process in @($Focus, $Third, $Second, $TimedOutSecondary,
        $ResponsivePrimary, $UnresponsivePrimary)) {
        Stop-Preview $Process
    }
    if (Test-Path $TemporaryRoot) {
        Remove-Item $TemporaryRoot -Recurse -Force
    }
}
