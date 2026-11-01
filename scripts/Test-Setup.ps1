param([string]$SetupPath, [switch]$InstallOnHostedRunner)
$ErrorActionPreference = 'Stop'
if ($InstallOnHostedRunner -and ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted')) {
    throw 'Actual installation is allowed only on a GitHub-hosted Actions runner.'
}
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if (-not $SetupPath) { $SetupPath = Join-Path $root "release\Lekh-Markdown-editor-Setup-$($manifest.version)-x64.exe" }
$SetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
if (-not [Environment]::UserInteractive) { throw 'Setup preview verification requires an interactive Windows desktop.' }

# These switches verify the engine and embedded MSI without installing the application.
foreach ($argument in @('--self-test', '--verify-payload')) {
    $process = Start-Process -FilePath $SetupPath -ArgumentList $argument -PassThru -Wait
    try {
        if ($process.ExitCode -ne 0) { throw "Setup $argument failed (exit $($process.ExitCode))." }
    } finally {
        $process.Dispose()
    }
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class SetupVerificationDesktop
{
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadParameter(uint action, uint parameter, out int value, uint flags);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteParameter(uint action, uint parameter, IntPtr value, uint flags);
    public static bool GetClientAreaAnimation()
    {
        int value;
        if (!ReadParameter(0x1042, 0, out value, 0))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return value != 0;
    }
    public static void SetClientAreaAnimation(bool enabled)
    {
        if (!WriteParameter(0x1043, 0, new IntPtr(enabled ? 1 : 0), 2))
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
public static class SetupVerificationInstaller
{
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiGetProductInfoExW(string productCode, string userSid,
        uint context, string property, StringBuilder value, ref uint length);
    public static string GetProductProperty(string productCode, uint context, string property)
    {
        uint length = 0;
        // A NULL SID scopes per-user queries to the current user; machine queries also require NULL.
        uint result = MsiGetProductInfoExW(productCode, null, context, property, null, ref length);
        if (result == 1605) return null; // ERROR_UNKNOWN_PRODUCT is the only absence result.
        if (result != 0 && result != 234)
            throw new Win32Exception((int)result, "MsiGetProductInfoExW " + property +
                " failed for " + productCode + " in context " + context + " (error " + result + ").");
        for (int attempt = 0; attempt < 3; attempt++)
        {
            StringBuilder value = new StringBuilder(checked((int)length + 1));
            uint capacity = (uint)value.Capacity;
            result = MsiGetProductInfoExW(productCode, null, context, property, value, ref capacity);
            if (result == 1605) return null;
            if (result == 234) { length = capacity; continue; } // ERROR_MORE_DATA excludes the terminator.
            if (result != 0)
                throw new Win32Exception((int)result, "MsiGetProductInfoExW " + property +
                    " failed for " + productCode + " in context " + context + " (error " + result + ").");
            return value.ToString();
        }
        throw new InvalidOperationException("Windows Installer property changed repeatedly while reading " + property + ".");
    }
}
'@
function Set-HostedClientAreaAnimation([bool]$Enabled) {
    if (-not $InstallOnHostedRunner -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
        throw 'Desktop animation preferences may be changed only during opted-in GitHub-hosted verification.'
    }
    [SetupVerificationDesktop]::SetClientAreaAnimation($Enabled)
    if ([SetupVerificationDesktop]::GetClientAreaAnimation() -ne $Enabled) { throw 'Windows did not apply the requested animation test preference.' }
}
function Find-Control($Window, [string]$Id, [switch]$Raw) {
    $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $Id)
    if (-not $Raw) { return $Window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition) }
    $walker = [Windows.Automation.TreeWalker]::RawViewWalker
    $pending = [Collections.Generic.Stack[Windows.Automation.AutomationElement]]::new()
    $pending.Push($Window)
    while ($pending.Count -gt 0) {
        $element = $pending.Pop()
        if ($element.Current.AutomationId -eq $Id) { return $element }
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child) {
            $pending.Push($child)
            $child = $walker.GetNextSibling($child)
        }
    }
    return $null
}
function Test-ControlVisible($Control) {
    return $null -ne $Control -and -not $Control.Current.IsOffscreen
}
function Wait-Until([scriptblock]$Probe, [int]$TimeoutSeconds = 15, [string]$Message = 'Setup UI timed out.') {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $result = & $Probe
        if ($result) { return $result }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)
    throw $Message
}
function Wait-SetupWindow($Process, [string]$Label, [int]$TimeoutSeconds = 30) {
    $diagnostic = @{ Handle = '0'; Owner = '<missing>'; Heading = '<missing>'; Primary = '<missing>'; ProviderError = '<none>' }
    try {
        return Wait-Until {
            $Process.Refresh()
            if ($Process.HasExited) { throw "$Label exited before its accessible window was ready (exit $($Process.ExitCode))." }
            $handle = $Process.MainWindowHandle
            $diagnostic.Handle = $handle.ToString()
            $diagnostic.Heading = '<missing>'
            $diagnostic.Primary = '<missing>'
            if ($handle -eq [IntPtr]::Zero) { return $null }
            try {
                # Rebind each poll: an HWND can precede WPF's provider, or be replaced during startup.
                $candidate = [Windows.Automation.AutomationElement]::FromHandle($handle)
                $diagnostic.Owner = [string]$candidate.Current.ProcessId
                if ($candidate.Current.ProcessId -ne $Process.Id) {
                    $diagnostic.ProviderError = "Window provider reports process $($diagnostic.Owner), not $($Process.Id); waiting for the owned window."
                    return $null
                }
                $heading = Find-Control $candidate 'Heading'
                $primary = Find-Control $candidate 'Primary'
                if ($null -ne $heading) { $diagnostic.Heading = $heading.Current.Name }
                if ($null -ne $primary) { $diagnostic.Primary = $primary.Current.Name }
                $secondary = Find-Control $candidate 'Secondary'
                if ($null -ne $heading -and -not [string]::IsNullOrWhiteSpace($heading.Current.Name) -and
                    ($null -ne $primary -or $null -ne $secondary)) {
                    return $candidate
                }
            } catch [Windows.Automation.ElementNotAvailableException] {
                $diagnostic.ProviderError = $_.Exception.Message
            } catch [Runtime.InteropServices.COMException] {
                $diagnostic.ProviderError = "$($_.Exception.Message) (HRESULT $($_.Exception.HResult))"
            }
            return $null
        } $TimeoutSeconds "$Label did not expose its heading and available action accessibility within $TimeoutSeconds seconds."
    } catch {
        throw "$($_.Exception.Message) Window readiness diagnostic: pid=$($Process.Id); handle=$($diagnostic.Handle); owner=$($diagnostic.Owner); heading='$($diagnostic.Heading)'; primary='$($diagnostic.Primary)'; lastProviderError='$($diagnostic.ProviderError)'."
    }
}
function Read-StoryText($Control) {
    $text = [string]$Control.Current.Name
    $pattern = $null
    # StoryWritten explicitly publishes the live Run text in Name; its TextPattern may be stale.
    if ($Control.Current.AutomationId -ne 'StoryWritten' -and [string]::IsNullOrWhiteSpace($text)) {
        if ($Control.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $text = $pattern.DocumentRange.GetText(-1)
        } elseif ($Control.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $text = $pattern.Current.Value
        }
    }
    # WPF TextPattern represents the trailing InlineUIContainer quill as an embedded object.
    return $text.Replace([string][char]0xfffc, '').Trim()
}
function Get-StoryPage($Window, $CountControl) {
    $control = $CountControl
    if ($null -eq $control) { $control = Find-Control $Window 'StoryCount' }
    if ($null -eq $control) { return 0 }
    if ($control.Current.Name -match '^\s*([123])\s*(?:/|of)\s*3\s*$') { return [int]$Matches[1] }
    return 0
}
function Get-StoryDiagnostic($Window) {
    try {
        $written = Find-Control $Window 'StoryWritten' -Raw
        $accessible = Find-Control $Window 'StoryAccessible' -Raw
        $pause = Find-Control $Window 'StoryPause'
        $count = Find-Control $Window 'StoryCount'
        $pattern = $null
        $patternLength = -1
        if ($null -ne $written -and $written.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $patternLength = $pattern.DocumentRange.GetText(-1).Length
        }
        return "Story diagnostic: animation=$([SetupVerificationDesktop]::GetClientAreaAnimation()); pause='$($pause.Current.Name)'; pauseEnabled=$($pause.Current.IsEnabled); partialNameLength=$(([string]$written.Current.Name).Length); partialReadLength=$((Read-StoryText $written).Length); textPatternLength=$patternLength; fullLength=$(([string]$accessible.Current.Name).Trim().Length); writtenId='$($written.Current.AutomationId)'; count='$($count.Current.Name)'."
    } catch { return "Story diagnostic unavailable: $($_.Exception.Message)" }
}
function Test-Story($Window, [switch]$ReducedMotion) {
    try {
        foreach ($id in @('StoryPrevious', 'StoryNext', 'StoryPause', 'StoryCount', 'StoryTitle')) {
            if ($null -eq (Find-Control $Window $id)) { throw "Installing preview is missing accessible story control $id." }
        }
        $written = Find-Control $Window 'StoryWritten' -Raw
        $accessible = Find-Control $Window 'StoryAccessible' -Raw
        $storyCount = Find-Control $Window 'StoryCount'
        $storyTitle = Find-Control $Window 'StoryTitle'
        if ($null -eq $written -or $null -eq $accessible) { throw 'Installing preview must expose StoryWritten and StoryAccessible in the raw UI Automation tree.' }
        [void](Wait-Until { (Get-StoryPage $Window $storyCount) -eq 1 } 45 'Story did not cycle to page 1 after its controls became accessible.')
        $complete = $accessible.Current.Name.Trim()
        if ([string]::IsNullOrWhiteSpace($complete)) { throw 'StoryAccessible.Name must expose the exact complete paragraph without the title.' }
        if (-not $storyTitle.Current.Name.Trim().EndsWith($complete, [StringComparison]::Ordinal)) {
            throw 'The screen-reader title does not contain the complete story paragraph.'
        }
        if ($ReducedMotion) {
            [void](Wait-Until { (Read-StoryText $written) -ceq $complete } 5 'Reduced-motion story did not immediately expose its complete paragraph.')
            $static = [Diagnostics.Stopwatch]::StartNew()
            while ($static.Elapsed.TotalMilliseconds -lt 2200) {
                if ((Get-StoryPage $Window $storyCount) -ne 1 -or (Read-StoryText $written) -cne $complete) {
                    throw 'Reduced-motion story changed text or automatically advanced instead of staying static.'
                }
                Start-Sleep -Milliseconds 50
            }
            Write-Host 'PASS: reduced-motion story displays the complete, static paragraph. SKIP: motion-specific typing/autoplay UI measurement because client-area animation is disabled; engine story self-tests still ran.'
            return
        }
        $previousText = ''
        $growth = 0
        $typed = $false
        $sample = [Diagnostics.Stopwatch]::StartNew()
        while ($sample.Elapsed.TotalSeconds -lt 8 -and (Get-StoryPage $Window $storyCount) -eq 1) {
            $text = Read-StoryText $written
            if ($text.Length -ge 3 -and $text.Length -lt $complete.Length -and $complete.StartsWith($text, [StringComparison]::Ordinal)) {
                if ($previousText.Length -ge 3 -and $text.Length -gt $previousText.Length -and
                    $text.StartsWith($previousText, [StringComparison]::Ordinal)) { $growth++ }
                $previousText = $text
                if ($growth -ge 2) { $typed = $true }
            }
            if ($typed) { break }
            Start-Sleep -Milliseconds 50
        }
        if (-not $typed) { throw 'Installing preview did not expose progressive, genuinely typed story text.' }
        foreach ($page in @(1, 2, 3)) {
            [void](Wait-Until { (Get-StoryPage $Window $storyCount) -eq $page } 45 "Story did not automatically advance to page $page.")
            $fullText = $accessible.Current.Name.Trim()
            if ([string]::IsNullOrWhiteSpace($fullText)) { throw "Page $page has no complete accessible text." }
            # Allow 100 ms of sampling/scheduling tolerance around the two-second completed-page hold.
            [void](Wait-Until {
                if ((Get-StoryPage $Window $storyCount) -ne $page) { throw "Page $page advanced before its complete text was observed." }
                $text = Read-StoryText $written
                if ($text -cne $fullText) { return $false }
                $hold = [Diagnostics.Stopwatch]::StartNew()
                while ($hold.Elapsed.TotalMilliseconds -lt 1900) {
                    if ((Get-StoryPage $Window $storyCount) -ne $page) { throw "Page $page did not hold for two seconds after typing." }
                    if ((Read-StoryText $written) -cne $fullText) { throw "Page $page changed its completed paragraph during the hold." }
                    Start-Sleep -Milliseconds 25
                }
                return $true
            } 30 "Page $page never finished typing with a two-second hold.")
        }
        Write-Host 'PASS: story types progressively, automatically cycles 1 -> 2 -> 3, and holds completed pages for two seconds.'
    } catch {
        throw "$($_.Exception.Message) $(Get-StoryDiagnostic $Window)"
    }
}
function Test-SetupPreview([string]$State, [bool]$MotionEnabled) {
    $preview = Start-Process -FilePath $SetupPath -ArgumentList "--preview=$state" -PassThru
    $window = $null
    try {
        $window = Wait-SetupWindow $preview "Preview $state"
        if ($window.Current.ProcessId -ne $preview.Id) { throw 'Preview window belongs to a different process.' }
        if ($window.Current.ItemStatus -cne $state) { throw "Preview $state does not expose its actual native state through UI Automation." }
        if ($state -eq 'installing') { Test-Story $window -ReducedMotion:(-not $MotionEnabled) }
        $heading = (Find-Control $window 'Heading').Current.Name
        $description = (Find-Control $window 'Description').Current.Name
        $primary = Find-Control $window 'Primary'
        if ($state -in @('ready', 'upgrade') -and ((Test-ControlVisible $primary) -or
            $description -like '*Save your work*')) {
            throw "Preview $state must not prompt for installation or app closure. Heading: $heading; description: $description."
        }
        if ($state -eq 'upgrade' -and ($heading -notlike '*0.8.1*' -or $heading -notlike "*$($manifest.version)*")) {
            throw 'Upgrade preview must identify both the previous and new version.'
        }
        if ($state -eq 'installed' -and ((Test-ControlVisible $primary) -or
            $heading -notlike "*$($manifest.version)*already installed*")) {
            throw 'Same-version preview must report already installed without offering reinstall.'
        }
        if ($state -eq 'open') {
            $primary = Wait-Until {
                $candidate = Find-Control $window 'Primary'
                if ((Test-ControlVisible $candidate) -and $candidate.Current.Name -ceq 'Check again') { return $candidate }
                return $null
            } -Message 'The running-app preview did not expose a visible Check again action.'
            if ($description -notlike '*Save your work and close Lekh*') {
                throw 'Only the running-app preview asks users to save/close and check again.'
            }
        }
        if ($state -eq 'removing' -and ($description -notlike '*0.8.1*' -or
            (Find-Control $window 'Stages').Current.Name -notlike '*REMOVE OLD*' -or
            (Find-Control $window 'Notice').Current.Name -notlike '*new application payload has not started*')) {
            throw 'Removal preview must state the old version and that new payload has not started.'
        }
        if ($state -eq 'rollback' -and $heading -cne 'Rolling back changes.') { throw 'Rollback preview must describe restoration, not successful installation.' }
        Write-Host "PASS: native accessible preview $state."
    } finally {
        if (-not $preview.HasExited) {
            try {
                if ($null -ne $window) {
                    $pattern = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
                    $pattern.Close()
                }
            } catch { Write-Warning "Could not close preview $state through WindowPattern: $_" }
            if (-not $preview.WaitForExit(5000)) {
                Stop-Process -Id $preview.Id -Force -ErrorAction SilentlyContinue
                [void]$preview.WaitForExit(5000)
            }
        }
        $preview.Dispose()
    }
}
$originalAnimation = [SetupVerificationDesktop]::GetClientAreaAnimation()
Write-Host "Desktop client-area animation before verification: $originalAnimation."
try {
    if ($InstallOnHostedRunner) { Set-HostedClientAreaAnimation $true }
    $motionEnabled = [SetupVerificationDesktop]::GetClientAreaAnimation()
    foreach ($state in @('installing', 'ready', 'upgrade', 'installed', 'downgrade', 'open', 'preparing', 'removing', 'finishing', 'rollback', 'success', 'restart', 'error', 'stopping', 'cancelled')) {
        Test-SetupPreview $state $motionEnabled
    }
    if ($InstallOnHostedRunner) {
        Set-HostedClientAreaAnimation $false
        Test-SetupPreview 'installing' $false
    }
} finally {
    if ($InstallOnHostedRunner) {
        Set-HostedClientAreaAnimation $originalAnimation
        Write-Host "Restored desktop client-area animation: $originalAnimation."
    }
}
function Read-MsiProperty($Database, [string]$Name) {
    $view = $Database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$Name'")
    $record = $null
    try {
        [void]$view.Execute()
        $record = $view.Fetch()
        if ($null -ne $record) { return $record.StringData(1) }
        return ''
    } finally {
        if ($null -ne $record) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        [void]$view.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    }
}
function Test-ExactMsiRegistration([string]$ProductCode, [uint32]$Context) {
    # ProductName is available for both advertised and installed instances.
    return $null -ne [SetupVerificationInstaller]::GetProductProperty($ProductCode, $Context, 'ProductName')
}
function Read-HostedSetupStatus($Window) {
    $status = [ordered]@{
        State = $Window.Current.ItemStatus
        Heading = ''
        Description = ''
        Details = ''
    }
    foreach ($field in @('Heading', 'Description')) {
        $control = Find-Control $Window $field
        if ($null -ne $control) { $status[$field] = [string]$control.Current.Name }
    }
    if ($status.State -cin @('error', 'cancelled', 'restart', 'open', 'detection-error', 'downgrade', 'installed')) {
        $detail = Find-Control $Window 'DetailText' -Raw
        $pattern = $null
        if ($null -ne $detail -and $detail.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $status.Details = [string]$pattern.Current.Value
        }
    }
    return [pscustomobject]$status
}
function Test-HostedSetupProgress($Status) {
    if ($Status.State -ceq 'success') {
        if ($Status.Heading.Replace([char]0x2019, [char]0x27) -cne "You're ready to write.") {
            throw "Native success state has an unexpected accessible heading: $($Status.Heading)."
        }
        return $true
    }
    if ($Status.State -cin @('error', 'cancelled', 'restart', 'open', 'detection-error', 'downgrade', 'installed')) {
        throw "Hosted setup entered native state '$($Status.State)': $($Status.Heading) $($Status.Description)`n$($Status.Details)"
    }
    return $false
}
function Test-HostedSetupLogOwner([string]$Header, [string]$Owner, [int]$ProcessId, [string]$Version) {
    return $Header -cmatch ('^\S+ Starting Lekh Setup ' + [regex]::Escape($Version) + '\. Current-user, offline installation\.$') -and
        $Owner -cmatch ('^\S+ Setup process ' + $ProcessId + '\.$')
}
function Save-HostedSetupDiagnostics($Process, $Status, [string]$Destination) {
    if (-not $InstallOnHostedRunner -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
        throw 'Setup log capture is allowed only during opted-in GitHub-hosted verification.'
    }
    # Reuse the existing failure artifact path; do not sweep or upload unrelated user/setup sessions.
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $Destination 'setup-status.log'), ($Status | ConvertTo-Json -Depth 3),
        [Text.UTF8Encoding]::new($false))
    $source = Join-Path $env:LOCALAPPDATA 'Lekh\SetupLogs'
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        Write-Host 'No setup log directory was created; see setup-status.log.'
        return
    }
    $rootEntry = Get-Item -LiteralPath $source -Force
    if (($rootEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing linked setup log directory.' }
    $captured = 0
    foreach ($session in @(Get-ChildItem -LiteralPath $source -Directory -Force)) {
        if (($session.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            $session.Name -cnotmatch '^\d{8}-\d{6}-[0-9a-f]{32}$') { continue }
        $setupLog = Join-Path $session.FullName 'setup.log'
        if (-not (Test-Path -LiteralPath $setupLog -PathType Leaf)) { continue }
        $entry = Get-Item -LiteralPath $setupLog -Force
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing linked setup log file.' }
        $header = @(Get-Content -LiteralPath $setupLog -TotalCount 2)
        if ($header.Count -ne 2 -or -not (Test-HostedSetupLogOwner $header[0] $header[1] $Process.Id $manifest.version)) { continue }
        $owned = Join-Path $Destination $session.Name
        New-Item -ItemType Directory -Path $owned -Force | Out-Null
        foreach ($name in @('setup.log', 'windows-installer.log')) {
            $path = Join-Path $session.FullName $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            $entry = Get-Item -LiteralPath $path -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing linked installer diagnostic file.' }
            Copy-Item -LiteralPath $path -Destination (Join-Path $owned $name)
            Write-Host "Owned $name tail:"
            Get-Content -LiteralPath $path -Tail 30 | ForEach-Object { Write-Host $_ }
        }
        $captured++
    }
    Write-Host "Captured $captured owned setup session(s) at $Destination."
}
function Test-HostedInstallation {
    if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
        throw 'Refusing installation outside a GitHub-hosted Actions runner.'
    }
    $msi = (Resolve-Path -LiteralPath (Join-Path $root "release\Lekh-Markdown-editor-$($manifest.version)-x64.msi")).Path
    $installer = $null
    $database = $null
    $setup = $null
    $window = $null
    $attempted = $false
    $sentinel = $null
    $failure = $null
    $status = [pscustomobject]@{ State = ''; Heading = ''; Description = ''; Details = '' }
    $diagnosticDirectory = Join-Path $root ('build\setup\upgrade\fresh-setup-' + [guid]::NewGuid().ToString('N'))
    $cleanupErrors = [Collections.Generic.List[string]]::new()
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($msi, 0)
        $productCode = Read-MsiProperty $database 'ProductCode'
        if ($productCode -notmatch '^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$') {
            throw 'Internal MSI does not declare a precise ProductCode.'
        }
        if ((Read-MsiProperty $database 'ProductName') -cne $manifest.build.productName -or
            (Read-MsiProperty $database 'ProductVersion') -notin @($manifest.version, "$($manifest.version).0") -or
            (Read-MsiProperty $database 'UpgradeCode').Trim('{}') -ne 'DCBCF7FA-11DA-4F35-8D27-D066EEC6C582' -or
            (Read-MsiProperty $database 'MSIINSTALLPERUSER') -ne '1' -or
            (Read-MsiProperty $database 'ARPSYSTEMCOMPONENT') -eq '1' -or
            -not [string]::IsNullOrEmpty((Read-MsiProperty $database 'ALLUSERS'))) {
            throw 'Hosted installation requires the expected versioned, Apps-visible per-user MSI with the independent Lekh upgrade identity.'
        }
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
        $database = $null
        $installDirectory = Join-Path $env:LOCALAPPDATA 'lekh'
        $executable = Join-Path $installDirectory 'Lekh - Markdown editor.exe'
        if (Test-Path -LiteralPath $installDirectory) {
            throw 'Hosted installation requires a clean runner; refusing to replace or uninstall an existing application.'
        }
        foreach ($context in @(1, 2, 4)) {
            if (Test-ExactMsiRegistration $productCode $context) {
                throw "Existing exact product registration in context $context; refusing destructive verification."
            }
        }
        $profileDirectory = Join-Path $env:APPDATA 'Lekh'
        New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
        $sentinel = Join-Path $profileDirectory ("setup-profile-sentinel-" + [guid]::NewGuid().ToString('N') + '.txt')
        $sentinelContent = 'Preserve user profile: ' + [guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText($sentinel, $sentinelContent, [Text.UTF8Encoding]::new($false))
        $setup = Start-Process -FilePath $SetupPath -PassThru
        $attempted = $true
        $window = Wait-SetupWindow $setup 'Hosted setup'
        if ($window.Current.ProcessId -ne $setup.Id) { throw 'Hosted setup window belongs to a different process.' }
        [void](Wait-Until {
            if ($setup.HasExited) { throw 'Hosted setup exited before its success heading appeared.' }
            $setup.Refresh()
            $candidate = [Windows.Automation.AutomationElement]::FromHandle($setup.MainWindowHandle)
            if ($candidate.Current.ProcessId -ne $setup.Id) { throw 'Hosted setup progress provider belongs to another process.' }
            $window = $candidate
            $current = Read-HostedSetupStatus $candidate
            $status.State = $current.State
            $status.Heading = $current.Heading
            $status.Description = $current.Description
            $status.Details = $current.Details
            return Test-HostedSetupProgress $status
        } 240 'Hosted setup never reached the ready-to-write success heading.')
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Installed executable is missing: $executable" }
        $registration = @{}
        foreach ($property in @('InstalledProductName', 'VersionString', 'LocalPackage')) {
            $registration[$property] = [SetupVerificationInstaller]::GetProductProperty($productCode, 2, $property)
        }
        if ($registration.InstalledProductName -cne $manifest.build.productName -or
            $registration.VersionString -notin @($manifest.version, "$($manifest.version).0") -or
            [string]::IsNullOrWhiteSpace($registration.LocalPackage) -or
            -not (Test-Path -LiteralPath $registration.LocalPackage -PathType Leaf)) {
            throw 'Exact current-user USERUNMANAGED (context 2) Windows Installer name, version or cached package registration is incorrect.'
        }
        foreach ($context in @(1, 4)) {
            if (Test-ExactMsiRegistration $productCode $context) {
                throw "Installed product unexpectedly registered in context $context instead of only current-user USERUNMANAGED."
            }
        }
        if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf) -or [IO.File]::ReadAllText($sentinel) -cne $sentinelContent) {
            throw 'Installing modified or removed the user profile sentinel.'
        }
        Write-Host "PASS: hosted setup automatically installed $productCode without an Install prompt; Windows Installer confirms current-user USERUNMANAGED context 2, InstalledProductName, VersionString and LocalPackage; MSI is Apps-visible. Application was not launched."
    } catch {
        $failure = $_
    } finally {
        $setupExited = $true
        if ($null -ne $setup) {
            try {
                if (-not $setup.HasExited) {
                    if ($null -eq $window) { throw 'Cannot safely close a setup window that was never discovered.' }
                    $close = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
                    $close.Close()
                    if (-not $setup.WaitForExit(120000)) { throw 'Hosted setup did not close; refusing concurrent uninstall.' }
                }
            } catch {
                $setupExited = $setup.HasExited
                $cleanupErrors.Add("Closing hosted setup: $_")
            }
        }
        if ($attempted -and $null -ne $failure) {
            try { Save-HostedSetupDiagnostics $setup $status $diagnosticDirectory }
            catch { $failure.Exception.Data['SetupDiagnosticCaptureError'] = $_.Exception.Message; Write-Warning "Setup diagnostic capture failed: $_" }
        }
        if ($attempted -and $setupExited) {
            try {
                $logDirectory = Join-Path $root 'build\setup'
                New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
                $log = Join-Path $logDirectory 'hosted-uninstall.log'
                $uninstall = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\msiexec.exe') -ArgumentList @(
                    '/x', $productCode, '/qn', '/norestart', 'REBOOT=ReallySuppress',
                    'MSIRESTARTMANAGERCONTROL=DisableShutdown', 'MSIDISABLERMRESTART=1', '/L*v', "`"$log`""
                ) -PassThru -Wait
                try {
                    if ($uninstall.ExitCode -notin @(0, 1605, 1614, 3010)) {
                        throw "Exact-product uninstall failed (exit $($uninstall.ExitCode)); see $log."
                    }
                } finally { $uninstall.Dispose() }
                if (Test-Path -LiteralPath $executable) {
                    throw 'Exact-product uninstall left the application executable behind.'
                }
                foreach ($context in @(1, 2, 4)) {
                    if (Test-ExactMsiRegistration $productCode $context) {
                        throw "Exact-product uninstall left Windows Installer registration in context $context."
                    }
                }
                Write-Host "PASS: hosted exact-product uninstall removed $productCode and its executable; Windows Installer confirms no current-user or machine registration."
            } catch { $cleanupErrors.Add("Uninstall verification: $_") }
        }
        if ($null -ne $sentinel) {
            try {
                if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf) -or [IO.File]::ReadAllText($sentinel) -cne $sentinelContent) {
                    throw 'The profile sentinel was removed or modified; user data was not preserved.'
                }
                Write-Host "PASS: user profile sentinel preserved at $sentinel."
            } catch { $cleanupErrors.Add("Profile verification: $_") }
        }
        if ($null -ne $database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
        if ($null -ne $installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
        if ($null -ne $setup) { $setup.Dispose() }
    }
    if ($null -ne $failure) { Write-Error -ErrorAction Continue $failure }
    if ($cleanupErrors.Count -gt 0) { throw ($cleanupErrors -join "`n") }
    if ($null -ne $failure) { throw $failure }
}
if ($InstallOnHostedRunner) {
    Test-HostedInstallation
    Write-Host 'PASS: setup engine, offline payload, previews and hosted install/uninstall. The application was not launched.'
} else {
    Write-Host 'PASS: setup engine, offline payload, and native previews. No application was installed, uninstalled, launched or closed.'
}
