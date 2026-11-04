param([string]$SetupPath, [switch]$InstallOnHostedRunner)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function Assert-HostedRunner {
    if (-not $InstallOnHostedRunner -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
        throw 'Upgrade verification requires -InstallOnHostedRunner on a GitHub-hosted Actions runner.'
    }
}
Assert-HostedRunner
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) {
    throw 'Upgrade verification requires 64-bit Windows PowerShell.'
}

# Deliberately bounded to this published lineage; neither asset nor identity is caller-selectable.
$oldSetupUrl = 'https://github.com/dennispadia/lekh/releases/download/v0.9.10/Lekh-Markdown-editor-Setup-0.9.10-x64.exe'
$oldSetupHash = '280ebdc4c71758ea94545ecb9bda85c15d9db8f37b3899290e272242dc705aeb'
$oldSetupBytes = 197615104L
$upgradeCode = '{DCBCF7FA-11DA-4F35-8D27-D066EEC6C582}'
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
if ($manifest.version -cne '0.9.11' -or $manifest.build.productName -cne 'Lekh - Markdown editor' -or
    $manifest.build.msi.upgradeCode -cne $upgradeCode.Trim('{}')) {
    throw 'This check supports only the genuine published 0.9.10 -> 0.9.11 Lekh upgrade.'
}
if (-not $SetupPath) { $SetupPath = Join-Path $root "release\Lekh-Markdown-editor-Setup-$($manifest.version)-x64.exe" }
$SetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$installDirectory = Join-Path $env:LOCALAPPDATA 'lekh'
$profileDirectory = Join-Path $env:APPDATA 'Lekh'
$work = Join-Path $root ('build\setup\upgrade\' + [guid]::NewGuid().ToString('N'))
$sources = Join-Path $work 'sources'
$cleanRunnerVerified = $false
$attemptedProducts = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$ownedProducts = @{}
$profileHashes = @{}
$failure = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()
$activeSetup = $null

# Microsoft API contracts: silent UI suppresses elevation too; NULL SID means current user.
# https://learn.microsoft.com/windows/win32/api/msi/nf-msi-msisetinternalui
# https://learn.microsoft.com/windows/win32/api/msi/nf-msi-msigetproductinfoexw
# https://learn.microsoft.com/windows/win32/api/msi/nf-msi-msienumrelatedproductsw
# https://learn.microsoft.com/windows/win32/api/msi/nf-msi-msiinstallproductw
# https://learn.microsoft.com/windows/win32/api/msi/nf-msi-msiconfigureproductexw
$nativeSource = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class UpgradeVerificationInstaller
{
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiEnumRelatedProductsW(string upgradeCode, uint reserved, uint index, StringBuilder productCode);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiGetProductInfoExW(string productCode, string userSid, uint context,
        string property, StringBuilder value, ref uint length);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiInstallProductW(string package, string properties);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiConfigureProductExW(string productCode, int level, int state, string properties);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiEnableLogW(uint mode, string path, uint attributes);
    [DllImport("msi.dll", ExactSpelling = true)]
    private static extern uint MsiSetInternalUI(uint level, IntPtr window);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate int RecordHandler(IntPtr context, uint message, uint record);
    [DllImport("msi.dll", ExactSpelling = true)]
    private static extern uint MsiSetExternalUIRecord(RecordHandler handler, uint filter, IntPtr context, out RecordHandler previous);
    [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint MsiRecordGetStringW(uint record, uint field, StringBuilder value, ref uint length);

    private static string ActionName(uint record)
    {
        uint length = 0;
        uint result = MsiRecordGetStringW(record, 1, null, ref length);
        if (result != 0 && result != 234) throw new Win32Exception((int)result);
        StringBuilder value = new StringBuilder(checked((int)length + 1));
        length = (uint)value.Capacity;
        result = MsiRecordGetStringW(record, 1, value, ref length);
        if (result != 0) throw new Win32Exception((int)result);
        return value.ToString();
    }
    private static bool PathExistsExact(string path)
    {
        try { File.GetAttributes(path); return true; }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    public static string[] RelatedProducts(string upgradeCode)
    {
        List<string> products = new List<string>();
        // All calls remain on this thread. Never treat enumeration errors as an empty family.
        for (uint index = 0; index < 256; index++)
        {
            StringBuilder product = new StringBuilder(39);
            uint result = MsiEnumRelatedProductsW(upgradeCode, 0, index, product);
            if (result == 259) return products.ToArray(); // ERROR_NO_MORE_ITEMS
            if (result != 0) throw new Win32Exception((int)result, "Cannot enumerate related MSI products.");
            products.Add(product.ToString());
        }
        throw new InvalidOperationException("Unexpectedly large related MSI product family.");
    }
    public static string ProductProperty(string productCode, uint context, string property)
    {
        uint length = 0;
        uint result = MsiGetProductInfoExW(productCode, null, context, property, null, ref length);
        if (result == 1605) return null; // Only ERROR_UNKNOWN_PRODUCT proves absence.
        if (result != 0 && result != 234) throw new Win32Exception((int)result, "Cannot query " + property);
        for (int attempt = 0; attempt < 3; attempt++)
        {
            StringBuilder value = new StringBuilder(checked((int)length + 1));
            uint capacity = (uint)value.Capacity;
            result = MsiGetProductInfoExW(productCode, null, context, property, value, ref capacity);
            if (result == 1605) return null;
            if (result == 234) { length = capacity; continue; }
            if (result != 0) throw new Win32Exception((int)result, "Cannot query " + property);
            return value.ToString();
        }
        throw new InvalidOperationException("MSI property changed repeatedly: " + property);
    }
    public static bool NeedsPreviousRemoval(string operation, string previousCode)
    {
        // PowerShell binds JSON null to String.Empty for C# string parameters.
        bool absent = String.IsNullOrEmpty(previousCode);
        if (operation == "Uninstall")
        {
            if (!absent) throw new InvalidOperationException("An exact-product uninstall must not request previous-version removal verification.");
            return false;
        }
        if (operation != "Install" && operation != "RollbackUpgrade")
            throw new InvalidOperationException("Unsupported native MSI operation.");
        if (absent)
        {
            if (operation == "RollbackUpgrade")
                throw new InvalidOperationException("Rollback proof requires a previous exact ProductCode.");
            return false;
        }
        Guid product;
        if (previousCode.Length != 38 || previousCode[0] != '{' || previousCode[37] != '}' || !Guid.TryParse(previousCode, out product))
            throw new InvalidOperationException("Previous-version verification requires a valid braced ProductCode.");
        return true;
    }
    public static void AssertRemovalCheckpoint(bool required, bool observed)
    {
        if (required && !observed) throw new InvalidOperationException("Required real removal checkpoint was never observed.");
    }
    public static uint Execute(string operation, string target, string log, string previousCode, string directory)
    {
        bool verifyPrevious = NeedsPreviousRemoval(operation, previousCode);
        const string properties = "REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=DisableShutdown MSIDISABLERMRESTART=1";
        uint result = MsiEnableLogW(0x1fff, log, 3); // Append; flush each line for timeout diagnostics.
        if (result != 0) throw new Win32Exception((int)result, "Cannot enable MSI logging.");
        uint previousUI = MsiSetInternalUI(2, IntPtr.Zero); // INSTALLUILEVEL_NONE; never UACONLY.
        if (previousUI == 0) throw new InvalidOperationException("Cannot suppress MSI UI and elevation.");
        bool removalVerified = false;
        Exception callbackFailure = null;
        RecordHandler previousHandler = null;
        bool registered = false;
        RecordHandler handler = delegate(IntPtr context, uint message, uint record) {
            try
            {
                if ((message & 0xff000000) != 0x08000000) return 0;
                string action = ActionName(record);
                File.AppendAllText(log + ".stages.log", "ACTION " + action + Environment.NewLine);
                if (action == "LekhPreviousVersionRemoved" && verifyPrevious)
                {
                    foreach (uint scope in new uint[] { 1, 2, 4 })
                        if (ProductProperty(previousCode, scope, "ProductName") != null)
                            throw new InvalidOperationException("Previous exact ProductCode remains registered before new payload.");
                    if (PathExistsExact(Path.Combine(directory, "Lekh - Markdown editor.exe")) ||
                        PathExistsExact(Path.Combine(directory, "resources", "app.asar")))
                        throw new InvalidOperationException("Previous executable/app.asar remains before new payload.");
                    removalVerified = true;
                    File.AppendAllText(log + ".stages.log", "PROVEN old registration/executable/app.asar absent before new payload." + Environment.NewLine);
                    if (operation == "RollbackUpgrade") return 2; // Cancel only after actual old removal, still inside rollback.
                }
                return 1;
            }
            catch (Exception error) { callbackFailure = error; return 2; }
        };
        try
        {
            result = MsiSetExternalUIRecord(handler, 1u << 8, IntPtr.Zero, out previousHandler);
            if (result != 0) throw new Win32Exception((int)result, "Cannot register upgrade checkpoint verification.");
            registered = true;
            if (operation == "Install" || operation == "RollbackUpgrade") result = MsiInstallProductW(target, properties);
            else if (operation == "Uninstall") result = MsiConfigureProductExW(target, 0, 2, properties); // INSTALLSTATE_ABSENT
            else throw new InvalidOperationException("Unsupported native MSI operation.");
            if (callbackFailure != null) throw new InvalidOperationException("Removal checkpoint verification failed.", callbackFailure);
            AssertRemovalCheckpoint(verifyPrevious, removalVerified);
            return result;
        }
        finally
        {
            if (registered)
            {
                RecordHandler ignored;
                MsiSetExternalUIRecord(previousHandler, 0, IntPtr.Zero, out ignored);
            }
            MsiSetInternalUI(previousUI, IntPtr.Zero);
            MsiEnableLogW(0, null, 0);
            GC.KeepAlive(handler);
        }
    }
}
'@
Add-Type -TypeDefinition $nativeSource

function Read-MsiRows($Database, [string]$Query, [int]$Columns) {
    $view = $Database.OpenView($Query)
    try {
        [void]$view.Execute()
        while ($record = $view.Fetch()) {
            try {
                $values = @()
                for ($index = 1; $index -le $Columns; $index++) { $values += $record.StringData($index) }
                ,$values
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        }
    } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
}
function Expand-EmbeddedMsi([string]$Setup, [string]$Destination) {
    # Resource-only inspection: never execute either EXE or its entry point.
    $assembly = [Reflection.Assembly]::LoadFile($Setup)
    $resource = $assembly.GetManifestResourceStream('Setup.Payload.msi')
    if ($null -eq $resource) { throw 'Setup is missing its embedded Setup.Payload.msi.' }
    try {
        $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try { $resource.CopyTo($output) } finally { $output.Dispose() }
    } finally { $resource.Dispose() }
}
function Read-ValidatedMsi([string]$Path, [string]$Version) {
    $installer = $null
    $database = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($Path, 0)
        $properties = @{}
        foreach ($row in (Read-MsiRows $database 'SELECT `Property`, `Value` FROM `Property`' 2)) {
            $properties[$row[0]] = $row[1]
        }
        if ($properties.ProductCode -notmatch '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$' -or
            $properties.ProductName -cne $manifest.build.productName -or $properties.UpgradeCode -ine $upgradeCode -or
            $properties.ProductVersion -notin @($Version, "$Version.0") -or $properties.MSIINSTALLPERUSER -cne '1' -or
            $properties.ContainsKey('ALLUSERS') -or
            ($properties.ContainsKey('ARPSYSTEMCOMPONENT') -and $properties.ARPSYSTEMCOMPONENT -eq '1')) {
            throw "Unexpected MSI identity, version or per-user scope for $Version."
        }
        $summary = $database.SummaryInformation(0)
        try {
            if (([int]$summary.Property(15) -band 8) -eq 0 -or $summary.Property(7) -notmatch '^x64;') {
                throw 'MSI must be x64 and explicitly non-elevated.'
            }
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary) }
        $directories = @(Read-MsiRows $database 'SELECT `Directory_Parent`, `DefaultDir` FROM `Directory` WHERE `Directory` = ''APPLICATIONFOLDER''' 2)
        if ($directories.Count -ne 1 -or $directories[0][0] -cne 'LocalAppDataFolder' -or
            ($directories[0][1] -split '\|')[-1] -cne 'lekh') { throw 'Unexpected per-user application directory.' }
        $media = @(Read-MsiRows $database 'SELECT `Cabinet` FROM `Media`' 1)
        if ($media.Count -eq 0 -or @($media | Where-Object { $_[0] -notlike '#*' }).Count -gt 0) {
            throw 'Upgrade validation requires self-contained embedded MSI cabinets.'
        }
        $upgrades = @(Read-MsiRows $database 'SELECT `UpgradeCode` FROM `Upgrade`' 1)
        if ($upgrades.Count -eq 0 -or @($upgrades | Where-Object { $_[0] -ine $upgradeCode }).Count -gt 0) {
            throw 'MSI upgrade table has an unexpected upgrade identity.'
        }
        if ($Version -eq $manifest.version) {
            $sequence = @{}
            foreach ($row in (Read-MsiRows $database 'SELECT `Action`, `Sequence` FROM `InstallExecuteSequence`' 2)) { $sequence[$row[0]] = [int]$row[1] }
            if (-not $sequence.ContainsKey('LekhPreviousVersionRemoved') -or
                $sequence.RemoveExistingProducts -ne $sequence.InstallInitialize + 1 -or
                $sequence.LekhPreviousVersionRemoved -ne $sequence.RemoveExistingProducts + 1 -or
                $sequence.LekhPreviousVersionRemoved -ge $sequence.ProcessComponents -or
                $sequence.LekhPreviousVersionRemoved -ge $sequence.InstallFiles) { throw 'New MSI lacks transactional remove-old-before-new scheduling.' }
            foreach ($action in $sequence.Keys) {
                if ($sequence[$action] -ge $sequence.InstallInitialize -and $sequence[$action] -le $sequence.LekhPreviousVersionRemoved -and
                    $action -cnotin @('InstallInitialize', 'RemoveExistingProducts', 'LekhPreviousVersionRemoved')) {
                    throw "Unexpected MSI action before removal verification: $action."
                }
            }
            $checkpoint = @(Read-MsiRows $database 'SELECT `Type`, `Source`, `Target` FROM `CustomAction` WHERE `Action` = ''LekhPreviousVersionRemoved''' 3)
            $checkpointSequence = @(Read-MsiRows $database 'SELECT `Condition` FROM `InstallExecuteSequence` WHERE `Action` = ''LekhPreviousVersionRemoved''' 1)
            if ($checkpoint.Count -ne 1 -or $checkpoint[0][0] -cne '51' -or
                $checkpoint[0][1] -cne 'LEKH_PREVIOUS_VERSION_REMOVED' -or $checkpoint[0][2] -cne '1' -or
                $checkpointSequence.Count -ne 1 -or $checkpointSequence[0][0] -cne 'WIX_UPGRADE_DETECTED AND NOT Installed') {
                throw 'New MSI has an unexpected removal checkpoint implementation or condition.'
            }
            $guard = @(Read-MsiRows $database 'SELECT `Condition` FROM `LaunchCondition`' 1)
            if (@($guard | Where-Object { $_[0] -ceq 'NOT RollbackDisabled' }).Count -ne 1) { throw 'New MSI must refuse rollback-disabled installation.' }
        }
        return [pscustomobject]@{ Path = $Path; ProductCode = $properties.ProductCode; Version = $Version }
    } finally {
        if ($null -ne $database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
        if ($null -ne $installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    }
}
function Test-Registration([string]$ProductCode, [uint32]$Context) {
    return $null -ne [UpgradeVerificationInstaller]::ProductProperty($ProductCode, $Context, 'ProductName')
}
function Assert-Absent([string]$ProductCode) {
    foreach ($context in @(1, 2, 4)) {
        if (Test-Registration $ProductCode $context) { throw "Product $ProductCode remains registered in context $context." }
    }
}
function Assert-Installed($Product) {
    foreach ($context in @(1, 4)) {
        if (Test-Registration $Product.ProductCode $context) { throw "Product unexpectedly registered in context $context." }
    }
    $name = [UpgradeVerificationInstaller]::ProductProperty($Product.ProductCode, 2, 'InstalledProductName')
    $version = [UpgradeVerificationInstaller]::ProductProperty($Product.ProductCode, 2, 'VersionString')
    $cached = [UpgradeVerificationInstaller]::ProductProperty($Product.ProductCode, 2, 'LocalPackage')
    if ($name -cne $manifest.build.productName -or $version -notin @($Product.Version, "$($Product.Version).0") -or
        [string]::IsNullOrWhiteSpace($cached) -or -not (Test-Path -LiteralPath $cached -PathType Leaf)) {
        throw "Incorrect current-user USERUNMANAGED registration for $($Product.ProductCode)."
    }
    $related = @([UpgradeVerificationInstaller]::RelatedProducts($upgradeCode))
    if ($related.Count -ne 1 -or $related[0] -ine $Product.ProductCode) { throw 'Unexpected related product registrations.' }
    if (-not (Test-Path -LiteralPath (Join-Path $installDirectory "$($manifest.build.productName).exe") -PathType Leaf)) {
        throw 'Registered product is missing its installed executable.'
    }
}
function Assert-AppNotRunning {
    if (@(Get-Process -Name 'Lekh - Markdown editor' -ErrorAction SilentlyContinue).Count -gt 0) {
        throw 'Lekh is running; refusing to close it or perform maintenance.'
    }
}
function Assert-CleanApplicationDirectory([string]$Path, [string]$ExpectedCacheHash, [string]$Version) {
    if ($ExpectedCacheHash -notmatch '^[0-9A-Fa-f]{64}$' -or $Version -notmatch '^\d+\.\d+\.\d+$') {
        throw 'A verified current MSI hash and version are required to recognize setup residue.'
    }
    function Assert-PlainEntry($Entry, [bool]$Directory) {
        if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Unsafe application directory: reparse point at $($Entry.FullName)."
        }
        if ($Entry.PSIsContainer -ne $Directory) {
            throw "Unsafe application directory: unexpected file/directory type at $($Entry.FullName)."
        }
    }
    $fullPath = [IO.Path]::GetFullPath($Path)
    $applicationRoot = $null
    $ancestor = [IO.DirectoryInfo]::new($fullPath)
    while ($null -ne $ancestor) {
        $entry = $null
        try { $entry = Get-Item -LiteralPath $ancestor.FullName -Force }
        catch [Management.Automation.ItemNotFoundException] { }
        if ($null -ne $entry) {
            Assert-PlainEntry $entry $true
            if ($ancestor.FullName -ieq $fullPath) { $applicationRoot = $entry }
        }
        $ancestor = $ancestor.Parent
    }
    if ($null -eq $applicationRoot) { return }

    # Windows treats the MSI's "lekh" and the bootstrapper's "Lekh" as the same directory.
    # Only the exact retained layout authored by Payload.Extract and the bootstrapper is allowed.
    # Never delete or broadly ignore these directories: their contents must be recognized too.
    foreach ($entry in @(Get-ChildItem -LiteralPath $fullPath -Force)) {
        Assert-PlainEntry $entry $true
        if ($entry.Name -ine 'SetupCache' -and $entry.Name -ine 'SetupLogs') {
            throw "Unsafe application directory: unexpected root entry $($entry.Name)."
        }
        foreach ($session in @(Get-ChildItem -LiteralPath $entry.FullName -Force)) {
            Assert-PlainEntry $session $true
            $files = @(Get-ChildItem -LiteralPath $session.FullName -Force)
            if ($entry.Name -ieq 'SetupCache') {
                if ($session.Name -notmatch '^[0-9a-f]{32}$' -or $files.Count -ne 1 -or $files[0].Name -ine 'Lekh.msi') {
                    throw "Unsafe application directory: unexpected setup cache layout at $($session.FullName)."
                }
                Assert-PlainEntry $files[0] $false
                if ((Get-FileHash -LiteralPath $files[0].FullName -Algorithm SHA256).Hash -ine $ExpectedCacheHash) {
                    throw "Unsafe application directory: setup cache checksum mismatch at $($files[0].FullName)."
                }
            } else {
                if ($session.Name -notmatch '^\d{8}-\d{6}-[0-9a-f]{32}$' -or $files.Count -ne 2) {
                    throw "Unsafe application directory: unexpected setup log layout at $($session.FullName)."
                }
                foreach ($file in $files) {
                    Assert-PlainEntry $file $false
                    if ($file.Name -inotmatch '^(setup|windows-installer)\.log$' -or $file.Length -eq 0) {
                        throw "Unsafe application directory: unexpected setup log file at $($file.FullName)."
                    }
                }
                if (@($files | Where-Object { $_.Name -ieq 'setup.log' }).Count -ne 1 -or
                    @($files | Where-Object { $_.Name -ieq 'windows-installer.log' }).Count -ne 1) {
                    throw "Unsafe application directory: missing expected setup logs at $($session.FullName)."
                }
                $firstLine = Get-Content -LiteralPath (Join-Path $session.FullName 'setup.log') -TotalCount 1
                if ($firstLine -cnotmatch ('^\S+ Starting Lekh Setup ' + [regex]::Escape($Version) + '\. Current-user, offline installation\.$')) {
                    throw "Unsafe application directory: unrecognized setup log identity at $($session.FullName)."
                }
            }
        }
    }
}
function Assert-ProfilePreserved {
    foreach ($path in $profileHashes.Keys) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or
            (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $profileHashes[$path]) {
            throw "Profile data was changed or removed: $path"
        }
    }
}
function Get-PayloadHashes {
    $hashes = @{}
    foreach ($file in (Get-ChildItem -LiteralPath $installDirectory -Recurse -File)) {
        $relative = $file.FullName.Substring($installDirectory.Length + 1)
        $hashes[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
    }
    if ($hashes.Count -lt 2 -or -not $hashes.ContainsKey('resources\app.asar')) { throw 'Incomplete installed payload.' }
    return $hashes
}
function Get-UpgradeWorkerCommand([string]$InputPath) {
    if ([string]::IsNullOrEmpty($InputPath)) { throw 'An owned worker input path is required.' }
    $path64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($InputPath))
    $header = "`$inputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$path64'))"
    $body = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([IO.File]::ReadAllText($inputPath))) | ConvertFrom-Json
$request = $inputData.Request
if (-not $request.ExplicitOptIn -or -not $request.CleanRunnerVerified -or
    $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw "Refusing unapproved MSI worker (opt-in=$($request.ExplicitOptIn); clean=$($request.CleanRunnerVerified); actions=$env:GITHUB_ACTIONS; runner=$env:RUNNER_ENVIRONMENT)."
}
Add-Type -TypeDefinition $inputData.NativeSource
exit [int][UpgradeVerificationInstaller]::Execute($request.Operation, $request.Target, $request.Log, $request.PreviousCode, $request.Directory)
'@
    return $header + "`n" + $body
}
function Invoke-UpgradeMsi([ValidateSet('Install', 'Repair', 'Uninstall', 'RollbackUpgrade')][string]$Operation, $Product, [string]$Label) {
    Assert-HostedRunner
    if (-not $cleanRunnerVerified -or -not $ownedProducts.ContainsKey($Product.ProductCode) -or
        $ownedProducts[$Product.ProductCode].Path -cne $Product.Path) { throw 'Refusing unowned MSI operation.' }
    if ($null -ne $activeSetup -and -not $activeSetup.HasExited) { throw 'Setup is still active; refusing concurrent product maintenance.' }
    Assert-AppNotRunning
    $log = Join-Path $work "$Label.log"
    $inputPath = $null
    if ($Operation -eq 'Repair') {
        # /fomus is real maintenance, not another fresh installation.
        # https://learn.microsoft.com/windows/win32/msi/reinstallmode
        $program = Join-Path $env:WINDIR 'System32\msiexec.exe'
        $arguments = @('/fomus', $Product.ProductCode, '/qn', '/norestart',
            'REBOOT=ReallySuppress', 'MSIRESTARTMANAGERCONTROL=DisableShutdown', 'MSIDISABLERMRESTART=1', '/L*vx', "`"$log`"")
    } else {
        $previousCode = $null
        if ($Operation -in @('Install', 'RollbackUpgrade') -and $Product.ProductCode -ieq $new.ProductCode -and
            (Test-Registration $old.ProductCode 2)) {
            if (-not $ownedProducts.ContainsKey($old.ProductCode)) { throw 'Refusing unowned previous-product verification.' }
            $previousCode = $old.ProductCode
        }
        if ($Operation -eq 'RollbackUpgrade' -and $null -eq $previousCode) { throw 'Rollback proof requires the owned, registered old product.' }
        $request = @{
            Operation = $Operation
            Target = $(if ($Operation -in @('Install', 'RollbackUpgrade')) { $Product.Path } else { $Product.ProductCode })
            Log = $log
            ExplicitOptIn = $InstallOnHostedRunner.IsPresent
            CleanRunnerVerified = $cleanRunnerVerified
            PreviousCode = $previousCode
            Directory = $installDirectory
        }
        $payload = @{ Request = $request; NativeSource = $nativeSource } | ConvertTo-Json -Depth 4 -Compress
        $inputPath = Join-Path $work "$Label.worker-input.b64"
        $output = [IO.File]::Open($inputPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)))
            $output.Write($bytes, 0, $bytes.Length)
        } finally { $output.Dispose() }
        $command = Get-UpgradeWorkerCommand $inputPath
        $program = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arguments = @('-NoProfile', '-NonInteractive', '-EncodedCommand',
            [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))
    }
    $process = $null
    $inputGuard = $null
    try {
        $start = @{
            FilePath = $program
            ArgumentList = $arguments
            PassThru = $true
            RedirectStandardOutput = (Join-Path $work "$Label.stdout.log")
            RedirectStandardError = (Join-Path $work "$Label.stderr.log")
        }
        if ($null -ne $inputPath) {
            $inputGuard = [IO.File]::Open($inputPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        }
        $process = Start-Process @start
        $null = $process.Handle
        if (-not $process.WaitForExit(240000)) {
            # Only this owned caller may be stopped; never kill an application or MSI service.
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
            if (-not $process.WaitForExit(10000)) { throw "$Label caller could not be stopped; sources retained at $sources." }
            throw "$Label exceeded 240 seconds; owned caller stopped, MSI sources retained at $sources."
        }
        if ($Operation -eq 'RollbackUpgrade' -and $process.ExitCode -ne 1602) {
            throw "Rollback proof must cancel after verified removal (expected 1602, received $($process.ExitCode)); see $log."
        }
        if ($Operation -ne 'RollbackUpgrade' -and $process.ExitCode -notin @(0, 3010)) {
            throw "$Label failed (exit $($process.ExitCode)); see $log and its stderr log."
        }
        if ($process.ExitCode -eq 3010) { Write-Host "$Label requested a restart; restart suppressed, checking registration and bytes without rebooting." }
    } finally {
        if ($null -ne $process) { $process.Dispose() }
        if ($null -ne $inputGuard) { $inputGuard.Dispose() }
    }
}

function Read-UpgradeSetup($Process) {
    $Process.Refresh()
    if ($Process.HasExited) { throw "Setup exited before the expected state (exit $($Process.ExitCode))." }
    if ($Process.MainWindowHandle -eq [IntPtr]::Zero) { return $null }
    try {
        $window = [Windows.Automation.AutomationElement]::FromHandle($Process.MainWindowHandle)
        if ($window.Current.ProcessId -ne $Process.Id) { return $null }
        $state = $window.Current.ItemStatus
        $controls = @{}
        foreach ($id in @('Heading', 'Description', 'Primary')) {
            $condition = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
            $controls[$id] = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
        }
        if ($null -eq $controls.Heading -or $null -eq $controls.Description) { return $null }
        $heading = $controls.Heading.Current.Name
        $description = $controls.Description.Current.Name
        $primaryVisible = $null -ne $controls.Primary -and -not $controls.Primary.Current.IsOffscreen
        if ($window.Current.ItemStatus -cne $state) { return $null }
        return [pscustomobject]@{
            Window = $window; State = $state
            Heading = $heading; Description = $description
            Primary = $controls.Primary; PrimaryVisible = $primaryVisible
        }
    } catch [Windows.Automation.ElementNotAvailableException] { return $null }
    catch [Runtime.InteropServices.COMException] { return $null }
}
function Wait-UpgradeSetup($Process, [string]$Expected, $Stages, [int]$Seconds = 240, [switch]$AllowPendingOpen) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $pendingRecheck = $AllowPendingOpen.IsPresent
    do {
        $status = Read-UpgradeSetup $Process
        if ($null -ne $status) {
            if ($Stages.Count -eq 0 -or $Stages[$Stages.Count - 1] -cne $status.State) { $Stages.Add($status.State) }
            if ($Expected -ceq 'success' -and $status.State -cin @('upgrade', 'preparing')) {
                $expectedHeading = "Upgrading Lekh $($old.Version) to $($new.Version)."
                if ($status.Heading -cne $expectedHeading -or $status.PrimaryVisible) {
                    throw "Idle upgrade mismatch in state '$($status.State)': expected heading '$expectedHeading'; actual heading '$($status.Heading)'; primary visible: $($status.PrimaryVisible)."
                }
            }
            if ($status.State -ceq $Expected) { return $status }
            if ($status.State -cin @('error', 'cancelled', 'restart', 'detection-error', 'downgrade', 'installed', 'open')) {
                if ($pendingRecheck -and $status.State -ceq 'open') {
                    if ($timer.Elapsed.TotalSeconds -ge 30) { throw 'Setup did not process Check again within 30 seconds.' }
                } else {
                    throw "Setup entered '$($status.State)' instead of '$Expected': $($status.Heading) $($status.Description)"
                }
            } else {
                $pendingRecheck = $false
            }
        }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "Setup did not reach '$Expected'; observed states: $($Stages -join ', ')."
}
function Assert-PayloadPreserved($Expected) {
    $actual = Get-PayloadHashes
    if ($actual.Count -ne $Expected.Count) { throw 'Setup changed the installed payload file set while blocked.' }
    foreach ($path in $Expected.Keys) {
        if (-not $actual.ContainsKey($path) -or $actual[$path] -cne $Expected[$path]) {
            throw "Setup changed blocked payload bytes: $path"
        }
    }
}
function Save-UpgradeSetupDiagnostics([int]$ProcessId, [string[]]$Stages) {
    Assert-HostedRunner
    if (-not $cleanRunnerVerified) { throw 'Refusing setup log capture without clean-runner ownership.' }
    $destination = Join-Path $work ("setup-$ProcessId")
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $destination 'observed-states.log'), ($Stages -join [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false))
    $source = Join-Path $env:LOCALAPPDATA 'Lekh\SetupLogs'
    if (-not (Test-Path -LiteralPath $source -PathType Container)) {
        Write-Warning 'No setup log directory was created for the owned upgrade process.'
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
        if ($header.Count -ne 2 -or
            $header[0] -cnotmatch ('^\S+ Starting Lekh Setup ' + [regex]::Escape($manifest.version) + '\. Current-user, offline installation\.$') -or
            $header[1] -cnotmatch ('^\S+ Setup process ' + $ProcessId + '\.$')) { continue }
        $owned = Join-Path $destination $session.Name
        New-Item -ItemType Directory -Path $owned -Force | Out-Null
        foreach ($name in @('setup.log', 'windows-installer.log')) {
            $path = Join-Path $session.FullName $name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            $entry = Get-Item -LiteralPath $path -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing linked installer diagnostic file.' }
            Copy-Item -LiteralPath $path -Destination (Join-Path $owned $name)
        }
        $captured++
    }
    if ($captured -eq 0) { Write-Warning "No setup log matched owned upgrade process $ProcessId." }
}
function Invoke-SetupScenario([switch]$OpenEditor, [switch]$AlreadyInstalled) {
    Assert-HostedRunner
    if (-not $cleanRunnerVerified) { throw 'Refusing UI verification without clean-runner ownership.' }
    if ($null -ne $activeSetup -and -not $activeSetup.HasExited) { throw 'Another owned setup is still active.' }
    Assert-AppNotRunning
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $editor = $null
    $setup = $null
    $window = $null
    $failure = $null
    $closeErrors = [Collections.Generic.List[string]]::new()
    $states = [Collections.Generic.List[string]]::new()
    $before = Get-PayloadHashes
    try {
        if ($OpenEditor) {
            if ($AlreadyInstalled) { Assert-Installed $new } else { Assert-Installed $old }
            $executable = Join-Path $installDirectory "$($manifest.build.productName).exe"
            $editor = Start-Process -FilePath $executable -ArgumentList ('--user-data-dir="' + (Join-Path $work 'owned-editor-profile') + '"') -PassThru
            $timer = [Diagnostics.Stopwatch]::StartNew()
            do {
                $editor.Refresh()
                if ($editor.HasExited) { throw 'Owned old editor exited before the running-app test.' }
                if ($editor.MainWindowHandle -ne [IntPtr]::Zero) { break }
                Start-Sleep -Milliseconds 100
            } while ($timer.Elapsed.TotalSeconds -lt 30)
            if ($editor.MainWindowHandle -eq [IntPtr]::Zero -or $editor.MainModule.FileName -ine $executable) {
                throw 'Could not verify the exact owned editor window.'
            }
        }
        $setup = Start-Process -FilePath $SetupPath -PassThru
        $script:activeSetup = $setup
        if ($AlreadyInstalled) {
            $status = Wait-UpgradeSetup $setup 'installed' $states 30
            $window = $status.Window
            if ($status.Heading -notlike "*$($manifest.version)*already installed*" -or
                $status.PrimaryVisible) {
                throw 'Same-version setup must report already installed without offering reinstall.'
            }
            Assert-Installed $new
            Assert-PayloadPreserved $before
            Assert-ProfilePreserved
            Write-Host 'PASS: same-version EXE reports already installed; no reinstall, payload or profile changes.'
        } else {
            if ($OpenEditor) {
                $status = Wait-UpgradeSetup $setup 'open' $states 30
                $window = $status.Window
                if ($status.Description -notlike '*Save your work and close Lekh*' -or
                    $status.Description -notlike '*0.9.10*' -or $null -eq $status.Primary -or
                    $status.Primary.Current.Name -cne 'Check again') { throw 'Running editor did not produce the save/close and recheck prompt.' }
                Assert-Installed $old
                Assert-Absent $new.ProductCode
                Assert-PayloadPreserved $before
                Assert-ProfilePreserved
                if (-not $editor.CloseMainWindow() -or -not $editor.WaitForExit(30000)) {
                    throw 'Owned blank editor did not close gracefully; no forced closure is permitted.'
                }
                Assert-AppNotRunning
                $status.Primary.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
            }
            $status = Wait-UpgradeSetup $setup 'success' $states -AllowPendingOpen:$OpenEditor.IsPresent
            $window = $status.Window
            if ($status.Heading.Replace([char]0x2019, [char]0x27) -cne "You're ready to write.") { throw 'Unexpected success heading.' }
            if (-not $states.Contains('upgrade') -and -not $states.Contains('preparing')) {
                throw "Real upgrade never exposed its version heading to UI Automation: $($states -join ', ')."
            }
            if (-not $states.Contains('removing') -or -not $states.Contains('installing') -or
                $states.IndexOf('removing') -ge $states.IndexOf('installing')) {
                throw "Real upgrade did not show removal before installation: $($states -join ', ')."
            }
            Assert-Installed $new
            Assert-Absent $old.ProductCode
            Assert-ProfilePreserved
            Write-Host "PASS: real EXE upgrade, running editor=$($OpenEditor.IsPresent); removal precedes installation, one recheck if needed, no extra Install prompt."
        }
    } catch {
        $failure = $_
    } finally {
        try {
            if ($null -ne $editor -and -not $editor.HasExited) {
                $editor.Refresh()
                if ($editor.MainModule.FileName -ine (Join-Path $installDirectory "$($manifest.build.productName).exe") -or
                    -not $editor.CloseMainWindow() -or -not $editor.WaitForExit(30000)) {
                    throw 'Could not gracefully close the exact owned test editor.'
                }
            }
        } catch { $closeErrors.Add("Owned editor cleanup: $_") }
        try {
            if ($null -ne $setup -and -not $setup.HasExited) {
                if ($null -eq $window) {
                    $lastStatus = Read-UpgradeSetup $setup
                    if ($null -ne $lastStatus) { $window = $lastStatus.Window }
                }
                if ($null -eq $window) { throw 'Cannot safely close an undiscovered setup window.' }
                $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern).Close()
                if (-not $setup.WaitForExit(15000)) { throw 'Owned setup did not close; no forced termination is permitted.' }
            }
        } catch { $closeErrors.Add("Owned setup cleanup: $_") }
        if ($null -ne $failure -and $null -ne $setup) {
            try { Save-UpgradeSetupDiagnostics $setup.Id $states }
            catch { $closeErrors.Add("Owned setup diagnostic capture: $_"); Write-Warning "Owned setup diagnostic capture failed: $_" }
        }
        if ($null -ne $editor) { $editor.Dispose() }
        if ($null -ne $setup -and $setup.HasExited) { $setup.Dispose(); $script:activeSetup = $null }
    }
    if ($null -ne $failure) {
        if ($closeErrors.Count -gt 0) { $failure.Exception.Data['SetupCleanupErrors'] = $closeErrors -join "`n" }
        throw $failure
    }
    if ($closeErrors.Count -gt 0) { throw ($closeErrors -join "`n") }
}

New-Item -ItemType Directory -Path $sources -Force | Out-Null
Start-Transcript -Path (Join-Path $work 'verification.log') | Out-Null
try {
    Write-Host 'Scope: pinned public 0.9.10 -> manifest 0.9.11, rollback, idle auto-upgrade, same-version rejection, running-app close/recheck upgrade, repair and exact-product uninstall. No other lineage is covered.'
    $oldSetup = Join-Path $sources 'Lekh-Markdown-editor-Setup-0.9.10-x64.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $oldSetupUrl -OutFile $oldSetup -TimeoutSec 180 -UseDefaultCredentials:$false
    if ((Get-Item -LiteralPath $oldSetup).Length -ne $oldSetupBytes -or
        (Get-FileHash -LiteralPath $oldSetup -Algorithm SHA256).Hash.ToLowerInvariant() -cne $oldSetupHash) {
        throw 'Published 0.9.10 setup length or pinned SHA-256 mismatch; refusing extraction.'
    }
    $oldMsi = Join-Path $sources 'old-0.9.10.msi'
    $newMsi = Join-Path $sources 'new-0.9.11.msi'
    Expand-EmbeddedMsi $oldSetup $oldMsi
    Expand-EmbeddedMsi $SetupPath $newMsi
    $old = Read-ValidatedMsi $oldMsi '0.9.10'
    $new = Read-ValidatedMsi $newMsi $manifest.version
    if ($old.ProductCode -ieq $new.ProductCode) { throw 'Major upgrade must have different old and new ProductCodes.' }
    $builtMsi = Join-Path $root "release\Lekh-Markdown-editor-$($manifest.version)-x64.msi"
    $newMsiHash = (Get-FileHash -LiteralPath $newMsi -Algorithm SHA256).Hash
    if ($newMsiHash -cne
        (Get-FileHash -LiteralPath $builtMsi -Algorithm SHA256).Hash) { throw 'New EXE embeds a different MSI from the verified build.' }
    foreach ($product in @($old, $new)) {
        Assert-Absent $product.ProductCode
        $ownedProducts[$product.ProductCode] = $product
    }
    if (@([UpgradeVerificationInstaller]::RelatedProducts($upgradeCode)).Count -ne 0) {
        throw 'Existing related MSI registration; refusing upgrade validation on a non-clean runner.'
    }
    Assert-CleanApplicationDirectory $installDirectory $newMsiHash $manifest.version
    Assert-AppNotRunning
    $settings = Join-Path $profileDirectory 'settings.json'
    if (Test-Path -LiteralPath $settings) { throw 'Existing profile settings; refusing to overwrite user data.' }
    $cleanRunnerVerified = $true
    New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
    $sentinel = Join-Path $profileDirectory ('upgrade-profile-sentinel-' + [guid]::NewGuid().ToString('N') + '.txt')
    [IO.File]::WriteAllText($sentinel, ('Preserve upgrade profile: ' + [guid]::NewGuid().ToString('N')), [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($settings, '{"theme":"light","fontSize":18,"upgradeValidation":"0.9.10-to-0.9.11"}', [Text.UTF8Encoding]::new($false))
    foreach ($path in @($sentinel, $settings)) { $profileHashes[$path] = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash }
    [void]$attemptedProducts.Add($old.ProductCode)
    Invoke-UpgradeMsi 'Install' $old 'old-install'
    Assert-Installed $old
    Assert-Absent $new.ProductCode
    Assert-ProfilePreserved
    Write-Host "PASS: genuine published 0.9.10 installed and registered as $($old.ProductCode)."

    $oldPayloadHashes = Get-PayloadHashes
    [void]$attemptedProducts.Add($new.ProductCode)
    Invoke-UpgradeMsi 'RollbackUpgrade' $new 'cancel-after-old-removal'
    Assert-Installed $old
    Assert-Absent $new.ProductCode
    Assert-ProfilePreserved
    $rollbackHashes = Get-PayloadHashes
    if ($rollbackHashes.Count -ne $oldPayloadHashes.Count) { throw 'Rollback did not restore the old payload file set.' }
    foreach ($relative in $oldPayloadHashes.Keys) {
        if (-not $rollbackHashes.ContainsKey($relative) -or $rollbackHashes[$relative] -cne $oldPayloadHashes[$relative]) {
            throw "Rollback did not restore old payload bytes: $relative"
        }
    }
    Write-Host 'PASS: cancellation after proven old removal restored exact old registration, every old payload byte and seeded profile data.'

    [void]$attemptedProducts.Add($new.ProductCode)
    Invoke-SetupScenario
    Invoke-SetupScenario -AlreadyInstalled
    Invoke-SetupScenario -AlreadyInstalled -OpenEditor
    Invoke-UpgradeMsi 'Uninstall' $new 'reset-for-running-editor'
    Invoke-UpgradeMsi 'Install' $old 'old-install-for-running-editor'
    Invoke-SetupScenario -OpenEditor
    Assert-Installed $new
    Assert-Absent $old.ProductCode
    Assert-ProfilePreserved
    $payloadHashes = Get-PayloadHashes
    foreach ($relative in @("$($manifest.build.productName).exe", 'resources\app.asar')) {
        $packaged = Join-Path (Join-Path $root 'release\win-unpacked') $relative
        if ($payloadHashes[$relative] -cne (Get-FileHash -LiteralPath $packaged -Algorithm SHA256).Hash) {
            throw "Upgraded $relative differs from the current packaged application."
        }
    }
    Write-Host "PASS: 0.9.11 exact registration and current executable/app.asar bytes; old registration removed before the new payload stage."
    Assert-AppNotRunning
    # Remove only a validated installed application file so repair must actually restore missing payload.
    Remove-Item -LiteralPath (Join-Path $installDirectory 'resources\app.asar') -Force
    Invoke-UpgradeMsi 'Repair' $new 'new-repair'
    Assert-Installed $new
    Assert-Absent $old.ProductCode
    $repairedHashes = Get-PayloadHashes
    if ($repairedHashes.Count -ne $payloadHashes.Count) { throw 'Repair changed the installed payload file set.' }
    foreach ($relative in $payloadHashes.Keys) {
        if (-not $repairedHashes.ContainsKey($relative) -or $repairedHashes[$relative] -cne $payloadHashes[$relative]) {
            throw "Repair failed to preserve/restore current payload bytes: $relative"
        }
    }
    Assert-ProfilePreserved
    Write-Host 'PASS: genuine /fomus repair restored missing app.asar; all current payload bytes and seeded profile settings/sentinel preserved.'
} catch {
    $failure = $_
    Write-Host "FAIL: $($_.Exception.Message)"
} finally {
    # Sources remain available through every maintenance and cleanup call, including failure/timeout paths.
    foreach ($product in @($ownedProducts.Values | Sort-Object Version -Descending)) {
        if (-not $attemptedProducts.Contains($product.ProductCode)) { continue }
        try {
            if (Test-Registration $product.ProductCode 2) { Invoke-UpgradeMsi 'Uninstall' $product ("uninstall-" + $product.Version) }
            Assert-Absent $product.ProductCode
            Write-Host "PASS: exact product $($product.ProductCode) is absent in all current-user/machine contexts."
        } catch { $cleanupErrors.Add("Cleanup $($product.ProductCode): $_") }
    }
    if ($attemptedProducts.Count -gt 0) {
        try {
            if (@([UpgradeVerificationInstaller]::RelatedProducts($upgradeCode)).Count -ne 0) { throw 'Related MSI registration remains after cleanup.' }
            if (Test-Path -LiteralPath (Join-Path $installDirectory "$($manifest.build.productName).exe")) { throw 'Installed executable remains after cleanup.' }
            Assert-CleanApplicationDirectory $installDirectory $newMsiHash $manifest.version
        } catch { $cleanupErrors.Add("Final installation absence check: $_") }
    }
    try {
        Assert-ProfilePreserved
        if ($profileHashes.Count -gt 0) { Write-Host 'PASS: seeded profile sentinel and settings remain byte-identical after uninstall.' }
    } catch { $cleanupErrors.Add("Final profile preservation check: $_") }
    foreach ($cleanupError in $cleanupErrors) { Write-Warning $cleanupError }
    try { Stop-Transcript | Out-Null } catch { $cleanupErrors.Add("Closing verification transcript: $_") }
}
if ($null -ne $failure) {
    if ($cleanupErrors.Count -gt 0) { $failure.Exception.Data['UpgradeCleanupErrors'] = $cleanupErrors -join "`n" }
    throw $failure
}
if ($cleanupErrors.Count -gt 0) { throw ($cleanupErrors -join "`n") }
Write-Host 'PASS: bounded genuine 0.9.10 -> 0.9.11 auto-upgrade, same-version rejection, owned running-app close/recheck, removal-before-new, rollback, repair and exact-product cleanup. No application was forcibly closed.'
