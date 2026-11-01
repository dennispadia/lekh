using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace Lekh.Setup
{
    internal sealed class InstalledProduct
    {
        public readonly string ProductCode, Version;
        public InstalledProduct(string code, string version) { ProductCode = code; Version = version; }
        public string Mode
        {
            get
            {
                int comparison = ProductDiscovery.ParseVersion(Version).CompareTo(ProductDiscovery.ParseVersion(BuildInfo.Version));
                return comparison > 0 ? "downgrade" : comparison == 0 ? "repair" : "upgrade";
            }
        }
        public static bool Same(InstalledProduct a, InstalledProduct b)
        {
            return a == null ? b == null : b != null &&
                String.Equals(a.ProductCode, b.ProductCode, StringComparison.OrdinalIgnoreCase) && a.Version == b.Version;
        }
    }

    internal static class ProductDiscovery
    {
        internal static Version ParseVersion(string value)
        {
            Version parsed;
            if (!System.Version.TryParse(value, out parsed) || parsed.Build < 0 || (parsed.Revision > 0))
                throw new InvalidDataException("Windows Installer reported an unsupported Lekh version: " + value + ".");
            return new Version(parsed.Major, parsed.Minor, parsed.Build);
        }
        internal static InstalledProduct Read(IEnumerable<string> codes, Func<string, uint, string, string> property)
        {
            InstalledProduct found = null;
            foreach (string code in codes)
            {
                Guid guid;
                if (!Guid.TryParse(code, out guid)) throw new InvalidDataException("Invalid related MSI ProductCode.");
                foreach (uint context in new uint[] { 1, 4 })
                    if (property(code, context, "ProductName") != null)
                        throw new InvalidDataException("A managed or machine-wide related product is registered. Use Windows Settings to manage it; Setup only updates your current-user installation.");
                string name = property(code, 2, "ProductName");
                if (name == null) continue;
                if (name != BuildInfo.ProductName || property(code, 2, "InstalledProductName") != BuildInfo.ProductName)
                    throw new InvalidDataException("A related MSI registration is not the expected installed Lekh product. Setup will not modify it.");
                string version = property(code, 2, "VersionString");
                ParseVersion(version);
                if (found != null) throw new InvalidDataException("Multiple related Lekh installations are registered. Manage them in Windows Settings before continuing.");
                found = new InstalledProduct(code, version);
            }
            return found;
        }
        public static InstalledProduct Detect() { return Read(Native.RelatedProducts(), Native.ProductProperty); }
        public static void AssertRemoved(InstalledProduct previous)
        {
            foreach (uint context in new uint[] { 1, 2, 4 })
                if (Native.ProductProperty(previous.ProductCode, context, "ProductName") != null)
                    throw new InvalidDataException("The previous Lekh ProductCode is still registered. Windows must roll back this upgrade.");
            if (SetupPolicy.PathExistsExact(SetupPolicy.AppPath) || SetupPolicy.PathExistsExact(SetupPolicy.AsarPath))
                throw new InvalidDataException("The previous Lekh payload is still present before the new payload stage. Windows must roll back this upgrade.");
        }
    }

    internal sealed class SetupUpdate
    {
        public readonly string Stage;
        public readonly int? Percent;
        public readonly bool CanCancel;
        public SetupUpdate(string stage, int? percent, bool canCancel)
        {
            Stage = stage; Percent = percent; CanCancel = canCancel;
        }
    }

    internal sealed class MsiProgress
    {
        private long total, position, actionTicks;
        private bool backward, estimated, actionData;
        public bool Backward { get { return backward; } }
        public int? Percent
        {
            get { return total <= 0 || estimated ? (int?)null : (int)Math.Max(0, Math.Min(100, position * 100 / total)); }
        }
        public void ResetAction() { actionData = false; }
        public void ResetStage() { total = position = actionTicks = 0; estimated = true; actionData = backward = false; }
        public void ActionData() { if (actionData) Move(actionTicks); }
        private void Move(long ticks)
        {
            position = Math.Max(0, Math.Min(total, position + (backward ? -ticks : ticks)));
        }
        private static void RequireFields(uint count, uint required)
        {
            if (count < required) throw new InvalidDataException("Windows Installer progress record is missing required field " + required + ".");
        }
        private static void RequireTicks(int value)
        {
            if (value < 0) throw new InvalidDataException("Windows Installer progress field 2 must contain nonnegative integer ticks.");
        }
        private static void RequireFlag(int value, uint field)
        {
            if (value != 0 && value != 1) throw new InvalidDataException("Windows Installer progress field " + field + " must contain 0 or 1.");
        }
        public void Message(string packet)
        {
            if (String.IsNullOrEmpty(packet) || packet.Length > 256) throw new InvalidDataException("Invalid formatted Windows Installer progress packet.");
            List<int> fields = new List<int>();
            int position = 0;
            while (position < packet.Length)
            {
                if (fields.Count == 4 || position + 3 > packet.Length || packet[position] != '1' + fields.Count ||
                    packet[position + 1] != ':' || packet[position + 2] != ' ')
                    throw new InvalidDataException("Formatted Windows Installer progress fields must be ordered 1 through 4.");
                position += 3;
                int start = position;
                if (position < packet.Length && packet[position] == '-') position++;
                while (position < packet.Length && packet[position] >= '0' && packet[position] <= '9') position++;
                string token = packet.Substring(start, position - start);
                int value = Int32.MinValue;
                if (token.Length != 0 && !Int32.TryParse(token, System.Globalization.NumberStyles.AllowLeadingSign,
                    System.Globalization.CultureInfo.InvariantCulture, out value))
                    throw new InvalidDataException("Formatted Windows Installer progress contains a noninteger or overflowing field.");
                fields.Add(value);
                if (position < packet.Length)
                {
                    if (packet[position++] != ' ') throw new InvalidDataException("Invalid formatted Windows Installer progress delimiter.");
                }
            }
            Message(fields[0], fields.Count > 1 ? fields[1] : Int32.MinValue, fields.Count > 2 ? fields[2] : Int32.MinValue,
                fields.Count > 3 ? fields[3] : Int32.MinValue, (uint)fields.Count);
        }
        public void Message(int kind, int value, int direction, int script, uint fieldCount = 4)
        {
            RequireFields(fieldCount, 1);
            switch (kind)
            {
                case 0:
                    RequireFields(fieldCount, 4);
                    RequireTicks(value); RequireFlag(direction, 3); RequireFlag(script, 4);
                    total = value; backward = direction == 1; estimated = script == 1;
                    position = backward ? total : 0; actionTicks = 0; actionData = false;
                    break;
                case 1:
                    RequireFields(fieldCount, 3);
                    RequireFlag(direction, 3);
                    // Microsoft defines field 2 as ignored when field 3 is zero; it may be MSI_NULL_INTEGER.
                    if (direction == 1) RequireTicks(value);
                    actionTicks = direction == 1 ? value : 0; actionData = direction == 1;
                    break;
                case 2: RequireFields(fieldCount, 2); RequireTicks(value); Move(value); break;
                case 3: RequireFields(fieldCount, 2); RequireTicks(value); total += value; if (backward) position += value; break;
                default: throw new InvalidDataException("Unknown Windows Installer progress message kind: " + kind + ".");
            }
        }
    }

    internal static class SetupPolicy
    {
        public const string UpgradeCode = "DCBCF7FA-11DA-4F35-8D27-D066EEC6C582";
        public const string InstallProperties = "REBOOT=ReallySuppress MSIRESTARTMANAGERCONTROL=DisableShutdown MSIDISABLERMRESTART=1";
        public static string AppPath
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), BuildInfo.InstallDirectory, BuildInfo.ExecutableName); }
        }
        public static string AsarPath { get { return Path.Combine(Path.GetDirectoryName(AppPath), "resources", "app.asar"); } }
        internal static bool PathExistsExact(string path)
        {
            try { File.GetAttributes(path); return true; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
        }
        public static bool IsSuccess(uint result) { return result == 0 || result == 3010; }
        internal static string ReadyState(InstalledProduct installed, Func<bool> appIsOpen)
        {
            if (installed != null)
            {
                if (installed.Mode == "downgrade") return "downgrade";
                if (installed.Mode == "repair") return "installed";
            }
            return appIsOpen() ? "open" : installed == null ? "ready" : "upgrade";
        }
        public static string ErrorDescription(uint result)
        {
            switch (result)
            {
                case 1618: return "Another Windows installation is in progress. Let it finish, then try again.";
                case 1638: return "This version or a newer version is already installed. Use Windows Settings to manage the existing installation.";
                case 112: return "Windows needs more free disk space. Free some space, then try again.";
                case 1619: case 1620: return "Windows could not open the verified installer. See the setup log and follow your Windows security policy.";
                case 1625: return "Windows policy blocked installation. Contact your administrator; do not disable security protections.";
                default: return "Windows Installer could not complete setup. Review the local log for details, then try again.";
            }
        }
        public static bool IsInstalledApp(string path)
        {
            string full = Path.GetFullPath(path);
            return String.Equals(full, AppPath, StringComparison.OrdinalIgnoreCase);
        }
        internal static bool AppIsOpen(IEnumerable<Process> processes, Func<Process, string> executablePath)
        {
            foreach (Process process in processes)
            {
                try
                {
                    if (IsInstalledApp(executablePath(process))) return true;
                }
                catch (InvalidOperationException)
                {
                    if (!process.HasExited) throw;
                }
            }
            return false;
        }
        public static bool AppIsOpen()
        {
            Process[] processes = Process.GetProcessesByName(Path.GetFileNameWithoutExtension(BuildInfo.ExecutableName));
            try
            {
                return AppIsOpen(processes, process => process.MainModule.FileName);
            }
            finally
            {
                foreach (Process process in processes) process.Dispose();
            }
        }
        public static void ValidateProperties(IDictionary<string, string> properties)
        {
            string name, version, upgrade, user;
            if (!properties.TryGetValue("ProductName", out name) || name != BuildInfo.ProductName ||
                !properties.TryGetValue("ProductVersion", out version) || (version != BuildInfo.Version && version != BuildInfo.Version + ".0") ||
                !properties.TryGetValue("UpgradeCode", out upgrade) || !String.Equals(upgrade.Trim('{', '}'), UpgradeCode, StringComparison.OrdinalIgnoreCase) ||
                properties.ContainsKey("ALLUSERS") || !properties.TryGetValue("MSIINSTALLPERUSER", out user) || user != "1")
                throw new InvalidDataException("The embedded MSI does not match the expected per-user Lekh package.");
            if (properties.ContainsKey("DISABLEROLLBACK"))
                throw new InvalidDataException("The embedded MSI must not disable Windows Installer rollback.");
        }
        internal static void ValidateSchedule(IDictionary<string, int> sequence, bool rollbackGuard, bool removalCheckpoint)
        {
            int initialize, remove, checkpoint, components, files;
            if (!sequence.TryGetValue("InstallInitialize", out initialize) ||
                !sequence.TryGetValue("RemoveExistingProducts", out remove) ||
                !sequence.TryGetValue("LekhPreviousVersionRemoved", out checkpoint) ||
                !sequence.TryGetValue("ProcessComponents", out components) ||
                !sequence.TryGetValue("InstallFiles", out files) ||
                remove != initialize + 1 || checkpoint != remove + 1 || checkpoint >= components || checkpoint >= files ||
                !rollbackGuard || !removalCheckpoint)
                throw new InvalidDataException("Unsafe MSI upgrade schedule: removal must follow InstallInitialize inside rollback, with a verified checkpoint before new-payload script generation.");
            foreach (KeyValuePair<string, int> action in sequence)
                if (action.Value >= initialize && action.Value <= checkpoint && action.Key != "InstallInitialize" &&
                    action.Key != "RemoveExistingProducts" && action.Key != "LekhPreviousVersionRemoved")
                    throw new InvalidDataException("Unexpected MSI action before the previous-version removal checkpoint: " + action.Key + ".");
        }
    }

    internal sealed class MsiSession : IDisposable
    {
        private readonly bool restricted;
        private uint handle, previousUI;
        private bool comInitialized, uiConfigured, registered, disposed;
        private Native.RecordHandler callback, previous;
        internal uint Handle { get { if (disposed) throw new ObjectDisposedException("MsiSession"); return handle; } }
        internal MsiSession(string package, bool readOnly = false)
        {
            restricted = readOnly;
            uint apartment = System.Threading.Thread.CurrentThread.GetApartmentState() == System.Threading.ApartmentState.STA ? 2u : 0u;
            int result = Native.CoInitializeEx(IntPtr.Zero, apartment);
            if (result < 0) throw new InvalidOperationException("Initialize MSI COM apartment failed (HRESULT 0x" + result.ToString("X8") + ").");
            comInitialized = true;
            try
            {
                previousUI = Native.MsiSetInternalUI(2, IntPtr.Zero);
                if (previousUI == 0) throw new InvalidOperationException("Could not configure Windows Installer UI.");
                uiConfigured = true;
                Native.Check(Native.MsiOpenPackageEx(package, restricted ? 1u : 0u, out handle), "Open Windows Installer session");
            }
            catch (Exception error)
            {
                try { Dispose(); }
                catch (Exception cleanup) { throw new AggregateException("Opening MSI session and cleanup failed.", error, cleanup); }
                throw;
            }
        }
        internal void SetProperties(string properties)
        {
            foreach (string property in properties.Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
            {
                int separator = property.IndexOf('=');
                if (separator <= 0) throw new InvalidDataException("Invalid Windows Installer property.");
                Native.Check(Native.MsiSetProperty(Handle, property.Substring(0, separator), property.Substring(separator + 1)), "Set MSI " + property.Substring(0, separator));
            }
        }
        internal void Register(Native.RecordHandler handler, uint filter, IntPtr context)
        {
            if (registered) throw new InvalidOperationException("The MSI session already has an external record handler.");
            uint activeHandle = Handle;
            if (activeHandle == 0) throw new InvalidOperationException("An open MSI session is required before record-handler registration.");
            callback = handler;
            Native.Check(Native.MsiSetExternalUIRecord(callback, filter, context, out previous), "Register installer progress");
            registered = true;
        }
        internal uint Install()
        {
            if (restricted) throw new InvalidOperationException("A read-only MSI test session cannot install a product.");
            if (!registered) throw new InvalidOperationException("Installer record handling must be registered before INSTALL.");
            return Native.MsiDoAction(Handle, "INSTALL");
        }
        public void Dispose()
        {
            if (disposed) return;
            disposed = true;
            try
            {
                if (registered)
                {
                    Native.RecordHandler ignored;
                    Native.Check(Native.MsiSetExternalUIRecord(previous, 0, IntPtr.Zero, out ignored), "Restore installer progress handler");
                }
            }
            finally
            {
                try { if (handle != 0) Native.Check(Native.MsiCloseHandle(handle), "Close Windows Installer session"); }
                finally
                {
                    try { if (uiConfigured) Native.MsiSetInternalUI(previousUI, IntPtr.Zero); }
                    finally
                    {
                        if (comInitialized) Native.CoUninitialize();
                        GC.KeepAlive(callback);
                    }
                }
            }
        }
    }

    internal sealed class NativeEngine
    {
        internal const uint RecordFilter = 0xfffu | (1u << 25);
        private readonly Action<SetupUpdate> update;
        private readonly Action<string> log;
        private readonly MsiProgress progress = new MsiProgress();
        private volatile bool cancelRequested, canCancel = true;
        private bool cancelSent, repair, executing;
        private bool progressObserved, advisoryObserved;
        private readonly InstalledProduct previousProduct;
        private readonly Action verifyRemoval;
        private readonly Func<bool> payloadPresent;
        private string stage = "preparing";
        internal bool RemovalConfirmed { get; private set; }
        private string lastUpdate;
        public string FailureMessage { get; private set; }
        public bool FilesInUse { get; private set; }
        public bool CallbackFailed { get; private set; }
        public bool Installed { get; private set; }
        public bool CanCancel { get { return canCancel; } }
        public bool IsRepair { get { return repair; } }
        public NativeEngine(Action<SetupUpdate> report, Action<string> writeLog, InstalledProduct previous = null,
            Action removalCheck = null, Func<bool> newPayloadPresent = null)
        {
            update = report; log = writeLog;
            previousProduct = previous;
            verifyRemoval = removalCheck ?? (() => ProductDiscovery.AssertRemoved(previousProduct));
            payloadPresent = newPayloadPresent ?? (() => File.Exists(SetupPolicy.AppPath) && File.Exists(SetupPolicy.AsarPath));
        }
        public void Cancel() { if (canCancel) cancelRequested = true; }
        internal string PropertiesForProduct(string code)
        {
            repair = previousProduct != null && String.Equals(code, previousProduct.ProductCode, StringComparison.OrdinalIgnoreCase);
            if (repair && previousProduct.Mode != "repair")
                throw new InvalidDataException("Different Lekh versions must not reuse the same ProductCode.");
            return SetupPolicy.InstallProperties + (repair ? " REINSTALL=ALL REINSTALLMODE=omus" : "");
        }
        internal int CancellationReply(uint message)
        {
            if (cancelRequested && !cancelSent && canCancel &&
                (message == 0x0a000000 || message == 0x09000000 || message == 0x08000000))
            {
                cancelSent = true;
                canCancel = false;
                Report();
                return 2;
            }
            return 1;
        }
        private void Report()
        {
            string visible = stage == "rollback" ? stage : cancelRequested ? "stopping" : stage;
            int? percent = cancelRequested || stage == "rollback" ? null : progress.Percent;
            string key = visible + ":" + percent + ":" + canCancel;
            if (key == lastUpdate) return;
            lastUpdate = key;
            update(new SetupUpdate(visible, percent, canCancel && !cancelRequested && stage != "rollback"));
        }
        internal void ActionStarted(string action)
        {
            progress.ResetAction();
            if (stage == "rollback")
            {
                log("Windows Installer rollback action: " + action);
                Report();
                return;
            }
            if (action == "RemoveExistingProducts" && previousProduct != null && !repair)
            {
                stage = "removing";
                progress.ResetStage();
            }
            if (action == "LekhPreviousVersionRemoved" && previousProduct != null && !repair)
            {
                verifyRemoval();
                RemovalConfirmed = true;
                stage = "installing";
                progress.ResetStage();
                log("Verified removal of previous ProductCode " + previousProduct.ProductCode + " and executable/app.asar before new payload.");
            }
            // Nested uninstall has its own InstallFiles/InstallFinalize. Neither is the new installation.
            if (action == "InstallFiles" && (previousProduct == null || repair || RemovalConfirmed))
            {
                if (stage != "installing") progress.ResetStage();
                stage = "installing";
            }
            if ((action == "InstallFinalize" || action == "InstallExecute" || action == "InstallExecuteAgain") &&
                (previousProduct == null || repair || RemovalConfirmed)) executing = true;
            if (action == "PublishProduct" && executing && payloadPresent())
            {
                stage = "finishing";
                progress.ResetStage();
            }
            if (action == "Rollback") stage = "rollback";
            log("Windows Installer action: " + action);
            Report();
        }
        internal int Callback(IntPtr context, uint type, uint record)
        {
            try
            {
                uint message = type & 0xff000000;
                switch (message)
                {
                    case 0x0a000000:
                        if (record == 0)
                            throw new InvalidDataException("Windows Installer progress callback has no record (type=0x" + type.ToString("X8") + ", handle=0x00000000).");
                        if (!progressObserved)
                        {
                            log("First " + Native.DescribeProgressRecord(record));
                            progressObserved = true;
                        }
                        try
                        {
                            uint count = Native.MsiRecordGetFieldCount(record);
                            if (count == 0)
                            {
                                // FieldCount excludes field 0. Server records can carry serialized progress there.
                                string packet = Native.RecordString(record, 0);
                                if (packet.Length == 0)
                                {
                                    if (!advisoryObserved)
                                    {
                                        log("Windows Installer empty progress advisory: keeping current stage and progress; no update.");
                                        advisoryObserved = true;
                                    }
                                    return CancellationReply(message);
                                }
                                progress.Message(packet);
                            }
                            else
                            {
                                progress.Message(Native.MsiRecordGetInteger(record, 1), Native.MsiRecordGetInteger(record, 2),
                                    Native.MsiRecordGetInteger(record, 3), Native.MsiRecordGetInteger(record, 4), count);
                            }
                        }
                        catch (InvalidDataException error)
                        {
                            throw new InvalidDataException(error.Message + " " + Native.DescribeProgressRecord(record), error);
                        }
                        if (cancelSent && progress.Backward) stage = "rollback";
                        Report();
                        break;
                    case 0x09000000: progress.ActionData(); Report(); break;
                    case 0x08000000:
                        ActionStarted(Native.RecordString(record, 1));
                        break;
                    case 0x0b000000:
                        if (Native.MsiRecordGetInteger(record, 1) == 2)
                        {
                            canCancel = Native.MsiRecordGetInteger(record, 2) == 1;
                            Report();
                        }
                        break;
                    case 0x05000000: case 0x19000000:
                        FilesInUse = true;
                        FailureMessage = "Windows reports that application files are in use. Save your work, close the applications using those files, and try again.";
                        log(FailureMessage);
                        cancelSent = true; canCancel = false;
                        update(new SetupUpdate("stopping", null, false));
                        return 2;
                    case 0x00000000: case 0x01000000: case 0x02000000: case 0x03000000: case 0x07000000:
                        FailureMessage = Native.FormatRecord(record);
                        log("Windows Installer message: " + FailureMessage);
                        // Never automatically choose Ignore, Continue, or Yes for an unexpected installer prompt.
                        int buttons = (int)(type & 0x0f);
                        return buttons == 2 ? 3 : buttons == 4 ? 7 : buttons == 0 ? 1 : 2;
                    case 0x04000000: return 1;
                    case 0x0c000000: case 0x0d000000: case 0x0e000000: return 1;
                    default: return 0;
                }
                return CancellationReply(message);
            }
            catch (Exception error)
            {
                // Exceptions must not cross the unmanaged callback boundary.
                FailureMessage = "Setup could not process a Windows Installer message: " + error.Message;
                // A failed log must not escape through this unmanaged callback either.
                try { log(FailureMessage + Environment.NewLine + error); }
                catch (Exception logError) { FailureMessage += " Diagnostic logging also failed: " + logError.Message; }
                CallbackFailed = true;
                cancelRequested = true; cancelSent = true; canCancel = false;
                return 2;
            }
        }
        public uint Install(string package, string logPath)
        {
            string code = Payload.ProductCode(package);
            string properties = PropertiesForProduct(code);
            Native.Check(Native.MsiEnableLog(0x1fff, logPath, 0), "Enable Windows Installer logging");
            try
            {
                // Microsoft opens the package before subscribing to record-based UI messages.
                // Package initialization can emit a null-handle progress notification, not a progress record.
                using (MsiSession session = new MsiSession(package))
                {
                    session.SetProperties(properties);
                    log("Opened Windows Installer session before registering external UI records.");
                    session.Register(Callback, RecordFilter, IntPtr.Zero);
                    uint result = session.Install();
                    Installed = SetupPolicy.IsSuccess(result);
                    if (Installed && previousProduct != null && !repair && !RemovalConfirmed)
                        throw new InvalidDataException("Windows did not report the required previous-version removal checkpoint. Inspect the MSI log before using this installation.");
                    return result;
                }
            }
            finally
            {
                Native.Check(Native.MsiEnableLog(0, null, 0), "Close installer logging");
            }
        }
    }

    internal static class Payload
    {
        internal static IEnumerable<string[]> Rows(uint database, string query, uint columns)
        {
            uint view;
            Native.Check(Native.MsiDatabaseOpenView(database, query, out view), "Read MSI table");
            try
            {
                Native.Check(Native.MsiViewExecute(view, 0), "Query MSI table");
                uint record, result;
                while ((result = Native.MsiViewFetch(view, out record)) == 0)
                {
                    string[] row = new string[columns];
                    try { for (uint field = 1; field <= columns; field++) row[field - 1] = Native.RecordString(record, field); }
                    finally { Native.MsiCloseHandle(record); }
                    yield return row;
                }
                if (result != 259) Native.Check(result, "Read MSI row");
            }
            finally { Native.MsiCloseHandle(view); }
        }
        internal static string ProductCode(string package)
        {
            uint database;
            Native.Check(Native.MsiOpenDatabase(package, IntPtr.Zero, out database), "Open MSI identity");
            try
            {
                foreach (string[] row in Rows(database, "SELECT `Value` FROM `Property` WHERE `Property` = 'ProductCode'", 1))
                {
                    Guid code;
                    if (Guid.TryParse(row[0], out code)) return row[0];
                }
                throw new InvalidDataException("The embedded MSI has no valid exact ProductCode.");
            }
            finally { Native.MsiCloseHandle(database); }
        }
        public static string Extract(Func<bool> cancelled, string cacheRoot = null)
        {
            string directory = Path.Combine(cacheRoot ?? Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Lekh", "SetupCache"),
                Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            string target = Path.Combine(directory, "Lekh.msi");
            try
            {
                using (Stream input = typeof(Payload).Assembly.GetManifestResourceStream("Setup.Payload.msi"))
                using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (SHA256 hash = SHA256.Create())
                {
                    if (input == null) throw new InvalidDataException("Embedded offline installer is missing.");
                    byte[] buffer = new byte[1024 * 1024];
                    int count;
                    while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (cancelled()) throw new OperationCanceledException();
                        output.Write(buffer, 0, count);
                        hash.TransformBlock(buffer, 0, count, buffer, 0);
                    }
                    hash.TransformFinalBlock(buffer, 0, 0);
                    string digest = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
                    if (digest != BuildInfo.PayloadHash) throw new InvalidDataException("Embedded installer checksum mismatch.");
                }
                Validate(target);
                return target;
            }
            catch
            {
                Remove(target);
                throw;
            }
        }
        public static void Remove(string package)
        {
            File.Delete(package);
            Directory.Delete(Path.GetDirectoryName(package));
        }
        public static void Validate(string package)
        {
            uint database;
            Native.Check(Native.MsiOpenDatabase(package, IntPtr.Zero, out database), "Open embedded MSI");
            try
            {
                Dictionary<string, string> properties = new Dictionary<string, string>();
                foreach (string[] row in Rows(database, "SELECT `Property`, `Value` FROM `Property`", 2)) properties.Add(row[0], row[1]);
                SetupPolicy.ValidateProperties(properties);
                Guid code;
                if (!properties.ContainsKey("ProductCode") || !Guid.TryParse(properties["ProductCode"], out code))
                    throw new InvalidDataException("The embedded MSI has no valid exact ProductCode.");
                Dictionary<string, int> sequence = new Dictionary<string, int>();
                bool removalCheckpoint = false, checkpointAction = false, rollbackGuard = false;
                foreach (string[] row in Rows(database, "SELECT `Action`, `Sequence`, `Condition` FROM `InstallExecuteSequence`", 3))
                {
                    sequence.Add(row[0], Int32.Parse(row[1], System.Globalization.CultureInfo.InvariantCulture));
                    if (row[0] == "LekhPreviousVersionRemoved" && row[2] == "WIX_UPGRADE_DETECTED AND NOT Installed") removalCheckpoint = true;
                }
                foreach (string[] row in Rows(database, "SELECT `Type`, `Source`, `Target` FROM `CustomAction` WHERE `Action` = 'LekhPreviousVersionRemoved'", 3))
                    checkpointAction = row[0] == "51" && row[1] == "LEKH_PREVIOUS_VERSION_REMOVED" && row[2] == "1";
                foreach (string[] row in Rows(database, "SELECT `Condition` FROM `LaunchCondition`", 1))
                    if (row[0] == "NOT RollbackDisabled") rollbackGuard = true;
                SetupPolicy.ValidateSchedule(sequence, rollbackGuard, removalCheckpoint && checkpointAction);
            }
            finally { Native.MsiCloseHandle(database); }
        }
    }

    internal static class Native
    {
        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        internal delegate int RecordHandler(IntPtr context, uint message, uint record);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiOpenPackageExW", ExactSpelling = true)]
        internal static extern uint MsiOpenPackageEx(string package, uint flags, out uint handle);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiSetPropertyW", ExactSpelling = true)]
        internal static extern uint MsiSetProperty(uint install, string name, string value);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiDoActionW", ExactSpelling = true)]
        internal static extern uint MsiDoAction(uint install, string action);
        [DllImport("ole32.dll", ExactSpelling = true)] internal static extern int CoInitializeEx(IntPtr reserved, uint apartment);
        [DllImport("ole32.dll", ExactSpelling = true)] internal static extern void CoUninitialize();
        [DllImport("msi.dll")] internal static extern uint MsiSetInternalUI(uint level, IntPtr window);
        [DllImport("msi.dll", ExactSpelling = true)] internal static extern uint MsiSetExternalUIRecord(RecordHandler handler, uint filter, IntPtr context, out RecordHandler previous);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiEnableLogW")]
        internal static extern uint MsiEnableLog(uint mode, string path, uint attributes);
        [DllImport("msi.dll")] internal static extern int MsiRecordGetInteger(uint record, uint field);
        [DllImport("msi.dll")] internal static extern uint MsiRecordGetFieldCount(uint record);
        [DllImport("msi.dll")] private static extern int MsiRecordIsNull(uint record, uint field);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiRecordGetStringW")]
        private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiFormatRecordW")]
        private static extern uint MsiFormatRecord(uint install, uint record, StringBuilder value, ref uint length);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiOpenDatabaseW")]
        internal static extern uint MsiOpenDatabase(string path, IntPtr persistence, out uint database);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiDatabaseOpenViewW")]
        internal static extern uint MsiDatabaseOpenView(uint database, string query, out uint view);
        [DllImport("msi.dll")] internal static extern uint MsiViewExecute(uint view, uint record);
        [DllImport("msi.dll")] internal static extern uint MsiViewFetch(uint view, out uint record);
        [DllImport("msi.dll")] internal static extern uint MsiCloseHandle(uint handle);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiEnumRelatedProductsW")]
        private static extern uint MsiEnumRelatedProducts(string upgrade, uint reserved, uint index, StringBuilder code);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, EntryPoint = "MsiGetProductInfoExW")]
        private static extern uint MsiGetProductInfoEx(string code, string sid, uint context, string property, StringBuilder value, ref uint length);
        internal static IEnumerable<string> RelatedProducts()
        {
            for (uint index = 0; index < 256; index++)
            {
                StringBuilder code = new StringBuilder(39);
                uint result = MsiEnumRelatedProducts("{" + SetupPolicy.UpgradeCode + "}", 0, index, code);
                if (result == 259) yield break;
                Check(result, "Enumerate installed Lekh versions");
                yield return code.ToString();
            }
            throw new InvalidDataException("Unexpectedly large related MSI product family.");
        }
        internal static string ProductProperty(string code, uint context, string property)
        {
            uint length = 0;
            uint result = MsiGetProductInfoEx(code, null, context, property, null, ref length);
            if (result == 1605) return null;
            if (result != 0 && result != 234) Check(result, "Query installed Lekh " + property);
            for (int attempt = 0; attempt < 3; attempt++)
            {
                StringBuilder value = new StringBuilder(checked((int)length + 1));
                uint capacity = (uint)value.Capacity;
                result = MsiGetProductInfoEx(code, null, context, property, value, ref capacity);
                if (result == 1605) return null;
                if (result == 234) { length = capacity; continue; }
                Check(result, "Read installed Lekh " + property);
                return value.ToString();
            }
            throw new InvalidDataException("Installed Lekh registration changed repeatedly during detection.");
        }
        internal static void Check(uint result, string operation)
        {
            if (result != 0) throw new InvalidOperationException(operation + " failed (Windows code " + result + ").");
        }
        internal static string RecordString(uint record, uint field)
        {
            uint length = 0;
            uint result = MsiRecordGetString(record, field, null, ref length);
            if (result != 0 && result != 234) Check(result, "Measure MSI string");
            StringBuilder value = new StringBuilder(checked((int)length + 1));
            length++;
            Check(MsiRecordGetString(record, field, value, ref length), "Read MSI string");
            return value.ToString();
        }
        internal static string DescribeProgressRecord(uint record)
        {
            uint count = MsiRecordGetFieldCount(record);
            if (count == UInt32.MaxValue)
                throw new InvalidDataException("Invalid Windows Installer progress record handle=0x" + record.ToString("X8") + ".");
            StringBuilder description = new StringBuilder("Windows Installer progress record: type=0x0A000000 handle=0x" + record.ToString("X8") + " count=" + count);
            for (uint field = 0; field <= Math.Min(count, 4u); field++)
            {
                int number = MsiRecordGetInteger(record, field);
                StringBuilder text = new StringBuilder(129);
                uint capacity = (uint)text.Capacity;
                uint result = MsiRecordGetString(record, field, text, ref capacity);
                if (result != 0 && result != 234) Check(result, "Read progress diagnostic field");
                description.Append("; field ").Append(field).Append(" integer=")
                    .Append(number == Int32.MinValue ? "MSI_NULL_INTEGER" : number.ToString(System.Globalization.CultureInfo.InvariantCulture))
                    .Append(" null=").Append(MsiRecordIsNull(record, field) != 0)
                    .Append(" text=\"").Append(text.ToString().Replace("\r", "\\r").Replace("\n", "\\n")).Append("\"");
                if (result == 234) description.Append(" [truncated]");
            }
            return description.ToString();
        }
        internal static string FormatRecord(uint record)
        {
            uint length = 0;
            uint result = MsiFormatRecord(0, record, null, ref length);
            if (result != 0 && result != 234) Check(result, "Measure installer message");
            StringBuilder value = new StringBuilder(checked((int)length + 1));
            length++;
            Check(MsiFormatRecord(0, record, value, ref length), "Read installer message");
            return value.ToString();
        }
    }
}
