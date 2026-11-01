using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

[assembly: System.Reflection.AssemblyTitle("Lekh: Markdown editor Setup")]
[assembly: System.Reflection.AssemblyVersion(Lekh.Setup.BuildInfo.Version)]
[assembly: System.Reflection.AssemblyFileVersion(Lekh.Setup.BuildInfo.Version)]

namespace Lekh.Setup
{
    internal sealed class StoryTextBlock : TextBlock
    {
        protected override AutomationPeer OnCreateAutomationPeer() { return new StoryTextPeer(this); }
        private sealed class StoryTextPeer : TextBlockAutomationPeer
        {
            internal StoryTextPeer(TextBlock owner) : base(owner) { }
            protected override bool IsControlElementCore() { return false; }
            protected override bool IsContentElementCore() { return false; }
        }
    }

    internal static class Program
    {
        [STAThread]
        public static int Main(string[] arguments)
        {
            try
            {
                if (arguments.Length == 1 && arguments[0] == "--self-test") return EngineTests.Run();
                if (arguments.Length == 1 && arguments[0] == "--verify-payload")
                {
                    string root = Path.Combine(Path.GetTempPath(), "lekh-setup-check-" + Guid.NewGuid().ToString("N"));
                    string package = null;
                    try { package = Payload.Extract(() => false, root); }
                    finally
                    {
                        if (package != null) Payload.Remove(package);
                        if (Directory.Exists(root)) Directory.Delete(root);
                    }
                    return 0;
                }
                string preview = null;
                if (arguments.Length > 0)
                {
                    if (arguments.Length != 1 || !arguments[0].StartsWith("--preview=", StringComparison.Ordinal))
                        throw new ArgumentException("Use --preview=<state>, --verify-payload, or --self-test. No silent installation is supported.");
                    preview = arguments[0].Substring("--preview=".Length);
                    if (Array.IndexOf(SetupWindow.PreviewStates, preview) < 0) throw new ArgumentException("Unknown setup preview state.");
                }
                using (Mutex mutex = new Mutex(false, "Local\\LekhSetup-" + WindowsIdentity.GetCurrent().User.Value))
                {
                    bool owned;
                    try { owned = mutex.WaitOne(0); }
                    catch (AbandonedMutexException) { owned = true; }
                    if (!owned)
                    {
                        MessageBox.Show("Lekh Setup is already open. Switch to the existing setup window.", "Lekh Setup");
                        return 1618;
                    }
                    try
                    {
                        Application app = new Application();
                        SetupWindow controller = new SetupWindow(preview);
                        app.Run(controller.Window);
                        return controller.ExitCode;
                    }
                    finally { mutex.ReleaseMutex(); }
                }
            }
            catch (Exception error)
            {
                MessageBox.Show("Setup could not start." + Environment.NewLine + error.Message,
                    "Lekh Setup", MessageBoxButton.OK, MessageBoxImage.Error);
                return 1;
            }
        }
    }

    internal sealed class SetupWindow
    {
        public static readonly string[] PreviewStates = { "ready", "upgrade", "installed", "downgrade", "open", "preparing", "removing", "installing", "finishing", "rollback", "success", "restart", "error", "stopping", "cancelled" };
        public readonly Window Window;
        public int ExitCode { get; private set; }
        private readonly bool preview;
        private string state = "ready", logDirectory;
        private StreamWriter log;
        private readonly object logLock = new object();
        private NativeEngine engine;
        private InstalledProduct previousProduct;
        private readonly Func<InstalledProduct> detectProduct;
        private readonly Func<bool> appIsOpen;
        private readonly Action beginInstallation;
        private volatile bool requestedCancel;
        private bool busy, allowClose;
        private Window confirmation;
        private readonly Button primary, secondary;
        private readonly TextBlock heading, description, mark, notice, caption, stages;
        private readonly ProgressBar progress;
        private readonly Expander details;
        private readonly TextBox detailText;
        private readonly Brush accent = new SolidColorBrush(Color.FromRgb(128, 191, 184));
        private readonly Story story = new Story();
        private readonly Stopwatch storyClock = Stopwatch.StartNew();
        private readonly DispatcherTimer storyTimer = new DispatcherTimer();
        private bool storyPaused;
        private bool storyStarted;

        public SetupWindow(string previewState, Func<InstalledProduct> detect = null, Func<bool> isOpen = null, Action begin = null)
        {
            preview = previewState != null;
            detectProduct = detect ?? ProductDiscovery.Detect;
            appIsOpen = isOpen ?? SetupPolicy.AppIsOpen;
            beginInstallation = begin ?? StartInstallation;
            using (Stream xaml = typeof(SetupWindow).Assembly.GetManifestResourceStream("Setup.Window.xaml"))
            {
                if (xaml == null) throw new InvalidDataException("Setup window resource is missing.");
                Window = (Window)XamlReader.Load(xaml);
            }
            TextBlock placeholder = Find<TextBlock>("StoryWritten");
            StoryTextBlock visual = new StoryTextBlock {
                Name = "StoryWritten", MinHeight = placeholder.MinHeight, FontSize = placeholder.FontSize,
                LineHeight = placeholder.LineHeight, TextWrapping = placeholder.TextWrapping, Foreground = placeholder.Foreground
            };
            while (placeholder.Inlines.FirstInline != null)
            {
                Inline inline = placeholder.Inlines.FirstInline;
                placeholder.Inlines.Remove(inline);
                visual.Inlines.Add(inline);
            }
            Grid storyHost = (Grid)placeholder.Parent;
            storyHost.Children.Remove(placeholder);
            storyHost.Children.Add(visual);
            Window.UnregisterName("StoryWritten");
            Window.RegisterName("StoryWritten", visual);
            AutomationProperties.SetAutomationId(visual, "StoryWritten");
            primary = Find<Button>("Primary"); secondary = Find<Button>("Secondary");
            heading = Find<TextBlock>("Heading"); description = Find<TextBlock>("Description");
            mark = Find<TextBlock>("StateMark"); notice = Find<TextBlock>("Notice");
            caption = Find<TextBlock>("ProgressCaption"); stages = Find<TextBlock>("Stages");
            progress = Find<ProgressBar>("Progress"); details = Find<Expander>("Details");
            detailText = Find<TextBox>("DetailText");
            using (Stream image = typeof(SetupWindow).Assembly.GetManifestResourceStream("Setup.Logo.png"))
            {
                if (image == null) throw new InvalidDataException("Setup logo is missing.");
                BitmapImage bitmap = new BitmapImage();
                bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad; bitmap.StreamSource = image; bitmap.EndInit(); bitmap.Freeze();
                Find<Image>("Logo").Source = bitmap;
                Window.Icon = bitmap;
            }
            Find<TextBlock>("VersionLabel").Text = "WINDOWS SETUP  /  " + BuildInfo.Version;
            Window.MaxHeight = SystemParameters.WorkArea.Height;
            Window.MaxWidth = SystemParameters.WorkArea.Width;
            Window.MinWidth = Math.Min(Window.MinWidth, Window.MaxWidth);
            Find<FrameworkElement>("TitleBar").MouseLeftButtonDown += (sender, args) =>
            {
                if (args.OriginalSource is Button) return;
                if (args.ButtonState == MouseButtonState.Pressed) Window.DragMove();
            };
            Find<Button>("Minimize").Click += (sender, args) => Window.WindowState = WindowState.Minimized;
            Find<Button>("CloseWindow").Click += (sender, args) => Close();
            Find<Button>("OpenLog").Click += (sender, args) => OpenLogs();
            primary.Click += (sender, args) => Primary();
            secondary.Click += (sender, args) => Close();
            Window.Closing += Closing;
            Window.PreviewKeyDown += (sender, args) =>
            {
                if (args.Key == Key.Escape) { args.Handled = true; Close(); }
            };
            storyTimer.Interval = TimeSpan.FromMilliseconds(Story.LetterMilliseconds);
            storyTimer.Tick += (sender, args) => { if (story.Tick(storyClock.ElapsedMilliseconds)) PaintStory(); };
            Find<Button>("StoryPrevious").Click += (sender, args) => BrowseStory(-1);
            Find<Button>("StoryNext").Click += (sender, args) => BrowseStory(1);
            Find<Button>("StoryPause").Click += (sender, args) => { storyPaused = !storyPaused; SyncStory(); };
            Window.StateChanged += (sender, args) => SyncStory();
            Window.IsVisibleChanged += (sender, args) => SyncStory();
            SystemParameters.StaticPropertyChanged += MotionChanged;
            Window.Closed += (sender, args) =>
            {
                storyTimer.Stop();
                SystemParameters.StaticPropertyChanged -= MotionChanged;
                if (log != null) log.Dispose();
            };
            if (preview) Find<TextBlock>("PreviewBadge").Visibility = Visibility.Visible;
            if (preview)
            {
                if (previewState == "upgrade" || previewState == "removing" || previewState == "rollback")
                    previousProduct = new InstalledProduct("{11111111-1111-1111-1111-111111111111}", "0.8.1");
                else if (previewState == "installed") previousProduct = new InstalledProduct("{11111111-1111-1111-1111-111111111111}", BuildInfo.Version);
                else if (previewState == "downgrade") previousProduct = new InstalledProduct("{11111111-1111-1111-1111-111111111111}", "99.0.0");
                Render(previewState, null);
            }
            else RefreshReady();
            Window.ContentRendered += ContentRendered;
        }
        private T Find<T>(string name) where T : FrameworkElement
        {
            T result = Window.FindName(name) as T;
            if (result == null) throw new InvalidDataException("Setup UI is missing " + name + ".");
            return result;
        }
        private void WriteLog(string text)
        {
            lock (logLock)
            {
                if (log == null) throw new InvalidOperationException("Setup diagnostic log is not open.");
                log.WriteLine(DateTimeOffset.Now.ToString("o") + " " + text);
                log.Flush();
            }
        }
        private void RefreshReady()
        {
            try
            {
                previousProduct = detectProduct();
                Render(SetupPolicy.ReadyState(previousProduct, appIsOpen), null);
            }
            catch (Exception error)
            {
                Render("detection-error", null);
                description.Text = "Setup could not safely check the installed Lekh version.\n" + error.Message;
                ExitCode = 1;
            }
        }
        private void ContentRendered(object sender, EventArgs args)
        {
            Window.ContentRendered -= ContentRendered;
            if (!preview) CheckAndStart();
            if (primary.IsVisible) primary.Focus(); else secondary.Focus();
        }
        private void CheckAndStart()
        {
            if (busy) return;
            RefreshReady();
            if (state == "ready" || state == "upgrade") beginInstallation();
        }
        private void Render(string next, int? percent)
        {
            state = next;
            string title, body, label = "SETTING UP", action = null, secondaryAction = "Cancel", note = null;
            switch (next)
            {
                case "ready":
                    label = "YOUR WRITING DESK"; title = "A quieter place to write.";
                    body = "Install Lekh for your Windows account.\nWrite locally. Keep your files. Make room for ideas.";
                    secondaryAction = "Cancel";
                    note = "Unsigned software: Windows may warn about or block setup. Follow your organization's policies; do not disable security protections.";
                    break;
                case "upgrade":
                    label = "UPGRADING"; title = "Upgrading Lekh " + previousProduct.Version + " to " + BuildInfo.Version + ".";
                    body = "Setup will remove the previous version, then install the new one.\nYour profile and documents are preserved.";
                    note = "Setup will visibly remove this version, then install Lekh " + BuildInfo.Version +
                        " in one Windows Installer transaction. If it fails or is cancelled, Windows rolls back the changes. Your profile and documents are preserved.";
                    break;
                case "installed":
                    label = "ALREADY INSTALLED"; title = "Lekh " + BuildInfo.Version + " is already installed.";
                    body = "This version is already installed.\nNo installation changes are needed.";
                    secondaryAction = "Close";
                    break;
                case "downgrade":
                    label = "NEWER VERSION INSTALLED"; title = "Keep Lekh " + previousProduct.Version + ".";
                    body = "This installer contains Lekh " + BuildInfo.Version + ".\nSetup will not replace your newer installation.";
                    secondaryAction = "Close"; break;
                case "detection-error":
                    label = "BEFORE WE BEGIN"; title = "Check the installed version.";
                    body = "Setup could not safely check the existing installation.\nNo application changes have been made.";
                    action = "Check again"; secondaryAction = "Close"; break;
                case "open":
                    label = "BEFORE WE BEGIN"; title = "Save your work first.";
                    body = (previousProduct == null ? "Lekh is open." : "Lekh " + previousProduct.Version + " is installed and open.") +
                        "\nSave your work and close Lekh, then check again.";
                    note = "Setup will never force-close the editor or discard unsaved work." +
                        (previousProduct == null ? "" : " After you close it, Setup will upgrade to Lekh " + BuildInfo.Version + ".");
                    action = "Check again"; secondaryAction = "Not now"; break;
                case "preparing":
                    title = previousProduct == null ? "Getting things ready." :
                        "Upgrading Lekh " + previousProduct.Version + " to " + BuildInfo.Version + ".";
                    body = "Checking Windows and verifying the offline installer.\nYou can keep working in your other apps."; break;
                case "installing":
                    title = "Installing Lekh."; body = "Adding Lekh " + BuildInfo.Version + " and its shortcuts.\nYour Markdown documents are not part of the installation."; break;
                case "removing":
                    title = "Removing previous Lekh.";
                    body = "Windows Installer is uninstalling Lekh " + (previousProduct == null ? "previous version" : previousProduct.Version) +
                        ".\nYour profile, cache and documents are preserved.";
                    note = "The new application payload has not started. Windows can restore the previous version if this transaction fails or is cancelled."; break;
                case "rollback":
                    label = "RESTORING SAFELY"; title = "Rolling back changes.";
                    body = "Windows is restoring the installation's previous state.\nKeep Setup open. Do not restart Windows yet."; secondaryAction = null; break;
                case "finishing":
                    label = "ALMOST THERE"; title = "Adding the finishing touches.";
                    body = "Finalizing Windows registration.\nWe will let you know when everything is ready."; break;
                case "stopping":
                    label = "STOPPING SAFELY"; title = "Stopping installation.";
                    body = "Waiting for Windows to cancel and roll back changes.\nPlease keep Setup open until this finishes."; secondaryAction = null; break;
                case "success":
                    label = "READY WHEN YOU ARE"; title = "You're ready to write.";
                    body = "Lekh is installed for your Windows account.\nYour next idea has a home.";
                    action = "Open Lekh"; secondaryAction = "Close"; break;
                case "restart":
                    label = "INSTALLED"; title = "One more step.";
                    body = "Windows needs a restart to finish applying the changes.\nOpen Lekh after restarting.";
                    note = "Your computer will not restart automatically. Restart when it is convenient.";
                    action = "Finish"; secondaryAction = null; break;
                case "cancelled":
                    label = "SETUP STOPPED"; title = "Installation cancelled.";
                    body = "Windows has finished stopping the installation.\nYou can return to Setup whenever you are ready.";
                    action = "Try again"; secondaryAction = "Close"; break;
                default:
                    label = "NEEDS YOUR ATTENTION"; title = "Setup couldn't finish.";
                    body = "Review the details below, then try again.";
                    action = "Try again"; secondaryAction = "Close"; break;
            }
            heading.Text = title; description.Text = body; mark.Text = label;
            notice.Text = note ?? ""; Find<FrameworkElement>("NoticeArea").Visibility = note == null ? Visibility.Collapsed : Visibility.Visible;
            primary.Content = action; primary.Visibility = action == null ? Visibility.Collapsed : Visibility.Visible;
            secondary.Content = secondaryAction; secondary.Visibility = secondaryAction == null ? Visibility.Collapsed : Visibility.Visible;
            secondary.IsEnabled = true;
            bool progressing = next == "preparing" || next == "removing" || next == "installing" || next == "finishing" || next == "stopping" || next == "rollback";
            Find<FrameworkElement>("ProgressArea").Visibility = progressing ? Visibility.Visible : Visibility.Collapsed;
            progress.IsIndeterminate = percent == null && SystemParameters.ClientAreaAnimation;
            progress.Value = percent ?? 0;
            caption.Text = next == "preparing" ? "Verifying the embedded installer." : next == "stopping" ? "Waiting for Windows Installer to finish." :
                percent.HasValue ? percent.Value + "% of the current Windows Installer stage." : "Waiting for Windows Installer.";
            stages.Visibility = next == "stopping" || next == "rollback" ? Visibility.Collapsed : Visibility.Visible;
            stages.Text = previousProduct != null &&
                (previousProduct.Mode == "upgrade" || next == "removing" || (engine != null && engine.RemovalConfirmed)) &&
                (engine == null || !engine.IsRepair) ?
                next == "preparing" ? "PREPARE    /    Remove old    /    Install new    /    Finish" :
                next == "removing" ? "Prepare    /    REMOVE OLD    /    Install new    /    Finish" :
                next == "finishing" ? "Prepare    /    Remove old    /    Install new    /    FINISH" :
                "Prepare    /    Remove old    /    INSTALL NEW    /    Finish" :
                next == "preparing" ? "PREPARE    /    Install    /    Finish" : next == "finishing" ? "Prepare    /    Install    /    FINISH" : "Prepare    /    INSTALL    /    Finish";
            Find<TextBlock>("Benefits").Visibility = next == "ready" || next == "success" ? Visibility.Visible : Visibility.Collapsed;
            Find<TextBlock>("Assurance").Text = progressing ? "Your documents stay yours.\nNo forced restart." : "No account. No cloud setup.\nYour documents stay yours.";
            details.Visibility = next == "error" || next == "cancelled" ? Visibility.Visible : Visibility.Collapsed;
            details.IsExpanded = false;
            SyncStory();
            if (preview)
            {
                detailText.Text = "Design preview: no installation, app closure, or restart is performed.\nExample: Windows Installer code 1618.";
                Find<Button>("OpenLog").IsEnabled = false;
            }
            AutomationProperties.SetItemStatus(Window, next);
        }
        private void MotionChanged(object sender, PropertyChangedEventArgs args)
        {
            if (args.PropertyName == "ClientAreaAnimation") Window.Dispatcher.BeginInvoke(new Action(SyncStory));
        }
        private void BrowseStory(int direction)
        {
            story.Browse(direction, storyClock.ElapsedMilliseconds);
            PaintStory();
        }
        private void SyncStory()
        {
            bool active = state == "preparing" || state == "removing" || state == "installing" || state == "finishing";
            if (active) storyStarted = true;
            Find<FrameworkElement>("StoryArea").Visibility = storyStarted ? Visibility.Visible : Visibility.Collapsed;
            bool playing = active && !storyPaused && SystemParameters.ClientAreaAnimation &&
                Window.IsVisible && Window.WindowState != WindowState.Minimized;
            story.Play(playing, storyClock.ElapsedMilliseconds);
            if (playing) storyTimer.Start(); else storyTimer.Stop();
            PaintStory();
        }
        private void PaintStory()
        {
            Find<TextBlock>("StoryTitle").Text = Story.Titles[story.Index];
            TextBlock accessible = Find<TextBlock>("StoryAccessible");
            accessible.Text = Story.Chapters[story.Index];
            // Expose complete text immediately; the visual text changes without announcing every letter.
            AutomationProperties.SetName(Find<TextBlock>("StoryTitle"), Story.Titles[story.Index] + " " + accessible.Text);
            Run ink = Window.FindName("StoryInk") as Run;
            if (ink == null) throw new InvalidDataException("Setup UI is missing StoryInk.");
            ink.Text = story.Written;
            AutomationProperties.SetName(Find<TextBlock>("StoryWritten"), story.Written);
            Find<FrameworkElement>("StoryQuill").Visibility = story.Writing ? Visibility.Visible : Visibility.Collapsed;
            Find<TextBlock>("StoryCount").Text = (story.Index + 1) + " / " + Story.Chapters.Length;
            Button pause = Find<Button>("StoryPause");
            pause.IsEnabled = SystemParameters.ClientAreaAnimation &&
                (state == "preparing" || state == "removing" || state == "installing" || state == "finishing");
            pause.Content = !SystemParameters.ClientAreaAnimation ? "Animation off" : storyPaused ? "Resume story" : "Pause story";
        }
        private void Primary()
        {
            if (busy) return;
            if (state == "restart") { allowClose = true; Window.Close(); return; }
            if (state == "success")
            {
                if (preview) { MessageBox.Show(Window, "Preview only: no application is launched.", "Lekh Setup"); return; }
                try
                {
                    if (!File.Exists(SetupPolicy.AppPath)) throw new FileNotFoundException("The installed application could not be found.", SetupPolicy.AppPath);
                    Process.Start(new ProcessStartInfo(SetupPolicy.AppPath) { UseShellExecute = true });
                    allowClose = true; Window.Close();
                }
                catch (Exception error) { ShowError(error); }
                return;
            }
            if (state == "downgrade" || state == "installed") return;
            if (preview) StartInstallation(); else CheckAndStart();
        }
        private async void StartInstallation()
        {
            if (busy) return;
            busy = true; requestedCancel = false; ExitCode = 1;
            Render("preparing", null);
            string package = null;
            try
            {
                if (preview)
                {
                    await Task.Delay(1000);
                    if (requestedCancel) throw new OperationCanceledException();
                    if (previousProduct != null && previousProduct.Mode == "upgrade")
                    {
                        Render("removing", null);
                        await Task.Delay(1500);
                        if (requestedCancel)
                        {
                            Render("rollback", null);
                            await Task.Delay(1000);
                            throw new OperationCanceledException();
                        }
                    }
                    Render("installing", 20);
                    await Task.Delay(1500);
                    if (requestedCancel) throw new OperationCanceledException();
                    Render("finishing", null);
                    await Task.Delay(1000);
                    if (requestedCancel) throw new OperationCanceledException();
                    Finish(0);
                    return;
                }
                if (log == null)
                {
                    logDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Lekh", "SetupLogs", DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(logDirectory);
                    log = new StreamWriter(new FileStream(Path.Combine(logDirectory, "setup.log"), FileMode.CreateNew, FileAccess.Write, FileShare.Read));
                }
                WriteLog("Starting Lekh Setup " + BuildInfo.Version + ". Current-user, offline installation.");
                WriteLog("Setup process " + Process.GetCurrentProcess().Id + ".");
                engine = new NativeEngine(OnUpdate, WriteLog, previousProduct);
                uint result = await Task.Run(() =>
                {
                    if (!InstalledProduct.Same(previousProduct, ProductDiscovery.Detect()))
                        throw new InvalidDataException("The installed Lekh version changed before installation. Check again before continuing.");
                    if (SetupPolicy.AppIsOpen()) throw new AppOpenException();
                    package = Payload.Extract(() => requestedCancel);
                    WriteLog("Verified embedded MSI SHA-256 and identity. Cache: " + package);
                    if (requestedCancel) throw new OperationCanceledException();
                    if (SetupPolicy.AppIsOpen()) throw new AppOpenException();
                    // Keep the verified file read-locked for the entire native installation.
                    using (FileStream guard = new FileStream(package, FileMode.Open, FileAccess.Read, FileShare.Read))
                    {
                        if (!InstalledProduct.Same(previousProduct, ProductDiscovery.Detect()))
                            throw new InvalidDataException("The installed Lekh version changed while preparing setup. Check again before continuing.");
                        return engine.Install(package, Path.Combine(logDirectory, "windows-installer.log"));
                    }
                });
                WriteLog("Windows Installer finished with code " + result + ".");
                if (result == 1602 && (engine.FilesInUse || engine.CallbackFailed))
                {
                    Render("error", null);
                    description.Text = engine.FailureMessage;
                    detailText.Text = "Windows Installer code " + result + ".\nLogs: " + logDirectory;
                    ExitCode = (int)result;
                }
                else if (SetupPolicy.IsSuccess(result) || result == 1602) Finish(result);
                else
                {
                    Render("error", null);
                    description.Text = SetupPolicy.ErrorDescription(result);
                    detailText.Text = "Windows Installer code " + result + ".\n" + engine.FailureMessage + "\nLogs: " + logDirectory;
                    ExitCode = (int)result;
                }
            }
            catch (AppOpenException)
            {
                WriteLog("Setup paused before installation: installed application is open.");
                Render("open", null);
            }
            catch (OperationCanceledException)
            {
                if (!preview) WriteLog("Setup cancelled before Windows Installer began.");
                Finish(1602);
            }
            catch (Exception error) { ShowError(error); }
            finally
            {
                // Successful MSI source is retained for Windows repair. Failed/cancelled attempts are not retained.
                if (package != null && (engine == null || !engine.Installed))
                {
                    try { Payload.Remove(package); }
                    catch (Exception error) { ShowError(new IOException("Could not remove the unused setup cache.", error)); }
                }
                busy = false;
                if (confirmation != null) confirmation.DialogResult = false;
                if (primary.IsVisible) primary.Focus(); else secondary.Focus();
            }
        }
        private void OnUpdate(SetupUpdate update)
        {
            Window.Dispatcher.Invoke(new Action(() =>
            {
                if (!busy || allowClose) return;
                Render(update.Stage, update.Percent);
                secondary.IsEnabled = update.CanCancel;
            }), DispatcherPriority.Background);
        }
        private void Finish(uint result)
        {
            ExitCode = (int)result;
            Render(result == 1602 ? "cancelled" : result == 3010 ? "restart" : "success", null);
            detailText.Text = "Windows Installer code " + result + ".\nLogs: " + logDirectory;
        }
        private void ShowError(Exception error)
        {
            string loggingFailure = "";
            if (log != null)
            {
                try { WriteLog(error.ToString()); }
                catch (IOException logError) { loggingFailure = "\nSetup logging failed: " + logError.Message; }
                catch (UnauthorizedAccessException logError) { loggingFailure = "\nSetup logging was denied: " + logError.Message; }
            }
            Render("error", null);
            description.Text = error.Message;
            detailText.Text = error.ToString() + loggingFailure + "\nLogs: " + (logDirectory ?? "Not available: setup could not create a log.");
            Find<Button>("OpenLog").IsEnabled = logDirectory != null;
            ExitCode = 1;
        }
        private void OpenLogs()
        {
            try
            {
                if (logDirectory == null || !Directory.Exists(logDirectory)) throw new DirectoryNotFoundException("Setup logs are not available.");
                Process.Start(new ProcessStartInfo(logDirectory) { UseShellExecute = true });
            }
            catch (Exception error) { ShowError(error); }
        }
        private bool ConfirmCancel()
        {
            if (confirmation != null) return false;
            confirmation = new Window
            {
                Owner = Window, Title = "Stop installation?", Width = 410, SizeToContent = SizeToContent.Height,
                WindowStartupLocation = WindowStartupLocation.CenterOwner, ResizeMode = ResizeMode.NoResize,
                Background = new SolidColorBrush(Color.FromRgb(29, 37, 36)), Foreground = Window.Foreground,
                FontFamily = Window.FontFamily, ShowInTaskbar = false
            };
            StackPanel panel = new StackPanel { Margin = new Thickness(24) };
            panel.Children.Add(new TextBlock { Text = "Stop installation?", FontSize = 20, FontWeight = FontWeights.Medium });
            panel.Children.Add(new TextBlock
            {
                Text = "Setup will ask Windows to cancel and roll back changes. Keep this window open until Windows finishes.",
                TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 12, 0, 22), Foreground = new SolidColorBrush(Color.FromRgb(171, 182, 172))
            });
            StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
            Button stop = new Button { Content = "Stop installation", Margin = new Thickness(0, 0, 10, 0), Padding = new Thickness(12, 8, 12, 8) };
            Button keep = new Button { Content = "Keep installing", Background = accent, Foreground = Brushes.Black, Padding = new Thickness(12, 8, 12, 8), IsDefault = true, IsCancel = true };
            stop.Click += (sender, args) => confirmation.DialogResult = true;
            keep.Click += (sender, args) => confirmation.DialogResult = false;
            actions.Children.Add(stop); actions.Children.Add(keep); panel.Children.Add(actions); confirmation.Content = panel;
            confirmation.ContentRendered += (sender, args) => keep.Focus();
            bool result = confirmation.ShowDialog() == true;
            confirmation = null;
            return result;
        }
        private void Close()
        {
            if (busy)
            {
                if (requestedCancel) return;
                if (engine != null && !engine.CanCancel)
                {
                    MessageBox.Show(Window, "Windows is finishing a stage that cannot be cancelled. Please wait.", "Lekh Setup");
                    return;
                }
                if (ConfirmCancel() && busy)
                {
                    requestedCancel = true;
                    if (engine != null) engine.Cancel();
                    Render("stopping", null);
                }
                return;
            }
            allowClose = true; Window.Close();
        }
        private void Closing(object sender, CancelEventArgs args)
        {
            if (busy && !allowClose) { args.Cancel = true; Close(); }
        }
        private sealed class AppOpenException : Exception { }
    }
}
