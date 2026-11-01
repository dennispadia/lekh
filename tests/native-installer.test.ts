import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('hosted setup distinguishes hidden controls and reports native terminal-state details', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = join(root, 'scripts', 'Test-Setup.ps1');
  const command = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($request.path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw ($errors | Out-String) }
    foreach ($name in @('Test-HostedSetupProgress', 'Test-HostedSetupLogOwner', 'Test-ControlVisible')) {
      $function = $ast.Find({ param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
      }, $true)
      if ($null -eq $function) { throw ('Missing pure diagnostic helper ' + $name) }
      . ([scriptblock]::Create($function.Extent.Text))
    }
    $hidden = [pscustomobject]@{ Current = [pscustomobject]@{ IsOffscreen = $true } }
    $visible = [pscustomobject]@{ Current = [pscustomobject]@{ IsOffscreen = $false } }
    if ((Test-ControlVisible $null) -or (Test-ControlVisible $hidden) -or -not (Test-ControlVisible $visible)) {
      throw 'Preview visibility must distinguish absent, offscreen and visible controls.'
    }
    foreach ($state in @('preparing', 'removing', 'installing', 'finishing', 'stopping', 'rollback')) {
      $status = [pscustomobject]@{ State = $state; Heading = 'Working'; Description = ''; Details = '' }
      if (Test-HostedSetupProgress $status) { throw ('Nonterminal state falsely passed: ' + $state) }
    }
    foreach ($state in @('error', 'cancelled', 'restart', 'open', 'detection-error', 'downgrade', 'installed')) {
      $status = [pscustomobject]@{ State = $state; Heading = 'Failure heading'; Description = 'Exact failure description'; Details = 'Windows Installer code 1603; native failure.' }
      $failure = ''
      try { [void](Test-HostedSetupProgress $status) } catch { $failure = $_.Exception.Message }
      if (-not $failure.Contains($state) -or -not $failure.Contains($status.Description) -or -not $failure.Contains($status.Details)) {
        throw ('Missing native terminal-state diagnostics: ' + $state)
      }
    }
    $status = [pscustomobject]@{ State = 'success'; Heading = "You're ready to write."; Description = ''; Details = '' }
    if (-not (Test-HostedSetupProgress $status)) { throw 'Real success state/heading rejected.' }
    $status.Heading = 'Installing'
    $failure = ''
    try { [void](Test-HostedSetupProgress $status) } catch { $failure = $_.Exception.Message }
    if (-not $failure.Contains('unexpected accessible heading')) { throw 'Success heading guard was weakened.' }
    $header = '2026-10-31T18:00:00Z Starting Lekh Setup 0.9.0. Current-user, offline installation.'
    $owner = '2026-10-31T18:00:00Z Setup process 1234.'
    if (-not (Test-HostedSetupLogOwner $header $owner 1234 '0.9.0')) { throw 'Exact owned log rejected.' }
    if (Test-HostedSetupLogOwner $header $owner 5678 '0.9.0') { throw 'Another process log accepted.' }
    if (Test-HostedSetupLogOwner $header $owner 1234 '0.8.1') { throw 'Another version log accepted.' }
    if (Test-HostedSetupLogOwner $header ($owner + ' Unexpected suffix') 1234 '0.9.0') { throw 'Malformed ownership line accepted.' }
    Write-Output 'PASS: preview visibility, native-state failure details, strict success heading and exact version/process log ownership; no product operations.'
  `;
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], {
    encoding: 'utf8', timeout: 30_000, input: JSON.stringify({ path: scriptPath }),
  });
  assert.match(output, /PASS: preview visibility, native-state failure details, strict success heading/);
});

test('fresh setup diagnostics use the existing hosted artifact and never collect another setup session', async () => {
  const [script, setup] = await Promise.all([
    readFile(join(root, 'scripts', 'Test-Setup.ps1'), 'utf8'),
    readFile(join(root, 'installer', 'Setup.cs'), 'utf8'),
  ]);
  assert.ok(setup.includes('AutomationProperties.SetItemStatus(Window, next)'));
  assert.ok(setup.includes('WriteLog("Setup process " + Process.GetCurrentProcess().Id + ".")'));
  assert.ok(script.includes("'build\\setup\\upgrade\\fresh-setup-'"));
  const capture = script.slice(script.indexOf('function Save-HostedSetupDiagnostics'), script.indexOf('function Test-HostedInstallation'));
  assert.ok(capture.includes("-not $InstallOnHostedRunner -or $env:GITHUB_ACTIONS -cne 'true'"));
  assert.ok(capture.includes("[IO.FileAttributes]::ReparsePoint"));
  assert.ok(capture.includes('Test-HostedSetupLogOwner $header[0] $header[1] $Process.Id $manifest.version'));
  assert.ok(capture.includes("@('setup.log', 'windows-installer.log')"));
  assert.doesNotMatch(capture, /-Recurse|Remove-Item|MsiInstallProduct|MsiConfigureProduct|Start-Process|Stop-Process/);
  assert.ok(script.includes("if ($attempted -and $null -ne $failure)"));
  assert.ok(script.includes("if ($attempted -and $setupExited)"));
});

test('native automatic startup, running-app retry, same-version rejection, truthful upgrade stages and cancellation', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = join(root, 'build', 'tests', `native-installer-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    const info = join(directory, 'BuildInfo.cs');
    await writeFile(info, `namespace Lekh.Setup {
      internal static class BuildInfo {
        internal const string Version = "${manifest.version}";
        internal const string PayloadHash = "${'0'.repeat(64)}";
        internal const string ProductName = "Lekh - Markdown editor";
        internal const string ExecutableName = "Lekh - Markdown editor.exe";
        internal const string InstallDirectory = "lekh";
      }
    }`);
    const runner = join(directory, 'Runner.cs');
    await writeFile(runner, `namespace Lekh.Setup {
      internal static class TestRunner {
        [System.STAThread] public static int Main() { return EngineTests.Run(); }
      }
    }`);
    const framework = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    const compiler = join(framework, 'csc.exe');
    const references = ['System.dll', 'System.Core.dll', 'System.Xaml.dll',
      'WPF\\WindowsBase.dll', 'WPF\\PresentationCore.dll', 'WPF\\PresentationFramework.dll']
      .map(reference => `/reference:${join(framework, reference)}`);
    const sources = ['Engine.cs', 'Story.cs', 'EngineTests.cs', 'Setup.cs'].map(source => join(root, 'installer', source));
    const resources = [
      `/resource:${join(root, 'installer', 'Setup.xaml')},Setup.Window.xaml`,
      `/resource:${join(root, 'assets', 'icon.png')},Setup.Logo.png`,
    ];
    const executable = join(directory, 'NativeTests.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/warnaserror+',
      '/main:Lekh.Setup.TestRunner', `/out:${executable}`, ...references, ...resources, ...sources, info, runner],
    { encoding: 'utf8', timeout: 30_000 });
    let output: string;
    try {
      output = execFileSync(executable, [], { encoding: 'utf8', timeout: 30_000 });
    } catch (error) {
      if (error instanceof Error && 'stdout' in error) {
        if (typeof error.stdout === 'string') console.error(error.stdout);
        else if (Buffer.isBuffer(error.stdout)) console.error(error.stdout.toString('utf8'));
      }
      throw error;
    }
    assert.match(output, /PASS: \d+ native setup assertions\./);
    console.log(output.trim());
    // Compile the shipping entry point too, but never run a real installer or product.
    execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/warnaserror+',
      `/win32manifest:${join(root, 'installer', 'Setup.manifest')}`,
      `/out:${join(directory, 'SetupCompileOnly.exe')}`, ...references, ...resources, ...sources, info],
    { encoding: 'utf8', timeout: 30_000 });

    const previewRunner = join(directory, 'PreviewRunner.cs');
    await writeFile(previewRunner, `namespace Lekh.Setup {
      internal static class PreviewRunner {
        [System.STAThread] public static int Main(string[] args) {
          if (args.Length != 1 || !args[0].StartsWith("--preview=")) return 1;
          string state = args[0].Substring("--preview=".Length);
          if (System.Array.IndexOf(SetupWindow.PreviewStates, state) < 0) return 1;
          var app = new System.Windows.Application();
          var setup = new SetupWindow(state);
          app.Run(setup.Window);
          return setup.ExitCode;
        }
      }
    }`);
    const previewExecutable = join(directory, 'SetupPreview.exe');
    execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/warnaserror+',
      '/main:Lekh.Setup.PreviewRunner', `/out:${previewExecutable}`, ...references, ...resources, ...sources, info, previewRunner],
    { encoding: 'utf8', timeout: 30_000 });
    const previewCommand = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName UIAutomationClient
      Add-Type -AssemblyName UIAutomationTypes
      $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
      $tokens = $null; $errors = $null
      $ast = [Management.Automation.Language.Parser]::ParseFile($request.script, [ref]$tokens, [ref]$errors)
      if ($errors.Count -gt 0) { throw ($errors | Out-String) }
      foreach ($name in @('Find-Control', 'Test-ControlVisible', 'Wait-Until', 'Wait-SetupWindow', 'Test-SetupPreview')) {
        $function = $ast.Find({ param($node)
          $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
        }, $true)
        if ($null -eq $function) { throw ('Missing preview helper ' + $name) }
        . ([scriptblock]::Create($function.Extent.Text))
      }
      $SetupPath = $request.executable
      $manifest = [pscustomobject]@{ version = $request.version }
      foreach ($state in @('ready', 'upgrade', 'installed', 'open', 'removing', 'rollback')) {
        Test-SetupPreview $state $false
      }
    `;
    const previewOutput = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(previewCommand, 'utf16le').toString('base64')], {
      encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify({ script: join(root, 'scripts', 'Test-Setup.ps1'), executable: previewExecutable, version: manifest.version }),
    });
    for (const state of ['ready', 'upgrade', 'installed', 'open', 'removing', 'rollback']) {
      assert.match(previewOutput, new RegExp(`PASS: native accessible preview ${state}\\.`));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native setup never terminates the editor, restarts it, or performs a separate uninstall', async () => {
  const [engine, setup] = await Promise.all([
    readFile(join(root, 'installer', 'Engine.cs'), 'utf8'),
    readFile(join(root, 'installer', 'Setup.cs'), 'utf8'),
  ]);
  assert.doesNotMatch(engine + setup, /\.Kill\(|CloseMainWindow|MsiConfigureProduct|taskkill|MSIRMSHUTDOWN|Restart-Computer/i);
  for (const property of ['REBOOT=ReallySuppress', 'MSIRESTARTMANAGERCONTROL=DisableShutdown', 'MSIDISABLERMRESTART=1']) {
    assert.ok(engine.includes(property));
  }
  assert.ok(setup.indexOf('else RefreshReady();') < setup.indexOf('private void Primary()'),
    'registration detection runs before the initial ready page, not only after Install');
  assert.ok(setup.includes('!InstalledProduct.Same(previousProduct, ProductDiscovery.Detect())'),
    'registration is rechecked immediately before extraction/installation');
  const launch = setup.indexOf('Process.Start(new ProcessStartInfo(SetupPolicy.AppPath)');
  assert.ok(setup.lastIndexOf('if (state == "success")', launch) >= 0, 'app launch remains an explicit success-page action only');
});

test('running-editor detection compares executable paths without filtering Windows sessions', async () => {
  const engine = await readFile(join(root, 'installer', 'Engine.cs'), 'utf8');
  const detection = engine.slice(engine.indexOf('internal static bool AppIsOpen('), engine.indexOf('public static void ValidateProperties'));
  assert.match(detection, /IsInstalledApp\(executablePath\(process\)\)/);
  assert.match(detection, /process\.MainModule\.FileName/);
  assert.match(detection, /if \(!process\.HasExited\) throw/);
  assert.doesNotMatch(detection, /SessionId|catch\s*\(Exception/);
});
