using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Controls;

namespace Lekh.Setup
{
    internal static class EngineTests
    {
        private static int assertions;
        private static void Check(bool condition, string message)
        {
            assertions++;
            if (!condition) throw new InvalidOperationException(message);
        }
        private static void Reject(Action action, string message)
        {
            bool rejected = false;
            try { action(); }
            catch (InvalidDataException) { rejected = true; }
            Check(rejected, message);
        }
        internal static int Run()
        {
            try
            {
                Progress();
                NativeProgressRecords();
                NativeRecordWire();
                Identity();
                PreviousVersions();
                UpgradeSequence();
                Preview();
                Animation();
                Console.WriteLine("PASS: " + assertions + " native setup assertions.");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error);
                return 1;
            }
        }
        private static void Progress()
        {
            MsiProgress p = new MsiProgress();
            Check(p.Percent == null, "Unknown progress must be indeterminate.");
            p.Message(0, 100, 0, 1);
            Check(p.Percent == null, "Script generation must be indeterminate.");
            p.Message(0, 100, 0, 0);
            p.Message(2, 20, 0, 0);
            Check(p.Percent == 20, "Explicit progress increments.");
            p.Message(1, 5, 1, 0);
            p.ActionData();
            Check(p.Percent == 25, "Action progress.");
            p.ResetAction(); p.ActionData();
            Check(p.Percent == 25, "Action reset stops implicit ticks.");
            p.Message(3, 100, 0, 0);
            Check(p.Percent == 12, "Extending progress total.");
            p.Message(2, 500, 0, 0);
            Check(p.Percent == 100, "Progress clamp.");
            p.ResetStage();
            Check(p.Percent == null, "A new stage never inherits the old stage's 100% completion.");
            p.Message(0, 100, 1, 0);
            p.Message(2, 25, 0, 0);
            Check(p.Backward && p.Percent == 75, "Rollback progress counts backwards.");
            p.Message(3, 100, 0, 0);
            Check(p.Percent == 87, "Backward progress extends both position and total.");
            p.Message(0, 0, 0, 0);
            Check(p.Percent == null, "Zero progress total.");
            Reject(() => p.Message(2, -1, 0, 0), "Negative ticks rejected.");
            Reject(() => p.Message(4, 1, 0, 0), "Unknown progress rejected.");
            Check(SetupPolicy.IsSuccess(0) && SetupPolicy.IsSuccess(3010), "Success and restart codes.");
            Check(!SetupPolicy.IsSuccess(1602) && !SetupPolicy.IsSuccess(1603), "Cancellation/failure aren't success.");
            NativeEngine engine = new NativeEngine(update => { }, text => { });
            Check(!engine.Installed, "Repair cache retention starts false, independently of UI exit codes.");
            Check(SetupPolicy.InstallProperties.Contains("DisableShutdown") &&
                SetupPolicy.InstallProperties.Contains("ReallySuppress"), "Never kill user apps or restart.");
        }
        private static Dictionary<string, string> Properties()
        {
            return new Dictionary<string, string> {
                { "ProductName", BuildInfo.ProductName }, { "ProductVersion", BuildInfo.Version },
                { "UpgradeCode", "{" + SetupPolicy.UpgradeCode + "}" }, { "MSIINSTALLPERUSER", "1" }
            };
        }
        [DllImport("msi.dll", ExactSpelling = true)]
        private static extern uint MsiCreateRecord(uint fields);
        [DllImport("msi.dll", ExactSpelling = true)]
        private static extern uint MsiRecordSetInteger(uint record, uint field, int value);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiRecordSetStringW(uint record, uint field, string value);
        private static void WithProgressRecord(uint fields, int?[] values, Action<uint> use)
        {
            uint record = MsiCreateRecord(fields);
            if (record == 0) throw new InvalidOperationException("Cannot create a native MSI test record.");
            try
            {
                for (uint field = 1; field <= values.Length; field++)
                    if (values[field - 1].HasValue) Native.Check(MsiRecordSetInteger(record, field, values[field - 1].Value), "Set test progress field");
                use(record);
            }
            finally { Native.MsiCloseHandle(record); }
        }
        [DllImport("msi.dll", ExactSpelling = true)] private static extern int MsiProcessMessage(uint install, uint type, uint record);
        [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiDatabaseCommit(uint database);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiGetSummaryInformationW(uint database, string path, uint updates, out uint summary);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiSummaryInfoSetPropertyW(uint summary, uint property, uint type, int number, IntPtr time, string text);
        [DllImport("msi.dll", ExactSpelling = true)] private static extern uint MsiSummaryInfoPersist(uint summary);
        [DllImport("msi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        private static extern uint MsiGetPropertyW(uint install, string name, StringBuilder value, ref uint length);
        private static void FixtureSql(uint database, string query)
        {
            uint view;
            Native.Check(Native.MsiDatabaseOpenView(database, query, out view), "Open wire fixture SQL");
            try { Native.Check(Native.MsiViewExecute(view, 0), "Execute wire fixture SQL"); }
            finally { Native.MsiCloseHandle(view); }
        }
        private static string CreateWireFixture(string path)
        {
            string code = "{" + Guid.NewGuid().ToString().ToUpperInvariant() + "}";
            uint database, summary = 0;
            Native.Check(Native.MsiOpenDatabase(path, new IntPtr(3), out database), "Create wire fixture");
            try
            {
                FixtureSql(database, "CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)");
                foreach (string[] row in new string[][] {
                    new[] { "ProductCode", code }, new[] { "ProductName", "Read-only MSI wire fixture" },
                    new[] { "ProductVersion", "0.0.1" }, new[] { "ProductLanguage", "1033" },
                    new[] { "Manufacturer", "Lekh installer tests" }, new[] { "MSIINSTALLPERUSER", "1" }
                }) FixtureSql(database, "INSERT INTO `Property` (`Property`, `Value`) VALUES ('" + row[0] + "', '" + row[1] + "')");
                Native.Check(MsiGetSummaryInformationW(database, null, 4, out summary), "Open wire fixture summary");
                Native.Check(MsiSummaryInfoSetPropertyW(summary, 7, 30, 0, IntPtr.Zero, "x64;1033"), "Set wire fixture architecture");
                Native.Check(MsiSummaryInfoSetPropertyW(summary, 9, 30, 0, IntPtr.Zero, "{" + Guid.NewGuid().ToString().ToUpperInvariant() + "}"), "Set wire fixture package code");
                Native.Check(MsiSummaryInfoSetPropertyW(summary, 14, 3, 500, IntPtr.Zero, null), "Set wire fixture installer version");
                Native.Check(MsiSummaryInfoSetPropertyW(summary, 15, 3, 8, IntPtr.Zero, null), "Set wire fixture limited privileges");
                Native.Check(MsiSummaryInfoPersist(summary), "Persist wire fixture summary");
                Native.Check(MsiDatabaseCommit(database), "Commit wire fixture");
            }
            finally { if (summary != 0) Native.MsiCloseHandle(summary); Native.MsiCloseHandle(database); }
            return code;
        }
        private static string SessionProperty(uint handle, string name)
        {
            StringBuilder value = new StringBuilder(1);
            uint length = 0;
            uint result = MsiGetPropertyW(handle, name, value, ref length);
            if (result != 0 && result != 234) Native.Check(result, "Measure wire session property");
            value = new StringBuilder(checked((int)length + 1));
            length = (uint)value.Capacity;
            Native.Check(MsiGetPropertyW(handle, name, value, ref length), "Read wire session property");
            return value.ToString();
        }
        private static void NativeRecordWire()
        {
            string directory = Path.Combine(Environment.CurrentDirectory, "build", "tests", "msi-wire-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(directory);
            string package = Path.Combine(directory, "wire.msi");
            string code = null;
            IntPtr expectedContext = new IntPtr(0x1234567887654321L);
            bool initializationProgress = false;
            Native.RecordHandler initial = null;
            Native.RecordHandler observer = (context, type, record) =>
            {
                if ((type & 0xff000000) == 0x0a000000 && record == 0) initializationProgress = true;
                return 0;
            };
            bool observing = false;
            try
            {
                code = CreateWireFixture(package);
                Native.Check(Native.MsiSetExternalUIRecord(observer, 0xffffu, expectedContext, out initial), "Observe package initialization");
                observing = true;
                List<uint> types = new List<uint>();
                List<uint> handles = new List<uint>();
                List<SetupUpdate> updates = new List<SetupUpdate>();
                bool contextMatches = true, borrowedRecordValid = true;
                NativeEngine engine = new NativeEngine(update => updates.Add(update), text => { });
                Native.RecordHandler receiver = (context, type, record) =>
                {
                    types.Add(type); handles.Add(record);
                    contextMatches &= context == expectedContext;
                    borrowedRecordValid &= record != 0 && Native.MsiRecordGetFieldCount(record) != UInt32.MaxValue;
                    return engine.Callback(context, type, record);
                };
                using (FileStream guard = new FileStream(package, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (MsiSession session = new MsiSession(package, true))
                {
                    Check(types.Count == 0 && handles.Count == 0 && !engine.CallbackFailed,
                        "Package initialization completes before the production record receiver is registered.");
                    Check(SessionProperty(session.Handle, "ProductCode") == code, "Restricted session is a real MSI package handle, not a fake record handle.");
                    Check(SessionProperty(session.Handle, "ProductName") == "Read-only MSI wire fixture", "Restricted package property queries work without installation.");
                    session.SetProperties(SetupPolicy.InstallProperties);
                    Check(SessionProperty(session.Handle, "REBOOT") == "ReallySuppress" &&
                        SessionProperty(session.Handle, "MSIRESTARTMANAGERCONTROL") == "DisableShutdown" &&
                        SessionProperty(session.Handle, "MSIDISABLERMRESTART") == "1", "Production no-shutdown/restart properties are set in the opened session.");
                    bool denied = false;
                    try { session.Install(); } catch (InvalidOperationException) { denied = true; }
                    Check(denied, "Read-only integration session explicitly prohibits calling INSTALL.");
                    session.Register(receiver, NativeEngine.RecordFilter, expectedContext);
                    WithProgressRecord(4, new int?[] { 0, 100, 0, 0 }, record =>
                        Check(MsiProcessMessage(session.Handle, 0x0a000040, record) == 1, "Actual MSI routes progress through the registered Winapi delegate."));
                    Check(types.Count == 1 && types[0] == 0x0a000040 && contextMatches && borrowedRecordValid && !engine.CallbackFailed,
                        "Real callback ABI preserves the 64-bit context, high-byte type/low flags, and borrowed record handle.");
                    Check(updates[updates.Count - 1].Percent == 0, "Real wire reset record reaches progress parsing.");
                    WithProgressRecord(2, new int?[] { 2, 40 }, record =>
                        Check(MsiProcessMessage(session.Handle, 0x0a000000, record) == 1 && updates[updates.Count - 1].Percent == 40,
                            "Real wire increments reach native progress, not a label timer."));
                    int beforeEmpty = updates.Count;
                    WithProgressRecord(0, new int?[] { }, record =>
                    {
                        Check(MsiProcessMessage(session.Handle, 0x0a000000, record) == 1 && !engine.CallbackFailed,
                            "The real MSI API delivers a legitimate nonzero-handle, zero-field empty advisory.");
                        Check(updates.Count == beforeEmpty && updates[updates.Count - 1].Percent == 40 &&
                            updates[updates.Count - 1].Stage == "preparing", "Real empty advisory does not change current stage or progress.");
                        Native.Check(MsiRecordSetStringW(record, 0, "1: 2 2: 5 "), "Set real format-only wire packet");
                        Check(MsiProcessMessage(session.Handle, 0x0a000000, record) == 1 && updates[updates.Count - 1].Percent == 45 &&
                            !engine.CallbackFailed, "Real MSI format-only field-zero payload updates progress through strict parsing.");
                    });
                    WithProgressRecord(3, new int?[] { 1, null, 0 }, record =>
                        Check(MsiProcessMessage(session.Handle, 0x0a000000, record) == 1 && !engine.CallbackFailed,
                            "Real wire delivery preserves valid null optional fields after package initialization."));
                    WithProgressRecord(4, new int?[] { 0, null, 0, 0 }, record =>
                        Check(MsiProcessMessage(session.Handle, 0x0a000000, record) == 2 && engine.CallbackFailed,
                            "Required-field validation still rejects malformed records delivered by the actual MSI callback."));
                }
                Native.RecordHandler restored;
                Native.Check(Native.MsiSetExternalUIRecord(null, 0, IntPtr.Zero, out restored), "Inspect restored wire observer");
                Check(restored != null && Marshal.GetFunctionPointerForDelegate(restored) == Marshal.GetFunctionPointerForDelegate(observer),
                    "Session disposal restores the actual previous external record handler.");
                using (MsiSession filtered = new MsiSession(package, true))
                {
                    int delivered = 0;
                    Native.RecordHandler actionOnly = (context, type, record) => { delivered++; return 1; };
                    filtered.Register(actionOnly, 1u << 8, expectedContext);
                    WithProgressRecord(4, new int?[] { 0, 100, 0, 0 }, record => { MsiProcessMessage(filtered.Handle, 0x0a000000, record); });
                    Check(delivered == 0, "INSTALLLOGMODE_ACTIONSTART does not subscribe to INSTALLMESSAGE_PROGRESS: filter bits are not message high bytes.");
                    WithProgressRecord(3, new int?[] { null, null, null }, record =>
                    {
                        Native.Check(MsiRecordSetStringW(record, 1, "WireAction"), "Set wire action name");
                        Native.Check(MsiRecordSetStringW(record, 2, "Synthetic action message only"), "Set wire action description");
                        Check(MsiProcessMessage(filtered.Handle, 0x08000000, record) == 1 && delivered == 1, "Actual MSI action-start filter maps to high-byte ACTIONSTART.");
                    });
                }
                bool mtaWire = System.Threading.Tasks.Task.Run(() =>
                {
                    NativeEngine mtaEngine = new NativeEngine(update => { }, text => { });
                    using (MsiSession mta = new MsiSession(package, true))
                    {
                        mta.SetProperties(SetupPolicy.InstallProperties + " REINSTALL=ALL REINSTALLMODE=omus");
                        if (SessionProperty(mta.Handle, "REINSTALL") != "ALL" || SessionProperty(mta.Handle, "REINSTALLMODE") != "omus") return false;
                        mta.Register(mtaEngine.Callback, NativeEngine.RecordFilter, IntPtr.Zero);
                        bool accepted = false;
                        WithProgressRecord(4, new int?[] { 0, 100, 0, 0 }, record =>
                            accepted = MsiProcessMessage(mta.Handle, 0x0a000000, record) == 1 && !mtaEngine.CallbackFailed);
                        return accepted;
                    }
                }).GetAwaiter().GetResult();
                Check(mtaWire, "The production Task.Run/MTA session route initializes COM, sets exact reinstall properties and receives valid MSI records.");
                NativeEngine lifecycle = new NativeEngine(update => { }, text => { });
                Check(lifecycle.Callback(IntPtr.Zero, 0x0c000000, 0) == 1 &&
                    lifecycle.Callback(IntPtr.Zero, 0x0d000000, 0) == 1 && lifecycle.Callback(IntPtr.Zero, 0x0e000000, 0) == 1 && !lifecycle.CallbackFailed,
                    "Only documented initialize/terminate/show-dialog lifecycle messages are handled without reading a record.");
                Check(lifecycle.Callback(IntPtr.Zero, 0x0a000000, 0) == 2 && lifecycle.CallbackFailed &&
                    lifecycle.FailureMessage.Contains("type=0x0A000000") && lifecycle.FailureMessage.Contains("handle=0x00000000"),
                    "Null-handle progress is still an error after subscription, with exact wire diagnostics.");
                Console.WriteLine("PASS: actual restricted MSI wire proves open-before-register, valid borrowed records, filter/ABI routing and strict malformed-record rejection; no INSTALL executed. Opening emitted null progress on this run: " + initializationProgress + ".");
            }
            finally
            {
                if (observing) { Native.RecordHandler ignored; Native.MsiSetExternalUIRecord(initial, 0, IntPtr.Zero, out ignored); }
                GC.KeepAlive(observer);
                File.Delete(package);
                Directory.Delete(directory);
            }
        }
        private static void NativeProgressRecords()
        {
            const uint progressMessage = 0x0a000000;
            List<SetupUpdate> updates = new List<SetupUpdate>();
            List<string> logs = new List<string>();
            NativeEngine startup = new NativeEngine(update => updates.Add(update), text => logs.Add(text));
            WithProgressRecord(3, new int?[] { 1, null, 0 }, record =>
            {
                Check(startup.Callback(IntPtr.Zero, progressMessage, record) == 1 && !startup.CallbackFailed && startup.CanCancel,
                    "An initial native explicit-progress record with null unused ticks must not abort fresh setup.");
                Check(updates[updates.Count - 1].Percent == null, "An initial progress-mode message does not invent a total or percentage.");
                Check(logs[0].Contains("count=3") && logs[0].Contains("field 2 integer=MSI_NULL_INTEGER null=True"),
                    "The initial null/unused field is captured exactly in owned setup diagnostics.");
            });
            updates.Clear(); logs.Clear();
            NativeEngine engine = new NativeEngine(update => updates.Add(update), text => logs.Add(text));
            WithProgressRecord(4, new int?[] { 0, 100, 0, 0 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Native reset record accepted."));
            int beforeAdvisory = updates.Count;
            WithProgressRecord(0, new int?[] { }, record =>
            {
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && !engine.CallbackFailed,
                    "A valid zero-field, empty-format progress record is an advisory, not malformed numbered data.");
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && updates.Count == beforeAdvisory &&
                    updates[updates.Count - 1].Percent == 0, "Repeated no-data advisories preserve current progress and stage without updates.");
            });
            Check(logs.FindAll(text => text.Contains("empty progress advisory")).Count == 1, "No-data advisory logging is bounded to one entry.");
            WithProgressRecord(3, new int?[] { 1, 5, 1 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Three-field implicit-action progress accepted without unused field 4."));
            Check(engine.Callback(IntPtr.Zero, 0x09000000, 0) == 1 && updates[updates.Count - 1].Percent == 5, "Implicit native action ticks applied.");
            WithProgressRecord(3, new int?[] { 1, null, 0 }, record =>
            {
                Check(Native.MsiRecordGetFieldCount(record) == 3 && Native.MsiRecordGetInteger(record, 2) == Int32.MinValue &&
                    Native.MsiRecordGetInteger(record, 4) == Int32.MinValue, "Native omitted/null fields really return MSI_NULL_INTEGER.");
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && !engine.CallbackFailed,
                    "Documented explicit-progress mode accepts ignored null field 2 without cancelling MSI.");
            });
            Check(engine.Callback(IntPtr.Zero, 0x09000000, 0) == 1 && updates[updates.Count - 1].Percent == 5, "Explicit-progress mode disables previous implicit action ticks.");
            WithProgressRecord(2, new int?[] { 2, 20 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && updates[updates.Count - 1].Percent == 25,
                    "Two-field progress increments accept missing unused fields 3 and 4."));
            WithProgressRecord(2, new int?[] { 3, 100 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && updates[updates.Count - 1].Percent == 12,
                    "Two-field progress addition adjusts the denominator."));
            WithProgressRecord(4, new int?[] { 0, 100, 1, 0 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Native backward reset accepted."));
            WithProgressRecord(2, new int?[] { 2, 25 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && updates[updates.Count - 1].Percent == 75,
                    "Backward execution still applies explicit progress correctly."));
            WithProgressRecord(4, new int?[] { 0, 100, 0, 1 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1 && updates[updates.Count - 1].Percent == null,
                    "Native script-generation reset stays indeterminate."));
            WithProgressRecord(4, new int?[] { 1, null, 0, null }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Present but null unused fields are also valid."));
            WithProgressRecord(2, new int?[] { 2, null }, record =>
            {
                Native.Check(MsiRecordSetStringW(record, 2, "7"), "Set numeric progress string");
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Native integer-convertible fields remain supported.");
            });
            WithProgressRecord(3, new int?[] { 1, 0, 1 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Zero implicit-action ticks are valid."));
            WithProgressRecord(2, new int?[] { 2, 0 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Zero explicit ticks are valid."));
            WithProgressRecord(2, new int?[] { 3, 0 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 1, "Zero added ticks are valid."));
            Check(logs[0].Contains("count=4") && logs[0].Contains("field 1 integer=0"), "First actual native progress record is logged with its field count and values.");
            foreach (int?[] values in new int?[][] {
                new int?[] { null, 100 }, new int?[] { 4, 100 },
                new int?[] { 0, 100, 0 }, new int?[] { 0, null, 0, 0 }, new int?[] { 0, -1, 0, 0 },
                new int?[] { 0, 100, null, 0 }, new int?[] { 0, 100, 2, 0 }, new int?[] { 0, 100, 0, null }, new int?[] { 0, 100, 0, 2 },
                new int?[] { 1, 5 }, new int?[] { 1, null, 1 }, new int?[] { 1, -1, 1 }, new int?[] { 1, 5, null }, new int?[] { 1, 5, 2 },
                new int?[] { 2 }, new int?[] { 2, null }, new int?[] { 2, -1 }, new int?[] { 3 }, new int?[] { 3, null }, new int?[] { 3, -1 }
            })
            {
                NativeEngine invalid = new NativeEngine(update => { }, text => { });
                WithProgressRecord((uint)values.Length, values, record =>
                {
                    Check(invalid.Callback(IntPtr.Zero, progressMessage, record) == 2 && invalid.CallbackFailed && !invalid.CanCancel,
                        "Malformed required fields still fail safely through the actual native callback boundary.");
                    Check(invalid.FailureMessage.Contains("count=" + values.Length) && invalid.FailureMessage.Contains("type=0x0A000000") &&
                        invalid.FailureMessage.Contains("handle=0x"), "Malformed record diagnostics retain exact count, wire type, handle and relevant fields.");
                });
            }
            WithProgressRecord(2, new int?[] { 2, null }, record =>
            {
                Native.Check(MsiRecordSetStringW(record, 2, "not-an-integer"), "Set malformed progress string");
                NativeEngine invalid = new NativeEngine(update => { }, text => { });
                Check(invalid.Callback(IntPtr.Zero, progressMessage, record) == 2, "Noninteger required ticks are rejected.");
                Check(invalid.FailureMessage.Contains("integer=MSI_NULL_INTEGER null=False text=\"not-an-integer\""),
                    "Diagnostics distinguish a noninteger required field from a genuinely null optional field.");
            });
            WithProgressRecord(2, new int?[] { 2, null }, record =>
            {
                Native.Check(MsiRecordSetStringW(record, 2, new string('x', 300)), "Set long malformed progress string");
                NativeEngine invalid = new NativeEngine(update => { }, text => { });
                Check(invalid.Callback(IntPtr.Zero, progressMessage, record) == 2 && invalid.FailureMessage.Contains("[truncated]"),
                    "Malformed long fields still fail safely with bounded, explicitly truncated diagnostics.");
            });
            engine.Cancel();
            WithProgressRecord(2, new int?[] { 2, 0 }, record =>
                Check(engine.Callback(IntPtr.Zero, progressMessage, record) == 2 && !engine.CanCancel, "User cancellation still travels through the MSI callback."));
            MsiProgress unchanged = new MsiProgress();
            unchanged.Message(0, 100, 0, 0);
            unchanged.Message(2, 20, Int32.MinValue, Int32.MinValue, 2);
            Reject(() => unchanged.Message(0, 999, 2, 0), "Malformed required direction remains an error.");
            Check(unchanged.Percent == 20, "Rejected records cannot mutate the previous progress state.");
            NativeEngine formatted = new NativeEngine(update => updates.Add(update), text => { });
            foreach (string packet in new[] { "1: 0 2: 100 3: 0 4: 0", "1: 1 2: 5 3: 1 ", "1: 1 2:  3: 0", "1: 2 2: 20 ", "1: 3 2: 100" })
            {
                WithProgressRecord(0, new int?[] { }, record =>
                {
                    Native.Check(MsiRecordSetStringW(record, 0, packet), "Set formatted progress packet");
                    Check(formatted.Callback(IntPtr.Zero, progressMessage, record) == 1 && !formatted.CallbackFailed,
                        "Valid MSI serialized progress in field 0 is parsed, not ignored.");
                });
            }
            Check(updates[updates.Count - 1].Percent == 10, "Serialized increment/addition packets update genuine progress.");
            foreach (string packet in new[] {
                " ", "not progress", "1:", "1: 4 2: 5", "1: 0 2: 100 3: 0", "1: 0 2:  3: 0 4: 0",
                "1: 0 2: 100 3: 2 4: 0", "1: 0 2: 100 3: 0 4: 2", "1: 1 2:  3: 1",
                "1: 2 2: -1", "1: 2 2: 2147483648", "1: 2 2: 1x", "1: 2 2: 1 2: 2",
                "1: 2 3: 1", "1: 2 2: 1 5: 0", "1: 2 2: 1  ", "1: 2\n2: 1", new string('x', 300)
            })
            {
                WithProgressRecord(0, new int?[] { }, record =>
                {
                    Native.Check(MsiRecordSetStringW(record, 0, packet), "Set malformed serialized progress");
                    NativeEngine invalid = new NativeEngine(update => { }, text => { });
                    Check(invalid.Callback(IntPtr.Zero, progressMessage, record) == 2 && invalid.CallbackFailed &&
                        invalid.FailureMessage.Contains("field 0"), "Present but malformed field-zero payloads still fail safely and retain field-zero diagnostics.");
                });
            }
        }
        private static void Identity()
        {
            Check(SetupPolicy.UpgradeCode == "DCBCF7FA-11DA-4F35-8D27-D066EEC6C582", "Independent stable Lekh upgrade identity.");
            SetupPolicy.ValidateProperties(Properties());
            Check(true, "Braced stable upgrade identity.");
            Dictionary<string, string> values = Properties();
            values["UpgradeCode"] = SetupPolicy.UpgradeCode.ToLowerInvariant();
            values["ProductVersion"] += ".0";
            SetupPolicy.ValidateProperties(values);
            Check(true, "Unbraced stable upgrade identity and MSI version.");
            foreach (string key in new[] { "ProductName", "ProductVersion", "UpgradeCode", "MSIINSTALLPERUSER" })
            {
                Dictionary<string, string> changed = Properties();
                changed[key] = "unexpected";
                Reject(() => SetupPolicy.ValidateProperties(changed), "Reject changed " + key);
                changed.Remove(key);
                Reject(() => SetupPolicy.ValidateProperties(changed), "Reject missing " + key);
            }
            values = Properties(); values["ALLUSERS"] = "2";
            Reject(() => SetupPolicy.ValidateProperties(values), "Machine-wide MSI rejected.");
            values = Properties(); values["UpgradeCode"] = "DB607F2E-1890-4740-9DA3-51B6EEDD16AE";
            Reject(() => SetupPolicy.ValidateProperties(values), "Another product cannot share Lekh's installer.");
            Check(SetupPolicy.IsInstalledApp(SetupPolicy.AppPath), "Current app detection.");
            string directory = Path.GetDirectoryName(SetupPolicy.AppPath);
            Check(!SetupPolicy.IsInstalledApp(Path.Combine(directory, "Other editor.exe")), "Independent application identity.");
            Check(!SetupPolicy.IsInstalledApp(Path.Combine(Path.GetTempPath(), BuildInfo.ExecutableName)), "Other copies not confused with installed app.");
            Check(BuildInfo.PayloadHash.Length == 64 && BuildInfo.InstallDirectory == "lekh", "Build identity.");
            Check(SetupPolicy.PathExistsExact(typeof(EngineTests).Assembly.Location), "Removal probe recognizes real files.");
            Check(!SetupPolicy.PathExistsExact(typeof(EngineTests).Assembly.Location + ".missing"), "Only explicit file/directory-not-found proves payload absence.");
        }
        private static void Animation()
        {
            Check(Story.LetterMilliseconds == 36 && Story.HoldMilliseconds == 2000, "Approved typing and hold durations.");
            Check(String.Join("", Story.Elements("\u0932\u0947\u0916")) == "\u0932\u0947\u0916", "Devanagari preserved.");
            Check(Story.Elements("\u0932\u0947\u0916")[0] == "\u0932\u0947", "Vowel signs never split.");
            Check(Story.Elements("\u0932\u093f\u0916\u094d")[1] == "\u0916\u094d", "Virama never split.");
            Check(Story.Elements("\u0915\u094d\u0937").Length == 1, "Indic conjunct never split.");
            Check(Story.Elements("\ud83d\udcdd").Length == 1, "Surrogate pair never split.");
            Story story = new Story();
            Check(story.Written == Story.Chapters[0] && !story.Playing, "Static initial state is readable.");
            long now = 0;
            story.Play(true, now);
            Check(story.Written == "" && story.Writing, "Start writing.");
            for (int chapter = 0; chapter < 4; chapter++)
            {
                int expected = chapter % 3;
                Check(story.Index == expected, "Cycle 1/3 to 2/3 to 3/3 to 1/3.");
                while (story.Writing)
                {
                    Check(!story.Tick(now + 35), "No premature character.");
                    now += 36;
                    Check(story.Tick(now), "Character becomes due.");
                    Check(Story.Chapters[expected].StartsWith(story.Written, StringComparison.Ordinal), "Writing preserves exact copy.");
                }
                Check(story.Written == Story.Chapters[expected], "Full chapter copy.");
                Check(!story.Tick(now + 1999) && story.Index == expected, "Hold for full two seconds AFTER final letter.");
                now += 2000;
                Check(story.Tick(now) && story.Index == (expected + 1) % 3, "Advance automatically at two seconds.");
            }
            int current = story.Index;
            story.Play(false, now);
            Check(!story.Writing && story.Written == Story.Chapters[current], "Pause/hidden/reduced motion exposes full text.");
            Check(!story.Tick(now + 50000) && story.Index == current, "Stopped animation does not rotate.");
            story.Browse(-1, now);
            Check(story.Index == (current + 2) % 3 && story.Written == Story.Chapters[story.Index], "Manual navigation while stopped.");
            story.Play(true, now);
            story.Browse(1, now);
            Check(story.Index == current && story.Writing, "Resume and manual navigation animate.");
            story.Play(false, now);
            Check(story.Index == current, "Completion retains current chapter.");
        }
        private static void PreviousVersions()
        {
            const string oldCode = "{11111111-1111-1111-1111-111111111111}";
            Func<string, uint, string, string> property = (code, context, field) =>
                context != 2 ? null : field == "VersionString" ? "0.8.1" : BuildInfo.ProductName;
            Check(ProductDiscovery.Read(new string[0], property) == null, "No registration means fresh installation.");
            InstalledProduct old = ProductDiscovery.Read(new[] { oldCode }, property);
            Check(old.ProductCode == oldCode && old.Version == "0.8.1" && old.Mode == "upgrade", "Registered published old version is detected exactly.");
            Check(old.Guidance.Contains("Lekh 0.8.1") && old.Guidance.Contains("Save your work and close Lekh"), "Guidance states the detected version and asks users to save and close.");
            Check(new InstalledProduct(oldCode, BuildInfo.Version + ".0").Mode == "repair", "Same MSI version is maintenance, not downgrade.");
            Check(new InstalledProduct(oldCode, "99.0.0").Mode == "downgrade", "Newer registration blocks downgrade.");
            Reject(() => ProductDiscovery.Read(new[] { oldCode, "{22222222-2222-2222-2222-222222222222}" }, property), "Multiple installations are not silently swept.");
            Reject(() => ProductDiscovery.Read(new[] { oldCode }, (code, context, field) => "Other editor"), "Managed/machine scope is not silently changed.");
            Reject(() => ProductDiscovery.Read(new[] { oldCode }, (code, context, field) => context == 2 ? "Other editor" : null), "Wrong named related product rejected.");
            Reject(() => ProductDiscovery.Read(new[] { oldCode }, (code, context, field) =>
                context != 2 ? null : field == "InstalledProductName" ? null : BuildInfo.ProductName), "Advertised-only registration is not misreported as installed.");
            Reject(() => ProductDiscovery.Read(new[] { oldCode }, (code, context, field) =>
                context != 2 ? null : field == "VersionString" ? "unknown" : BuildInfo.ProductName), "Invalid registered version rejected.");
            bool propagated = false;
            try { ProductDiscovery.Read(new[] { oldCode }, (code, context, field) => { throw new IOException("query failed"); }); }
            catch (IOException) { propagated = true; }
            Check(propagated, "Native query failures are never treated as product absence.");
        }
        private static void UpgradeSequence()
        {
            Dictionary<string, int> schedule = new Dictionary<string, int> {
                { "InstallInitialize", 1500 }, { "RemoveExistingProducts", 1501 }, { "LekhPreviousVersionRemoved", 1502 },
                { "ProcessComponents", 1600 }, { "InstallFiles", 4000 }
            };
            SetupPolicy.ValidateSchedule(schedule, true, true);
            Check(true, "Transactional removal precedes all new payload scripts.");
            schedule["RemoveExistingProducts"] = 1401;
            Reject(() => SetupPolicy.ValidateSchedule(schedule, true, true), "Nontransactional default removal is rejected.");
            schedule["RemoveExistingProducts"] = 6601;
            Reject(() => SetupPolicy.ValidateSchedule(schedule, true, true), "Install-new-first removal is rejected.");
            schedule["RemoveExistingProducts"] = 1501;
            Reject(() => SetupPolicy.ValidateSchedule(schedule, false, true), "Rollback-disabled packages are rejected.");
            Reject(() => SetupPolicy.ValidateSchedule(schedule, true, false), "Proxy-only checkpoint without correct custom action is rejected.");
            schedule["UnexpectedDeferredAction"] = 1501;
            Reject(() => SetupPolicy.ValidateSchedule(schedule, true, true), "Any unexpected pre-checkpoint script action is rejected.");
            InstalledProduct old = new InstalledProduct("{11111111-1111-1111-1111-111111111111}", "0.8.1");
            List<string> states = new List<string>();
            bool gone = false, present = false;
            int checks = 0;
            NativeEngine engine = new NativeEngine(update => states.Add(update.Stage), text => { }, old,
                () => { checks++; if (!gone) throw new InvalidDataException("Old registration/payload remains."); }, () => present);
            engine.ActionStarted("InstallInitialize");
            engine.ActionStarted("RemoveExistingProducts");
            engine.ActionStarted("InstallFiles");
            engine.ActionStarted("InstallFinalize");
            engine.ActionStarted("PublishProduct");
            Check(states[states.Count - 1] == "removing" && checks == 0, "Nested old uninstall actions never imply new installation or finishing.");
            Reject(() => engine.ActionStarted("LekhPreviousVersionRemoved"), "Checkpoint must verify real old registration/payload absence.");
            Check(!engine.RemovalConfirmed && states[states.Count - 1] == "removing", "Failed removal proof cannot advance UI.");
            gone = true;
            engine.ActionStarted("LekhPreviousVersionRemoved");
            Check(checks == 2 && engine.RemovalConfirmed && states[states.Count - 1] == "installing", "Only successful removal probe advances to install-new.");
            engine.ActionStarted("InstallFinalize");
            Check(states[states.Count - 1] == "installing", "InstallFinalize starts deferred file execution, not completion.");
            present = true;
            engine.ActionStarted("PublishProduct");
            Check(states[states.Count - 1] == "finishing", "Finishing follows new executable and app.asar presence.");
            engine.Cancel();
            Check(engine.CancellationReply(0x08000000) == 2 && !engine.CanCancel, "User cancellation is returned to MSI once, never kills a process.");
            Check(engine.CancellationReply(0x08000000) == 1, "Do not interrupt rollback by repeatedly sending Cancel.");
            engine.ActionStarted("Rollback");
            Check(states[states.Count - 1] == "rollback" && !engine.Installed, "Cancellation/rollback cannot be reported as success.");
            engine.ActionStarted("InstallFiles");
            Check(states[states.Count - 1] == "rollback", "Rollback actions never regress to the install-new stage.");
            states.Clear();
            NativeEngine repair = new NativeEngine(update => states.Add(update.Stage), text => { }, new InstalledProduct(old.ProductCode, BuildInfo.Version),
                () => { throw new InvalidDataException("Repair must not remove."); }, () => true);
            Check(repair.PropertiesForProduct(old.ProductCode).Contains("REINSTALL=ALL REINSTALLMODE=omus"), "Exact ProductCode reinstall uses genuine maintenance.");
            repair.ActionStarted("RemoveExistingProducts"); repair.ActionStarted("InstallFiles");
            Check(!states.Contains("removing") && !repair.RemovalConfirmed && states.Contains("installing"), "Exact same-product repair never pretends to uninstall.");
            repair.ActionStarted("PublishProduct");
            Check(states[states.Count - 1] == "installing", "Existing repair payload cannot imply finishing before deferred execution begins.");
            Check(!repair.PropertiesForProduct("{22222222-2222-2222-2222-222222222222}").Contains("REINSTALL=ALL"), "Different ProductCode same-version rebuild retains transactional major-upgrade handling.");
            Reject(() => engine.PropertiesForProduct(old.ProductCode), "An older version cannot be repaired with a reused new-version ProductCode.");
        }
        private static void Preview()
        {
            foreach (string state in new[] { "upgrade", "repair", "downgrade", "removing", "rollback" })
            {
                SetupWindow preview = new SetupWindow(state);
                Check(System.Windows.Automation.AutomationProperties.GetItemStatus(preview.Window) == state,
                    "Automation exposes the real native setup state, not a heading guess.");
                string heading = ((TextBlock)preview.Window.FindName("Heading")).Text;
                string body = ((TextBlock)preview.Window.FindName("Description")).Text;
                Button primary = (Button)preview.Window.FindName("Primary");
                if (state == "upgrade") Check(heading.Contains("0.8.1") && body.Contains("Save your work") && primary.Content.ToString().IndexOf("save", StringComparison.OrdinalIgnoreCase) >= 0, "Upgrade preview displays version and explicit save/close action.");
                if (state == "repair") Check(heading.Contains(BuildInfo.Version) && primary.Content.ToString().Contains("reinstall"), "Same-version preview offers reinstall.");
                if (state == "downgrade") Check(primary.Visibility == System.Windows.Visibility.Collapsed && body.Contains(BuildInfo.Version), "Downgrade preview has no install action.");
                if (state == "removing") Check(body.Contains("0.8.1") && ((TextBlock)preview.Window.FindName("Stages")).Text.Contains("REMOVE OLD"), "Visible removal stage identifies old version.");
                if (state == "rollback") Check(primary.Visibility == System.Windows.Visibility.Collapsed && heading.Contains("Rolling back"), "Rollback waits without retry/install action.");
                preview.Window.Close();
            }
        }
    }
}
