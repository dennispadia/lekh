# Building and validating Lekh

This checkout builds the version in `package.json`. See the [latest verified release](https://github.com/dennispadia/lekh/releases/latest) for downloads; the commands below build this checkout. Earlier published assets remain unchanged.

## Requirements

- Windows 10/11 x64.
- Node.js >=22.15.0 and npm. The setup script and CI use Node 22.22.0.
- Windows .NET Framework 4.8 or newer with WPF and its framework C# compiler (included in current Windows 10/11 versions). No separate .NET SDK is required for setup.
- Internet access for the first dependency, Electron runtime, and WiX tool downloads.

WiX is fetched by electron-builder; you do not need to install Word, Pandoc, or WiX manually. First builds can take several minutes. Windows corporate policy can restrict downloads or installer execution.

```powershell
npm.cmd ci --registry=https://registry.npmjs.org
npm.cmd test
npm.cmd run test:desktop
```

If you use the private runtime downloaded by `Setup.ps1`, first add it to the current shell:

```powershell
$env:PATH = "$PWD\.tools\node-v22.22.0-win-x64;$env:PATH"
```

Desktop tests need an interactive Windows desktop. They create temporary sample files and an isolated app profile, provide their own native-dialog selections and clipboard stubs through loopback debugging, and close their test process afterward. They do not use your real clipboard or documents.

When Windows does not permit file symlinks, the local symlink-specific include test is skipped. The official workflow also runs that test on a Linux runner and requires it to pass without skipping.

## Build outputs

Close running copies before rebuilding. Do not run two packaging/build commands concurrently: Vite replaces `dist`, and the packager may still be reading it.

| Command | Result |
| --- | --- |
| `npm run build` | TypeScript checking, generated icons, and Vite application output |
| `npm run package` | Developer app in `release\win-unpacked\Lekh - Markdown editor.exe` |
| `npm run package:msi` | Self-contained `release\Lekh-Markdown-editor-<version>-x64.msi` and unpacked app |
| `npm run verify:msi` | Checks MSI properties, per-user/limited scope, shortcuts, cabinet and upgrades; extracts its payload and runs the complete desktop suite against it |
| `npm run build:setup` | Compiles the native WPF `release\Lekh-Markdown-editor-Setup-<version>-x64.exe`, embedding the previously built MSI and its SHA-256 identity |
| `npm run verify:setup` | Native engine/story self-tests, embedded payload verification, and isolated UI Automation previews; does not install or uninstall the app locally |
| `npm run package:source` | Clean, allowlisted source ZIP, excluding tools, dependencies, output, and private configuration |
| `npm run release:checksums` | SHA-256 checksum list for the public setup EXE and source ZIP |

`verify:msi` performs **administrative extraction**, not a product installation. It does not register/unregister the app or create user shortcuts. Test real installation, upgrade, repair, and uninstall in a disposable Windows VM before a wider release.

The official workflow additionally runs `verify:setup -- -InstallOnHostedRunner` only on a clean GitHub-hosted runner. That opt-in path performs a real fresh installation through the setup UI, verifies the exact current-user product name/version/cache through Windows Installer APIs, then uninstalls only that exact product and checks the recovery-profile sentinel remains. It also exercises both animation preferences and restores the runner's original preference in `finally`. Default local verification neither installs/uninstalls nor changes your Windows animation setting; reduced-motion mode remains static.

The current `scripts/Test-Upgrade.ps1` is deliberately bounded to the genuine published **0.9.4 -> 0.9.5** lineage and refuses product maintenance without its explicit GitHub-hosted runner gate. It pins the old public EXE's size and SHA-256, verifies exact registrations/payloads, and tests cancellation only after the old registration/executable/`app.asar` are proven absent. Windows must return cancellation code 1602 and restore the old registration, every old payload byte and seeded profile data. It then exercises the real new EXE's idle automatic upgrade, same-version rejection with the editor closed/open, and one-click recheck after gracefully closing an owned blank editor using an isolated profile. No application is forcibly closed. Repair restores a deliberately removed current `app.asar`; exact-product uninstall retains the seeded profile. Foreign registrations, unowned running apps, reparse points and unrecognized residue are rejected. The [official 0.9.4 build](https://github.com/dennispadia/lekh/actions/runs/41371030781) verified the preceding 0.9.3 -> 0.9.4 lineage; the [0.9.3 build](https://github.com/dennispadia/lekh/actions/runs/41337839291) verified 0.9.2 -> 0.9.3.

Setup checks the installed version before checking running processes. The same version reports already installed, and a newer version blocks downgrade; neither offers installation. Fresh installs and closed older-version upgrades start automatically once the window renders. Only a running editor prompts to save/close, and one **Check again** re-evaluates registration/processes and starts immediately when safe. Registration and running-app guards are repeated before payload extraction and installation. The MSI schedules `RemoveExistingProducts` after `InstallInitialize`, inside rollback protection. Real callbacks distinguish removal, the verified removal checkpoint, new-payload installation and finalization; nested old-uninstall callbacks cannot announce the new installation prematurely. A separate destructive pre-upgrade uninstall is not used, and installation refuses a policy that disables rollback. Windows Installer maintenance/repair remains available independently; the setup EXE does not offer same-version reinstall.

The intended public download is the premium **EXE**, not the internal MSI. Run `package:msi`, `verify:msi`, `build:setup`, and `verify:setup` in that order. Setup is offline, non-elevating, and uses Windows Installer with Lekh's independent upgrade identity. No Electron editor code is loaded into the setup UI. The application executable is `Lekh - Markdown editor.exe`.

The three origin-story chapters type beside a moving quill and advance two seconds after the final text element, looping 1/3, 2/3, 3/3. Previous/Next and Pause/Resume are keyboard-accessible. Windows' animation preference disables typing and autoplay; minimizing or hiding setup stops animation, and completion keeps the current chapter. Complete story text is available through the chapter's accessibility name immediately. Installation is never delayed for the story.

Setup asks you to save and close an already-running installed Lekh. It checks only Lekh's executable at its install path, not another product's processes. It does not terminate processes or restart Windows. Cancellation requests Windows Installer rollback, and setup stays open until the native operation finishes. Stage percentages come from Windows Installer (which may reset or reverse during rollback), not a simulated overall timer. Errors expose native codes and local logs under `%LOCALAPPDATA%\Lekh\SetupLogs`.

A successful installation retains its verified internal MSI under `%LOCALAPPDATA%\Lekh\SetupCache` as Windows Installer's offline repair source. Failed or cancelled attempts remove their extracted payload. This cache is not a second public download; do not remove it while the product is installed if you need offline repair. Windows Settings continues to manage uninstall. Application files are in `%LOCALAPPDATA%\lekh`; the fresh `%APPDATA%\Lekh` preferences/recovery profile and setup logs/cache are separate from Markdown documents. No other product's installation or data is migrated or removed.

The desktop suite launches the application with a Markdown path, then starts real
secondary processes against an isolated profile. It checks startup loading,
one-window tab activation, relative paths with spaces/Unicode, preservation of
unsaved edits, minimized-window restoration, and file requests queued during a
busy Save As operation. It runs against both development and extracted MSI apps.

### Installer validation status and policy restrictions

Local MSI validation can be blocked by Windows system policy (`LGHT1105`), including when run with administrator approval. The hosted workflow runs validation without suppressing ICE checks. Per-user file components use stable HKCU registry key paths, non-advertised shortcuts, and uninstall folder cleanup to satisfy ICE38 and ICE64.

If you encounter this error, use a Windows build environment where your organization's policy permits Windows Installer validation, or ask your administrator for guidance. Do not disable security policy or suppress ICE validation. The included GitHub Actions workflow is another build option, but confirm that packaging and verification both succeed before sharing its artifacts.

The workflow uses Windows PowerShell, matching the npm distribution scripts. Verification and checksum scripts explicitly load their host's Utility module so `Get-FileHash` remains available even when launched from PowerShell 7 with an inherited module search path.

The installer is intentionally per-user only, uses LocalAppData rather than Program Files, creates desktop/Start menu shortcuts, and does not launch the app automatically. Keep `build.appId` (`com.lekh.desktop`) and the independent `build.msi.upgradeCode` (`DCBCF7FA-11DA-4F35-8D27-D066EEC6C582`) stable for future Lekh upgrades. The same GUID is pinned in installer policy, verification scripts, and tests; update all together only when defining a genuinely separate product. The narrowly checked `configure-msi.cjs` hook adjusts the builder's dual-scope template to enforce non-elevated scope and fails if an upstream template changes.

The npm package name is `lekh`. `lib/branding.ts` defines the independent `Lekh` user-data directory for Electron and Chromium storage; `--user-data-dir` overrides both for isolated testing. Renderer storage uses the `lekh-` prefix, the image protocol is `lekh-image`, the diagram partition is `lekh-diagrams`, the preload bridge is `window.lekh`, and table-of-contents markers use `lekh:toc`. No compatibility aliases are provided. Branding uses Windows-installed Segoe UI Light and Nirmala UI, not redistributed font files.

## Screenshots

To regenerate the README screenshots from the actual application with sample documents:

```powershell
$env:LEKH_PUBLIC_SCREENSHOTS = '1'
npm.cmd run test:desktop
Remove-Item Env:\LEKH_PUBLIC_SCREENSHOTS
```

The README and user-guide screenshots are written to `docs\images`. Review the changed images before committing. Only current Lekh screenshots are retained; normal test runs do not overwrite these images.

## Project map

| Location | Role |
| --- | --- |
| `src` | Renderer UI, pane/tab routing, editing, sidebar and toolbar |
| `electron` | Native window, menus, narrow preload bridge, file and export operations |
| `lib` | Markdown helpers, exports, highlighting, themes, tables and pairing model |
| `assets` | Original quill SVG artwork and generated Windows icons |
| `scripts` | Desktop validation, icon generation, MSI configuration/verification and source packaging |
| `installer` | Offline native WPF setup, Windows Installer engine, origin-story state machine, and native self-tests |
| `tests` | Unit and distribution configuration tests |
| `.github/workflows` | Windows CI and downloadable build artifacts; no automatic public release |

Source is TypeScript with strict checking. The preload bridge is intentionally narrow. Keep document save/recovery handling, file/image boundaries, per-tab histories and active-pane routing intact when changing features.

## Signing

This configuration does not code-sign binaries or installers. No certificate, private key, token, or publisher identity is included. Adding signing requires your own certificate/service, a review of the builder configuration, and protected CI secrets. Never commit signing material.
