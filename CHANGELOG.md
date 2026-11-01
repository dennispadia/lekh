# Changelog

## 0.9.1

- Remove Local include from the block insertion menus; existing include directives and their explicit access controls continue to work.
- Add self-contained interactive HTML export for offline review, with keyboard-accessible tabs, document-wide variants, embedded images and diagrams, and an all-alternatives fallback when JavaScript is disabled. Documents containing tabs or variants, including through authorized includes, require HTML instead of Word/PDF.
- Follow links into nested tabs and variants, keep duplicate tab IDs independently editable, and export JPEG images that contain valid marker padding.
- Reject stale project-folder grants during include-backed exports, including when the same folder is allowed again.
- Make variant content a follow-on action on its selector, rather than an independent block option. After creating a selector, the same Blocks/native/right-click menu entry adds its content at the current selection.
- Correct variant-dialog checkbox sizing and adjacent labels.
- Edit example names on their tabs, with inline **+** and per-tab **×** controls and immediate typing in added examples. Rename variant choices in place, remove duplicate name forms, and simplify metadata, block titles, include fields and image captions into direct editing surfaces with secondary settings tucked away.
- Keep Alerts and publishing-block icons next to their names on the left of right-click submenu rows; reserve right alignment for shortcuts and submenu arrows. Add measured Light/Dark menu layout regressions.
- Start fresh installations and upgrades of a closed older Lekh automatically, without an extra Install or save/close prompt. Show the previous and target versions during upgrade preparation.
- Prompt to save and close only when the installed editor is running; one **Check again** after closing proceeds directly to removal and installation.
- Report **already installed** for the same version, even when the editor is open, without offering reinstall. Continue to block downgrades.
- Retain transactional removal-before-new-payload, cancellation rollback, profile preservation and native completion checks. Add native startup/retry regressions and a guarded genuine 0.9.0 -> 0.9.1 hosted EXE matrix for idle/running upgrades and same-version rejection.

## 0.9.0

- Make supported tabs, selector prompts/options, distributed variant content, structured steps, image descriptions, metadata and include fields editable directly in Visual, with source-safe serialization and undo/redo.
- Split **Alerts** and **Blocks** into separate toolbar and contextual Insert menus. Insert selectors independently; gate **Variant content** on existing choices and allow placement anywhere with stable option assignments.
- Preserve inactive alternatives as **Show and edit** cards; retain every tab/variant in Word and PDF. Keep unknown syntax editable inline without forcing Source.
- Open authorized shared Markdown as its own Visual document, preserving per-document grants, bounded UTF-8 reads and parent directives. Refresh authorized previews after explicit saves.
- Synchronize Visual + Source scrolling by default in both directions using document anchors and measured wrapped lines; keep paired documents isolated.
- Fix nested right-click flyout ancestry/placement, match toolbar icons/help, and include view/writing tools.
- Detect previous Lekh registration before installation, show version/save-close guidance, visibly remove the old payload before installing the new one inside a rollback-safe Windows Installer transaction. Preserve repair, downgrade safeguards and user profiles.
- Add exact-source, reference, metadata, export, native editing/shortcut/scroll/menu tests and genuine hosted 0.8.1 -> 0.9.0 removal/cancellation-rollback/upgrade/repair validation.

Published as **[Lekh 0.9.0](https://github.com/dennispadia/lekh/releases/tag/v0.9.0)** with independently verified Windows EXE, source ZIP and checksums. The [official build](https://github.com/dennispadia/lekh/actions/runs/41245290389) passed real fresh installation and genuine 0.8.1 -> 0.9.0 removal-before-new, cancellation restoring the entire old payload, upgrade, repair and profile-preserving uninstall. Earlier published assets remain unchanged.

## 0.8.1

- Make all five alert types directly editable in Visual, including rich body content, type changes, natural paragraph entry/exit and undo/redo. Preserve unchanged source syntax and safely serialize edits.
- Refine alerts with GitHub/Learn-like leading borders, semantic icons, readable labels and theme-aware surfaces.
- Group Note, Tip, Important, Caution and Warning under **Alerts**. Add icons and descriptive help to all other Blocks tools.
- Keep variant controls inside their document's Visual or read-only Preview surface instead of spanning Visual + Source.
- Fix Dark tab-header and unresolved-content contrast; verify at least 4.5:1 for normal text in both themes.
- Update feature documentation and application screenshots. Welcome questions, bugs and enhancement requests through GitHub issues.
- Add guarded hosted validation for a genuine 0.8.0 upgrade and repair, with profile and installed-payload checks before publishing.

Published as **[Lekh 0.8.1](https://github.com/dennispadia/lekh/releases/tag/v0.8.1)** with independently verified offline Windows EXE, source ZIP and checksums. Fresh installation and the genuine 0.8.0 -> 0.8.1 upgrade, repair and profile-preserving uninstall passed the official Windows build. Earlier published assets remain unchanged.

## 0.8.0

- Add universal publication-quality rendering with protected, source-preserving blocks, collapsed metadata, colored callouts, tabbed examples, document-wide variant selectors, structured steps, and described image directives. No platform-specific editor mode is required.
- Add **Blocks** toolbar shortcuts and matching Insert-menu commands. Formatting selected content into a callout, tab or variant preserves that content.
- Resolve bounded local includes only after a per-document project-folder grant; support explicit revocation. Keep all alternatives in static Word/PDF exports and visibly identify unsupported or unresolved directives.

- Add opt-in, on-device English grammar and punctuation checking with the bundled Harper engine. Review suggestions in Visual and Source, apply an undoable correction, or ignore it once or throughout the current document. Code, protected syntax, stale results and other tabs are guarded; no text is sent online.

- Establish independent Lekh application (`com.lekh.desktop`), npm (`lekh`), installer, and `%APPDATA%\Lekh` profile identities. No migration aliases or automatic removal of another product are included.
- Use a new stable MSI upgrade code, `DCBCF7FA-11DA-4F35-8D27-D066EEC6C582`, for future Lekh upgrades, with application files under `%LOCALAPPDATA%\lekh`.
- Use Lekh-only renderer storage keys, image protocol, diagram partition, preload bridge, and table-of-contents markers.
- Define explicit Segoe UI Heading 1–6 typography rather than relying on document-consumer defaults. Preserve bold, italic, strikethrough, and colored, underlined hyperlinks in DOCX/PDF exports.
- Add Word heading bookmarks and clickable internal heading/table-of-contents links; generate PDF document bookmarks and tagged accessibility.
- Export page-width fixed tables with Markdown column alignments, shaded repeating header rows, nested-list continuation paragraphs and numbering starts, and rendered task boxes.
- Preserve code syntax colors, blank lines, and tabs; constrain images to page bounds while preserving aspect ratio. Use A4 pages, 20 mm margins, and readable light print colors independently of the editor theme.
- Keep Word documents editable: Word reflow can differ from PDF pagination and is not pixel-identical. Math and footnotes remain without formatted rendering or structured export support; YAML is preserved as metadata rather than article text.
- Start with a fresh standalone profile and installation directory. Existing drafts/preferences are not automatically imported; saved Markdown files can be opened normally.
- Invite GitHub issues for bugs, enhancements, and requests. Preserve the MIT license.
- Update first-party attribution and current documentation; remove obsolete screenshots and compatibility narratives.

Published as **[Lekh 0.8.0](https://github.com/dennispadia/lekh/releases/tag/v0.8.0)** with an offline Windows EXE, matching source ZIP and checksums. The release includes the grammar engine and publishing improvements above; earlier published assets remain unchanged.
