<img src="assets/icon.svg" width="72" height="72" alt="Lekh quill icon">

# Lekh लेख

**Lekh: Markdown editor** is a calm, local-first Windows Markdown editor with editable **Visual + Source**, paired split tabs, offline Mermaid diagrams, and **HTML, Word and PDF export**.

**Version 0.9.1** adds interactive offline HTML export, direct publishing-block editing, and a simpler, rollback-safe upgrade installer. Offline English grammar checks remain included. Lekh has its own application, installer, and settings identities. No settings, recovery data, or installation identities are imported from another product.

**[Download Lekh 0.9.1 for Windows x64](https://github.com/dennispadia/lekh/releases/tag/v0.9.1)** · [User guide](docs/USER_GUIDE.md)

Each release provides an EXE, source ZIP, and checksums. Earlier published assets remain unchanged.

Free to use and modify under the [MIT license](LICENSE). **[Open a GitHub issue](https://github.com/dennispadia/lekh/issues)** for questions, bugs, enhancements, and requests. See [Help and feedback](SUPPORT.md).

## Writing features

| Area | Included tools |
| --- | --- |
| **Markdown editing** | Headings, bold, italics, strikethrough, lists, tasks, quotes, links, images, rules, and code blocks. Use Visual for formatted writing or Source for exact Markdown and unsupported syntax. |
| **Visual + Source** | Two editable views of one document, with a shared toolbar. Source-only and read-only Source + Preview are also available. |
| **Paired split tabs** | Keep two independent documents side by side; commands target the active document. Resize the divider or unsplit without closing files. |
| **Responsive interface** | One formatting toolbar, More tools and views overflow, shrinking tabs, an Open documents list, and a collapsible sidebar. |
| **Links and tables** | Edit link text/addresses in place, remove links without deleting text, choose table dimensions, and add/remove table rows and columns. |
| **Code and diagrams** | Search the offline language catalog, highlight code, copy raw code, and insert editable Mermaid diagrams at the current selection. Code is displayed, never executed. |
| **Editable alerts** | Add Note, Tip, Important, Caution or Warning from the separate **Alerts** toolbar menu, then type and format directly in Visual. Each type has its own icon, label and matching Light/Dark colors. |
| **Editable publishing blocks** | **Blocks** has tabbed examples, selectors, independently placed variant content, image descriptions and YAML metadata. Edit names, options, fields and rich bodies directly in Visual. Existing include directives remain editable. |
| **Synchronized scrolling** | Visual + Source scroll together in both directions by default. Content anchors account for wrapped Source lines and different rendered block heights. Paired documents remain independent. |
| **Find/Replace** | Match case, Unicode whole words, regex, match counts, navigation, and replacement. |
| **Writing assistance** | Optional offline English grammar checks powered by the bundled Harper engine. Review, apply, ignore, or ignore a suggestion throughout the current document. No text is sent online or changed automatically. |
| **HTML, Word and PDF export** | Export the active document, including unsaved edits, with headings, links, tables, lists, syntax-colored code, supported images and Mermaid diagrams. Interactive tabs and variants require HTML; Word and PDF are available for documents without them. Export does not save the Markdown. |
| **Workspace** | Light/Dark themes, a resizable sidebar, heading outline, five recent files, zoom controls, word count, and Focus mode (F9). |
| **Safeguards** | Unsaved-change prompts, external-edit detection, atomic saves, recovery drafts, Save As, and Save All. Recovery is not a backup. |
| **Keyboard and context menus** | Formatting/file shortcuts, contextual Alerts/Blocks and view tools, nested keyboard-accessible menus, spelling suggestions, and an F1 keyboard reference. |

Switching between Visual and Source resets that tab's undo history; switching tabs preserves it. Source + Preview uses the Source history.

### Richer exports in 0.8.0

- **Explicit typography:** Segoe UI Heading 1–6 sizes, weights, spacing, and colors are defined by Lekh rather than a document consumer's default heading styles. Bold, italic, and strikethrough are preserved; hyperlinks are colored and underlined.
- **Navigation:** Word exports include heading bookmarks and clickable internal heading links, including table-of-contents links. PDFs include document bookmarks and tagged accessibility.
- **Structure:** page-width fixed tables preserve Markdown column alignments and use shaded, repeating header rows. Nested lists retain continuation paragraphs and numbering starts; task lists render checked/unchecked boxes.
- **Code and images:** syntax colors, blank lines, and tabs are preserved in code blocks. Supported images keep their aspect ratio and fit within page bounds.
- **Print layout:** A4 pages with 20 mm margins and readable light print colors, regardless of the editor's Light/Dark theme.

Word output remains editable and reflows in the receiving application; Word and PDF are **not pixel-identical**. Math and footnotes do not have formatted rendering or structured export support. YAML is preserved in the metadata view rather than exported as article text. See [export details and limitations](docs/USER_GUIDE.md#images-and-exports).

### Publication-quality documents

Lekh uses a reader-friendly document hierarchy and renders supported rich blocks consistently in Visual and read-only previews.
Note, Tip, Important, Caution and Warning have distinct light/dark colors. Tabs and document-wide variant selectors are separate controls.
Interactive HTML exports retain every tab and variant in one self-contained file for offline review. Select tabs and variants as in the preview; Word and PDF are unavailable for documents containing these blocks.

**Alerts are directly editable in Visual.** Use normal text formatting, lists, links and code inside them; choose another alert type to change its appearance without losing its contents.
Variant controls live within the document's Visual area or read-only preview, never above the Source column.
Tabbed examples have explicit readable text and surface colors in both themes.

**Every supported publishing block is editable in Visual.** Tab names and every tab body, selector prompts/options, described images and metadata YAML no longer require Edit source. Renamed tab names are also reflected in their `#tab/` identifiers in Source.
Insert a selector once, then use **Blocks > Add variant content** to place content for its existing options anywhere in the document. Inactive content has **Show and edit**, and stable option IDs preserve connections when labels change.
Metadata stays outside the article body and is edited in one YAML field for arbitrary keys and comments. Unsupported or over-depth syntax stays visible and editable in its inline block field.
Local include directives are preserved as inert source and are never opened, expanded, or fetched. Relative local images remain available from the Markdown file's folder; use **More > Allow local image folder...** only when a document needs image assets elsewhere in its project.
Publishing systems can supply additional metadata or build-time configuration; Lekh is not a replacement for their final validation pipeline.

## Screenshots

The following captures show the Lekh interface with sample documents, not personal files.

![Lekh in Light theme](docs/images/lekh-light.png)

![Lekh in Graphite + Teal Dark theme with paired independent documents](docs/images/lekh-dark-split.png)

### Write directly in alerts

![Editable Note, Tip, Important, Caution and Warning alerts in Dark](docs/images/alerts-dark.png)

### Keep publishing controls with the document

![Readable Dark tabs and a selector contained inside Visual beside Source](docs/images/publishing-split-dark.png)

## Install on Windows

Requires **Windows 10/11 x64 and .NET Framework 4.8 or newer**, normally included in Windows. Other operating systems and architectures are not packaged or tested.

Choose the **[Lekh 0.9.1 release](https://github.com/dennispadia/lekh/releases/tag/v0.9.1)** and compare the installer download with its accompanying checksums. The offline EXE includes the application and its grammar engine; recipients do not need to build from source.

For the 0.9.1 installer:

1. Run the setup EXE. A fresh install starts directly. An older, closed installation upgrades automatically, showing the previous and new versions before removing the old payload and installing the new one.
2. If Lekh is open, setup asks you to save and close it. Click **Check again** after closing; no second installation prompt is needed. The same version reports **already installed**, and a newer installed version blocks downgrade.
3. Setup installs only for your current Windows user, without requesting administrator access. Open **Lekh** from the desktop or Start menu afterward.

The offline setup embeds the runtime and internal MSI; recipients do not need Node.js, npm, Word, Pandoc, or an account. Installation does not wait for the accessible, reduced-motion-aware origin story.

### Standalone application identities

- Application ID: `com.lekh.desktop`; npm package: `lekh`.
- Application files: `%LOCALAPPDATA%\lekh`; executable: `Lekh - Markdown editor.exe`.
- Preferences, recent files, Chromium storage, and recovery drafts: `%APPDATA%\Lekh`.
- Setup cache/logs: `%LOCALAPPDATA%\Lekh\SetupCache` and `%LOCALAPPDATA%\Lekh\SetupLogs`.
- MSI upgrade code: `DCBCF7FA-11DA-4F35-8D27-D066EEC6C582`. Keep it stable for future Lekh upgrades.

Lekh uses a standalone profile and installation directory. It does not import another product's drafts or preferences, migrate aliases, or replace/uninstall another product. Saved Markdown files can be opened normally; an existing Lekh profile is retained during a Lekh upgrade. Close Lekh before upgrading; setup asks rather than force-closing the editor.

The [verified 0.9.1 Windows build](https://github.com/dennispadia/lekh/actions/runs/41269204614) tested fresh installation, genuine **0.9.0 -> 0.9.1** idle and running-app upgrades, same-version rejection, cancellation/rollback restoring every old payload byte, repair and profile-preserving uninstall. The old payload is removed before the new one is installed within rollback protection. Earlier releases remain unchanged.

**Unsigned software:** application, setup EXE, and internal MSI are not code-signed. Windows, browser, or organization policies may warn about or block them. Verify checksums and follow your organization's policies; do not disable security protections. See [signing status](docs/PUBLISHING.md#code-signing-policy-pending).

Uninstall through **Windows Settings > Apps > Installed apps**. Your Markdown documents are not installer-managed files. The separate settings/recovery profile is not intentionally deleted on uninstall.

## Start writing

1. Start in blank **Untitled**, open a `.md` file, or choose **New**.
2. Write in **Visual**, or enable **Visual + Source**. Source-only and Source + Preview are under **More (...)** and View.
3. Use **Ctrl+F** to search, **Ctrl+T** for a table, or **F1** for shortcuts.
4. Save Markdown with **Ctrl+S**; the Save arrow provides Save All and Save As.
5. Use **Export** for a separate HTML, Word or PDF document. Choose HTML for documents with tabbed examples or variants.

See the [user guide](docs/USER_GUIDE.md) for recovery, images, shortcuts, and limitations.

## Build and contribute

With Windows x64 and Node.js >=22.15.0 (the workflow uses 22.22.0):

```powershell
npm.cmd ci --registry=https://registry.npmjs.org
npm.cmd run build
.\node_modules\.bin\electron.cmd .
```

Or double-click `Launch.cmd` in a source checkout. If no packaged build exists, its setup script downloads a checksum-verified private Node runtime and builds the app.

See [BUILDING.md](docs/BUILDING.md) for tests and packaging, [PUBLISHING.md](docs/PUBLISHING.md) for release verification, and [CONTRIBUTING.md](CONTRIBUTING.md) for focused changes.

## Boundaries and privacy

Documents stay on your computer. There are no accounts, document uploads, cloud sync, or analytics. Remote images are not downloaded; opening an external web/email link requires confirmation and uses another application. Developer setup downloads tools and dependencies, not your documents.

Visual editing may normalize Markdown; use Source for unsupported syntax. Math rendering, automatic updates, cloud sync, and custom export templates are not included. Keep backups: recovery is not a backup.
