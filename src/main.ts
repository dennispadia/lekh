import { Editor, getMarkRange, mergeAttributes } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from '@tiptap/markdown';
import { documentPreviewHTML, escapeHTML, headingAnchor, headings, imageDisplayURL, isSafeLink, parser, requiresInteractiveExport, topLevelBlocks, wordCount } from '../lib/markdown.js';
import { replaceSearchMatches, type SearchMatch, type SearchResult } from '../lib/search.js';
import { hasMarkedTableOfContents, tableOfContents, updateTableOfContents } from '../lib/contents.js';
import type { Result, SharedVariantGroup } from './bridge.js';
import { isTheme, restoreTheme, themes, type Theme } from '../lib/themes.js';
import { createPair, DEFAULT_SIDEBAR_WIDTH, groupTabs, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, pairFor, sidebarWidth, splitRatio, type SplitPair } from '../lib/workspace.js';
import { formattingShortcuts } from '../lib/shortcuts.js';
import { canMoveSection, relocateSection, sectionEndIndex, siblingTarget } from '../lib/outline.js';
import { commandEntries, slashEntries, type CommandEntry } from '../lib/commands.js';
import { CommandPalette, SlashMenu } from './command-palette.js';
import { Fragment } from '@tiptap/pm/model';
import { NodeSelection, Selection } from '@tiptap/pm/state';
import { productName } from '../lib/branding.js';
import { MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, tableMarkdown, validateTableSize } from '../lib/tables.js';
import { syntaxCSS } from '../lib/highlight.js';
import { LanguageCodeBlock } from './code-block.js';
import { ContentsNode } from './contents-node.js';
import { renderMermaidBlocks } from './diagrams.js';
import { ContextMenu } from './context-menu.js';
import { GrammarHighlights } from './grammar-highlights.js';
import { WritingAssistance } from './writing-assistance.js';
import { LearnChecksPanel } from './learn-checks-panel.js';
import { PublishingHeadings, PublishingNode, setPublishingHeadings } from './publishing-node.js';
import { prepareVariantInsertion, selectInsertedVariant, validateSourceVariantInsertion, variantInsertionPosition } from './publishing-insert.js';
import { choosePublishingVariant, forgetPublishingDocument, initializePublishing, projectVariantOptions, publishingHTML, refreshPublishingVariants, revealPublishingElement, setProjectVariantLabels } from './publishing-view.js';
import { editablePublishingBlockAtStart, hasInteractivePublishing, includeMarkdown, interactiveExportMessage, publishingBlockRanges, publishingCSS } from '../lib/publishing.js';
import { publishingTemplateMarkdown, publishingTemplates, variantInsertionTemplate } from '../lib/publishing-templates.js';
import { publishingIcon } from '../lib/publishing-icons.js';
import { AlertNode } from './alert-node.js';
import { EditablePublishing, documentVariantOptions, setPublishingEditable } from './editable-publishing.js';
import { EditorHints } from './editor-hints.js';
import { synchronizeDocumentScroll } from './synchronized-scroll.js';
import './style.css';

let writingAssistance: WritingAssistance | undefined;
let learnPanel: LearnChecksPanel | undefined;
let slashMenu: SlashMenu | undefined;
let slashDismissed = '';
const syntaxStyle = document.createElement('style');
syntaxStyle.textContent = [
  syntaxCSS('.tiptap'),
  syntaxCSS(':root[data-theme="dark"] .tiptap', true),
  syntaxCSS('.document-preview'),
  syntaxCSS(':root[data-theme="dark"] .document-preview', true),
].join('\n');
document.head.append(syntaxStyle);
const publishingStyle = document.createElement('style');
publishingStyle.textContent = publishingCSS;
document.head.append(publishingStyle);

const icons = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 8V5h7l2 3h9v12H3Z"/>',
  save: '<path d="M4 3h14l3 3v15H3V3z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>',
  export: '<path d="M12 3v12M8 7l4-4 4 4M4 14v6h16v-6"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  moon: '<path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10z"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  menu: '<path d="M5 7h14M5 12h14M5 17h14"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1m4 0h1m4 0h1M6 12h1m4 0h1m4 0h1M7 16h10"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  link: '<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 0) scale(.85)"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M3 9h18M3 14h18M9 4v16M15 4v16"/>',
  undo: '<path d="M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14"/>',
  redo: '<path d="m16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 5M12 17v.1"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  bold: '<path d="M7 4v16h6a4 4 0 0 0 0-8H7m0-8h5a4 4 0 0 1 0 8"/>',
  italic: '<path d="M10 4h8M6 20h8M14 4l-4 16"/>',
  strike: '<path d="M17 7c-1-4-10-4-10 1 0 3 10 4 10 8 0 5-10 5-11 0M3 12h18"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16"/>',
  bullet: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r=".7"/><circle cx="4" cy="12" r=".7"/><circle cx="4" cy="18" r=".7"/>',
  ordered: '<path d="M10 6h11M10 12h11M10 18h11M3 4l2-1v6M3 9h4M3 15c0-3 5-3 4 0l-4 5h4"/>',
  task: '<rect x="3" y="4" width="18" height="16" rx="4"/><path d="m7 12 3 3 7-7"/>',
  quote: '<path d="M4 13h5V6H3v8c0 3 2 4 4 4m9-5h5V6h-6v8c0 3 2 4 4 4"/>',
  codeblock: '<rect x="2" y="3" width="20" height="18" rx="4"/><path d="m9 9-3 3 3 3m6-6 3 3-3 3"/>',
  rule: '<path d="M3 12h18"/>',
  cut: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 12 12M8 16 20 4"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H4v18h16V4h-4"/>',
  delete: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  contents: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  diagram: '<rect x="8" y="2" width="8" height="5" rx="1"/><rect x="2" y="17" width="7" height="5" rx="1"/><rect x="15" y="17" width="7" height="5" rx="1"/><path d="M12 7v5H5v5m7-5h7v5"/>',
  blocks: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="8" height="7" rx="2"/><rect x="15" y="14" width="6" height="7" rx="2"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  learn: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v2h6V3M8.5 12l2 2 4-4M9 17h6"/>',
  command: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m7 10 3 2-3 2M12 15h5"/>',
  html: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 13l-2 2 2 2m6-4 2 2-2 2"/>',
  word: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 11l1.5 6 1.5-4 1.5 4 1.5-6"/>',
  pdf: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 17v-5h2a1.5 1.5 0 0 1 0 3H9"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};
type Icon = keyof typeof icons;
const icon = (name: Icon) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const button = (action: string, label: string, name?: Icon, className = '') => `<button type="button" data-action="${action}" class="${className}" title="${label}">${name ? icon(name) : ''}<span>${label}</span></button>`;
const formatButton = (command: Icon, label: string) => `<button type="button" data-command="${command}" title="${label}" aria-label="${label}">${icon(command)}<span>${label}</span></button>`;
const group = (id: string, caption: string, controls: string, className = '') => `<div class="toolbar-group ${className}" data-group="${id}" role="group" aria-label="${caption}"><div class="group-controls">${controls}</div><span class="group-caption" aria-hidden="true">${caption}</span></div>`;
const menuItem = (attributes: string, iconHTML: string, label: string, description: string) =>
  `<button type="button" ${attributes} title="${escapeHTML(description)}" aria-description="${escapeHTML(description)}">${iconHTML}<span>${label}</span><small aria-hidden="true">${escapeHTML(description)}</small></button>`;
const exportItem = (format: 'html' | 'docx' | 'pdf', iconHTML: string, label: string, description: string) =>
  menuItem(`data-action="export-${format}"`, iconHTML, label, description).replace('</button>', `<span class="export-preview export-preview-${format}" aria-hidden="true"><i></i><i></i><i></i></span></button>`);
const templateItem = (id: string) => {
  const item = publishingTemplates.find(entry => entry.id === id)!;
  return menuItem(`data-action="insert:${item.id}" class="publishing-menu-${item.color || 'generic'}"`, publishingIcon(item.icon), item.label, item.description);
};
const structureMenuHTML = `<div class="menu-section" role="presentation">Structure</div>
  ${menuItem('data-action="insert:toc"', icon('contents'), 'Table of contents', 'Insert a linked table of contents, or refresh the existing one.')}
  ${menuItem('data-action="insert:mermaid"', icon('diagram'), 'Mermaid diagram', 'Flowcharts, sequence and other diagrams written as text.')}
  ${menuItem('data-command="rule"', icon('rule'), 'Horizontal rule', 'Divide sections with a horizontal line.')}
  ${templateItem('publishing-metadata')}${templateItem('publishing-image')}${templateItem('publishing-include')}`;
const interactiveMenuHTML = `<div class="menu-section" role="presentation">Interactive \u00b7 HTML export only</div>
  ${templateItem('publishing-tabs')}${templateItem('publishing-selector')}`;
const app = document.querySelector<HTMLDivElement>('#app')!;
const brandIcon = new URL('../assets/icon.svg', import.meta.url).href;
const brandDarkIcon = new URL('../assets/icon-dark.svg', import.meta.url).href;
app.innerHTML = `
  <aside class="sidebar" id="sidebar">
    <button type="button" id="sidebar-toggle" data-action="sidebar" aria-controls="sidebar" aria-expanded="true" aria-label="Collapse sidebar" title="Collapse sidebar (Ctrl+Shift+B)">${icon('menu')}</button>
    <div class="brand"><div class="brand-mark"><img id="brand-icon" src="${brandIcon}" alt="" /></div><div class="brand-text"><div class="brand-name"><span class="latin-name">${productName}</span><span class="devanagari" lang="sa">लेख</span></div><span class="brand-descriptor">Markdown editor</span></div></div>
    <div class="file-actions">${button('new', 'New', 'plus', 'new-button')}${button('open', 'Open', 'folder', 'sidebar-button')}</div>
    <section class="outline-section"><div class="section-label">IN THIS DOCUMENT</div><nav id="outline" aria-label="Document headings"></nav></section>
    <section class="recent-section"><div class="recent-header"><button id="recent-toggle" aria-expanded="false" aria-controls="recent" title="Expand recent files">${icon('chevron')}<span>RECENT FILES</span><span id="recent-count">(0)</span></button><button id="clear-recent" data-action="clear-recent" title="Clear recent file history" hidden disabled>Clear</button></div><div id="recent" hidden><p class="empty-note">Your opened files will appear here.</p></div></section>
    <div class="sidebar-bottom">
      <button type="button" id="theme-toggle" data-action="theme" title="Switch to dark theme" aria-label="Switch to dark theme">${icon('moon')}<span>Light</span></button>
      <button type="button" data-action="shortcuts" class="icon-only" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (F1)">${icon('keyboard')}</button>
    </div>
    <div id="sidebar-resizer" role="separator" tabindex="0" aria-label="Resize sidebar" aria-controls="sidebar" aria-orientation="vertical" title="Drag to resize; Left/Right keys resize, Home/End set limits; double-click to reset"></div>
  </aside>
  <main>
    <header class="tabs-bar">
      <button type="button" data-action="tabs-menu" class="icon-only" aria-label="Open documents" title="Open documents" aria-haspopup="menu" aria-controls="tabs-menu" aria-expanded="false">${icon('chevron')}</button>
      <div id="tabs" role="tablist" aria-label="Open documents"></div>${button('new', 'New tab', 'plus', 'icon-only')}
      <div class="document-name sr-only"><span id="filename">Untitled.md</span><span id="dirty-indicator"></span></div>
      <div class="workspace-actions">
        <button type="button" data-action="command-palette" class="command-search" title="Search all commands (Ctrl+Shift+P)" aria-label="Search commands" aria-keyshortcuts="Control+Shift+P">${icon('search')}<span>Search commands\u2026</span><kbd>Ctrl+Shift+P</kbd></button>
        ${button('find', 'Find and replace', 'search', 'icon-only quiet')}
        <div class="save-control"><div class="save-button">${button('save', 'Save', 'save')}<button type="button" data-action="save-menu" aria-label="More save actions" title="More save actions" aria-haspopup="menu" aria-controls="save-menu" aria-expanded="false">${icon('chevron')}</button></div><div id="save-menu" class="dropdown" role="menu" hidden><button type="button" data-action="save-all" role="menuitem">Save all files<kbd>Ctrl+Alt+S</kbd></button><button type="button" data-action="save-as" role="menuitem">Save as...<kbd>Ctrl+Shift+S</kbd></button></div></div>
        <div class="export-control"><button type="button" data-action="export-menu" class="primary" title="Export as HTML, Word, or PDF" aria-haspopup="menu" aria-controls="export-menu" aria-expanded="false"><span>Export</span></button><div id="export-menu" class="dropdown export-cards" role="menu" aria-labelledby="export-menu-title" hidden><div class="menu-section" id="export-menu-title" role="presentation">Export document</div>${exportItem('html', icon('html'), 'Interactive HTML (.html)', 'Clickable tabs and variants, like Microsoft Learn. Works offline.')}${exportItem('docx', icon('word'), 'Word document (.docx)', 'Editable document for Microsoft Word.')}${exportItem('pdf', icon('pdf'), 'PDF document (.pdf)', 'Print-ready pages.')}<p id="export-restriction" role="status" aria-live="polite" hidden>Tabbed examples and variants require HTML. Word and PDF are not supported for this document.</p></div></div>
      </div>
    </header>
    <div class="toolbar" role="toolbar" aria-label="Text formatting">
      ${group('view', 'View', `<div class="global-modes" role="group" aria-label="Editing view"><button type="button" id="view-visual" data-action="visual" aria-pressed="true" aria-controls="canvas" title="Edit in Visual"><span>Visual</span></button><button type="button" id="view-markdown" data-action="source" aria-pressed="false" aria-controls="canvas" title="Edit Markdown"><span>Markdown</span></button><button type="button" id="view-split" data-action="edit-split" aria-pressed="false" aria-controls="canvas" title="Edit Visual and Markdown side by side"><span>Split</span></button></div><button type="button" id="preview-toggle" data-action="preview" aria-pressed="false" aria-controls="canvas" title="Open reader preview"><span>Preview</span></button>`)}
      ${group('style', 'Style', `<select id="heading" aria-label="Paragraph style" title="Paragraph style (Ctrl+0 to Ctrl+6)"><option value="0">Paragraph</option><option value="1">Heading 1</option><option value="2">Heading 2</option><option value="3">Heading 3</option><option value="4">Heading 4</option><option value="5">Heading 5</option><option value="6">Heading 6</option></select>`)}
      ${group('text', 'Text', `${formatButton('bold', 'Bold')}${formatButton('italic', 'Italic')}${formatButton('strike', 'Strikethrough')}${formatButton('code', 'Inline code')}${button('link', 'Insert / edit link', 'link', 'icon-only')}`)}
      ${group('paragraph', 'Paragraph', `${formatButton('bullet', 'Bullet list')}${formatButton('ordered', 'Numbered list')}${formatButton('task', 'Task list')}${formatButton('quote', 'Block quote')}`)}
      ${group('insert', 'Insert', `${group('insert-extra', 'Insert', `<button type="button" data-action="image" title="Insert image (Ctrl+Shift+I)" aria-label="Insert image">${icon('image')}<span>Image</span></button><button type="button" data-action="table" title="Insert table (Ctrl+T)" aria-label="Insert table">${icon('table')}<span>Table</span></button><button type="button" data-command="codeblock" title="Code block (Ctrl+Shift+K)" aria-label="Code block">${icon('codeblock')}<span>Code</span></button><button type="button" data-action="alerts-menu" aria-label="Insert alert" title="Note, Tip, Important, Caution and Warning" aria-haspopup="menu" aria-controls="alerts-menu" aria-expanded="false">${publishingIcon('note')}<span>Alerts</span>${icon('chevron')}</button>`, 'labelled toolbar-insert-extra')}<button type="button" data-action="structure-menu" aria-label="Insert structure" title="Table of contents, diagrams, metadata and image descriptions" aria-haspopup="menu" aria-controls="structure-menu" aria-expanded="false">${icon('contents')}<span>Structure</span>${icon('chevron')}</button><button type="button" data-action="interactive-menu" aria-label="Insert interactive content" title="Tabbed examples and variants (HTML export only)" aria-haspopup="menu" aria-controls="interactive-menu" aria-expanded="false">${publishingIcon('tabs')}<span>Interactive</span>${icon('chevron')}</button>`, 'labelled')}
      <div class="toolbar-more"><button type="button" data-action="format-menu" aria-label="More tools and views" title="More tools and views" aria-haspopup="menu" aria-controls="format-menu" aria-expanded="false">${icon('more')}</button></div>
      <span class="toolbar-spacer"></span>
      ${group('review', 'Review', `<button type="button" data-action="learn-checks" class="learn-control" aria-controls="learn-panel" aria-expanded="false" aria-pressed="false" aria-label="Learn checks" title="Learn checks: Microsoft Learn publishing suggestions">${icon('learn')}<span>Learn checks</span><b class="learn-badge" aria-hidden="true" hidden>0</b></button><button type="button" data-action="writing-assistance" class="icon-only grammar-control" aria-label="Writing assistance" title="Writing assistance: offline grammar checks">${icon('check')}<span>Writing assistance</span></button>${button('undo', 'Undo', 'undo', 'icon-only')}${button('redo', 'Redo', 'redo', 'icon-only')}`)}
    </div>
    <div id="view-hint" class="view-hint"><span id="view-hint-text"><strong>Visual:</strong> Edit the document as it appears.</span><label id="preview-source-option" hidden><input id="preview-source" type="checkbox" />Show Markdown beside preview</label></div>
    <div id="table-tools" hidden><span>TABLE</span>${button('row', '+ Row')}${button('column', '+ Column')}${button('delete-row', 'Remove row')}${button('delete-column', 'Remove column')}${button('delete-table', 'Remove table')}</div>
    <section id="find-panel" hidden aria-label="Find and replace">
      <input id="find-text" aria-label="Find text" placeholder="Find Markdown text" />
      <input id="replace-text" aria-label="Replacement text" placeholder="Replace with" />
      <label><input id="find-case" type="checkbox" checked />Match case</label><label><input id="find-word" type="checkbox" />Whole word</label><label><input id="find-regex" type="checkbox" />Regex</label>
      ${button('find-previous', 'Previous')}${button('find-next', 'Find next')}${button('replace-one', 'Replace')}${button('replace-all', 'Replace all')}<span id="find-result" role="status"></span>${button('find-close', 'Close')}
    </section>
    <div id="recovery-banner" hidden>Unsaved drafts from your last session are available. ${button('recover', 'Recover drafts')}${button('dismiss-recovery', 'Dismiss')}</div>
    <div class="canvas" id="canvas"><article class="paper" id="visual-editor" aria-label="Visual Markdown editor"></article><textarea id="source-editor" aria-label="Markdown source" spellcheck="false" hidden></textarea></div>
    <section id="learn-panel" hidden aria-labelledby="learn-title">
      <div class="learn-header"><strong id="learn-title">Learn checks</strong><span id="learn-status" role="status" aria-live="polite"></span><button type="button" id="learn-check">Check again</button><button type="button" id="learn-close" aria-label="Close Learn checks">Close</button></div>
      <p class="learn-note">Microsoft Learn publishing suggestions: alt text, local image and include paths, metadata, and publishing blocks. Checks run on this device and never change your text.</p>
      <ul id="learn-issues" aria-label="Learn check results"></ul>
    </section>
    <section id="writing-panel" hidden aria-labelledby="writing-title">
      <div class="writing-header"><strong id="writing-title">Writing assistance</strong><label><input id="writing-enabled" type="checkbox" />Enable offline English grammar checks</label><button type="button" id="writing-check">Check again</button><button type="button" id="writing-close" aria-label="Close writing assistance">Close</button></div>
      <p class="writing-note">Powered by Harper, entirely on this device. Suggestions never change your text unless you apply them. English only; suggestions may be imperfect.</p>
      <p id="writing-status" role="status" aria-live="polite"></p><ul id="writing-suggestions" aria-label="Grammar suggestions"></ul>
    </section>
    <footer><button type="button" id="word-count" class="status-button" data-action="document-stats" title="Show document statistics">0 words</button><span id="cursor-position" hidden></span><span class="local-status">Local only</span><button type="button" id="writing-toggle" data-action="writing-assistance" aria-controls="writing-panel" aria-expanded="false" title="Offline English grammar checking">Writing assistance</button><button type="button" id="save-status" class="status-button" data-action="save" aria-live="polite" title="Save (Ctrl+S)">Ready to write</button><div class="zoom-controls" role="group" aria-label="Zoom controls"><button type="button" id="zoom-out" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">−</button><button type="button" id="zoom-reset" data-action="zoom-reset" aria-label="Reset zoom to 100%" title="Reset zoom to 100%">100%</button><button type="button" id="zoom-in" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">+</button></div></footer>
  </main>
  <div id="tabs-menu" class="dropdown view-menu" role="menu" aria-label="Open documents" hidden></div>
  ${`<div id="alerts-menu" class="dropdown view-menu publishing-insert-menu" role="menu" aria-label="Alerts" hidden>${publishingTemplates.filter(item => item.category === 'alerts').map(item => templateItem(item.id)).join('')}</div>`}
  <div id="structure-menu" class="dropdown view-menu publishing-insert-menu" role="menu" aria-label="Structure" hidden>${structureMenuHTML}</div>
  <div id="interactive-menu" class="dropdown view-menu publishing-insert-menu" role="menu" aria-label="Interactive" hidden>${interactiveMenuHTML}</div>
  <div id="format-menu" class="dropdown view-menu" role="menu" hidden><div id="toolbar-overflow" role="group" aria-label="More editing tools" hidden></div>${button('split', 'Split with another file...', 'split', 'split-control')}${button('writing-assistance', 'Writing assistance')}${button('learn-checks', 'Learn checks')}${button('help', 'Getting started', 'help')}</div>
  <div id="notification" role="status" hidden></div>
  <dialog id="publishing-include-dialog" aria-labelledby="publishing-include-title"><form method="dialog">
    <h2 id="publishing-include-title">Insert include</h2>
    <label>Title<input id="publishing-include-name" required pattern=".*\\S.*" title="Enter a nonblank title." /></label>
    <label>File path<input id="publishing-include-path" required pattern=".*\\S.*" title="Enter a nonblank file path." placeholder="../includes/shared.md" spellcheck="false" /></label>
    <p>The directive stays in Markdown. Local included content appears in Visual and exports without its document metadata.</p>
    <pre id="publishing-include-preview" aria-live="polite">[!INCLUDE [&lt;title&gt;](&lt;filepath&gt;)]</pre>
    <div class="dialog-actions"><button value="insert" class="primary">Insert include</button><button value="cancel" formnovalidate>Cancel</button></div>
  </form></dialog>
  <dialog id="publishing-image-dialog" aria-labelledby="publishing-image-title"><form method="dialog">
    <h2 id="publishing-image-title">Describe this image</h2>
    <label>Alternate text<input id="publishing-image-alt" required placeholder="Describe the information conveyed by the image" /></label>
    <label>Long description (optional)<textarea id="publishing-image-description" rows="4" placeholder="Explain a diagram or other complex image"></textarea></label>
    <div class="dialog-actions"><button value="insert" class="primary">Insert image</button><button value="cancel" formnovalidate>Cancel</button></div>
  </form></dialog>
  <dialog id="variant-content-dialog" aria-labelledby="variant-content-title"><form method="dialog">
    <h2 id="variant-content-title">Place variant content here</h2>
    <p>Choose which existing options this content applies to. It can be placed anywhere in the document, separately from its selector.</p>
    <fieldset id="variant-content-options"><legend>Applies to</legend></fieldset>
    <div class="dialog-actions"><button value="insert" class="primary">Insert content</button><button value="cancel">Cancel</button></div>
  </form></dialog>
  <dialog id="variant-storage-dialog" aria-labelledby="variant-storage-title"><form method="dialog">
    <h2 id="variant-storage-title">Add a variant selector</h2>
    <p>Choose where the selector choices are stored.</p>
    <div class="dialog-actions variant-storage-actions">
      <button value="local" class="primary">Locally in the document</button>
      <button value="shared">In a shared file</button>
      <button value="cancel" formnovalidate>Cancel</button>
    </div>
  </form></dialog>
  <dialog id="shared-variant-details-dialog" aria-labelledby="shared-variant-details-title"><form method="dialog" id="shared-variant-details-form">
    <h2 id="shared-variant-details-title">Create the entry</h2>
    <p id="shared-variant-file-label"></p>
    <label>Owner<input id="shared-variant-owner" required maxlength="39" pattern="[A-Za-z0-9-]{1,39}" title="Use 1–39 letters, numbers, or hyphens." /></label>
    <label>Group ID<input id="shared-variant-id" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" title="Start with a letter or number; use letters, numbers, hyphens, or underscores." /></label>
    <label>Group name<input id="shared-variant-title" required maxlength="512" /></label>
    <label>Selection title<input id="shared-variant-prompt" required maxlength="512" /></label>
    <fieldset id="shared-variant-pivots"><legend>Choices</legend></fieldset>
    <button id="shared-variant-add-choice" type="button">+ Add choice</button>
    <div class="dialog-actions"><button value="review" class="primary">Review changes</button><button value="cancel" formnovalidate>Cancel</button></div>
  </form></dialog>
  <dialog id="shared-variant-review-dialog" aria-labelledby="shared-variant-review-title"><form method="dialog">
    <h2 id="shared-variant-review-title">Review changes</h2>
    <p id="shared-variant-review-file"></p>
    <pre id="shared-variant-review-entry"></pre>
    <p id="shared-variant-review-metadata"></p>
    <div class="dialog-actions"><button value="confirm" class="primary">Create entry and add selector</button><button value="cancel" formnovalidate>Cancel</button></div>
  </form></dialog>
  <dialog id="image-storage-dialog" aria-labelledby="image-storage-title"><form method="dialog">
    <h2 id="image-storage-title">Store this image</h2>
    <label><input type="radio" name="image-storage" value="embedded" checked />Embed in document (portable, larger Markdown file)</label>
    <label><input type="radio" name="image-storage" value="assets" />Save in this document's assets folder</label>
    <p id="image-storage-note">Save the document first to use an assets folder. Keep the folder with the document when sharing or moving it.</p>
    <div class="dialog-actions"><button value="cancel">Cancel</button><button value="insert" class="primary">Insert image</button></div>
  </form></dialog>
  <dialog id="link-dialog" aria-labelledby="link-title"><form method="dialog">
    <h2 id="link-title">Add a link</h2>
    <label>Link text<input id="link-label" required /></label>
    <label>Link address<input id="link-url" inputmode="url" placeholder="https://example.com" required /></label>
    <p>Click a link to edit it. Ctrl+click opens it. Generated table-of-contents links navigate to their headings.</p>
    <p id="link-error" role="alert" hidden></p>
    <div class="dialog-actions"><button id="link-submit" value="insert" class="primary">Insert link</button><button value="cancel" formnovalidate>Cancel</button><button id="link-remove" value="remove" formnovalidate hidden>Remove link</button></div>
  </form></dialog>
  <dialog id="table-dialog" aria-labelledby="table-title"><form method="dialog" id="table-form">
    <h2 id="table-title">Insert table</h2>
    <div class="table-dimensions"><label>Columns<input id="table-columns" type="number" min="1" max="${MAX_TABLE_COLUMNS}" step="1" value="3" required autofocus /></label><label>Rows<input id="table-rows" type="number" min="1" max="${MAX_TABLE_ROWS}" step="1" value="4" required /></label></div>
    <p>Rows include the header. Up to ${MAX_TABLE_ROWS} rows and ${MAX_TABLE_COLUMNS} columns.</p>
    <p id="table-error" role="alert" hidden></p>
    <div class="dialog-actions"><button id="table-cancel" type="button" value="cancel">Cancel</button><button value="insert" class="primary">Insert table</button></div>
  </form></dialog>
  <dialog id="split-dialog" aria-labelledby="split-title"><form method="dialog" id="split-form">
    <h2 id="split-title">Split with another file</h2>
    <p id="split-description"></p>
    <div id="split-documents" role="group" aria-label="Other open documents"></div>
    <p>These two files become one paired tab. Your other tabs stay independent.</p>
    <p id="split-error" role="alert" hidden></p>
    <div class="dialog-actions"><button id="split-cancel" type="button">Cancel</button></div>
  </form></dialog>
  <div id="tab-context-menu" popover="auto" role="menu" aria-label="Tab actions"></div>
  <dialog id="shortcuts-dialog" aria-labelledby="shortcuts-title">
    <h2 id="shortcuts-title">Keyboard shortcuts</h2>
    <p>Formatting works in Visual and Markdown views, in the active side of a split. Shortcuts do not format your document while you type in Find, dialogs, or the language picker.</p>
    <table class="shortcut-table"><tbody>
      ${formattingShortcuts.map(item => `<tr><th scope="row">${item.label}</th><td><kbd>${item.accelerator.replace('CmdOrCtrl', 'Ctrl')}</kbd></td></tr>`).join('')}
      <tr><th scope="row">Paragraph / Headings 1-6</th><td><kbd>Ctrl+0 / Ctrl+1-6</kbd></td></tr>
      <tr><th scope="row">Insert / edit link</th><td><kbd>Ctrl+K</kbd></td></tr>
      <tr><th scope="row">Open link</th><td><kbd>Ctrl+click</kbd></td></tr>
      <tr><th scope="row">Insert image</th><td><kbd>Ctrl+Shift+I</kbd></td></tr>
      <tr><th scope="row">Insert table</th><td><kbd>Ctrl+T</kbd></td></tr>
      <tr><th scope="row">Code block</th><td><kbd>Ctrl+Shift+K</kbd></td></tr>
      <tr><th scope="row">Undo / Redo</th><td><kbd>Ctrl+Z / Ctrl+Shift+Z</kbd></td></tr>
      <tr><th scope="row">Visual / Markdown</th><td><kbd>Ctrl+/</kbd></td></tr>
      <tr><th scope="row">Next / Previous tab</th><td><kbd>Ctrl+Tab / Ctrl+Shift+Tab</kbd></td></tr>
      <tr><th scope="row">Toggle sidebar</th><td><kbd>Ctrl+Shift+B</kbd></td></tr>
      <tr><th scope="row">Command palette</th><td><kbd>Ctrl+Shift+P</kbd></td></tr>
      <tr><th scope="row">Insert a block (empty Visual line)</th><td><kbd>/</kbd></td></tr>
      <tr><th scope="row">Move block up / down (Visual)</th><td><kbd>Alt+Shift+Up / Alt+Shift+Down</kbd></td></tr>
      <tr><th scope="row">Move outline section</th><td><kbd>Alt+Up / Alt+Down</kbd></td></tr>
      <tr><th colspan="2" scope="colgroup">Files and navigation</th></tr>
      <tr><th scope="row">New / Open</th><td><kbd>Ctrl+N / Ctrl+O</kbd></td></tr>
      <tr><th scope="row">Save / Save as</th><td><kbd>Ctrl+S / Ctrl+Shift+S</kbd></td></tr>
      <tr><th scope="row">Save all files</th><td><kbd>Ctrl+Alt+S</kbd></td></tr>
      <tr><th scope="row">Close active file</th><td><kbd>Ctrl+W</kbd></td></tr>
      <tr><th scope="row">Find and replace</th><td><kbd>Ctrl+F</kbd></td></tr>
      <tr><th scope="row">Focus mode</th><td><kbd>F9</kbd></td></tr>
    </tbody></table>
    <form method="dialog"><button class="primary">Close</button></form>
  </dialog>
  <dialog id="help-dialog">
    <h2>Your writing desk, explained</h2>
    <p><b>Tabs:</b> Open and New keep other files open. Each tab keeps its edits and undo history. Click its x to close; a dot means unsaved changes. Save and Export use the active tab; Save all saves every modified tab.</p>
    <p><b>Split files:</b> choose <b>More &gt; Split with another file...</b> or right-click a tab, then choose another open file from its thumbnail preview card. One paired tab displays two files side by side. Other tabs still open alone; clicking the pair restores both files. Each side keeps its own view and undo. Click a side to target formatting, Find, Save, and Export. Drag the divider or focus it and use Left/Right to resize. <b>Unsplit</b> restores individual tabs without closing files. The pair's x closes both files with unsaved-change prompts; Ctrl+W closes only the active file.</p>
    <p><b>Themes:</b> choose Light or Dark at the bottom of the sidebar, or use View &gt; Color theme when the sidebar is hidden. Recent Files starts collapsed; expand its heading to browse history. This preference is remembered, and the outline gets the remaining space.</p>
    <p><b>Save:</b> the Save button saves the active file. Its arrow opens Save All and Save As. Hover over tools for their keyboard shortcuts, or open ${button('shortcuts', 'Keyboard shortcuts')} (F1). The toolbar is grouped into View, Style, Text, Paragraph, Insert and Review. Insert includes Image, Table, Code, Alerts, Structure and Interactive. Structure and Interactive stay visible; at narrower widths lower-priority tools move into More.</p>
    <p><b>Search commands</b> (Ctrl+Shift+P, or the search box in the header) finds any command, block, theme or setting by name. In Visual mode, type <code>/</code> on an empty line to insert a heading, list, table, alert or block; Escape dismisses the list. <b>Block</b> commands (right-click, Edit menu or palette) move, duplicate or remove the block at the cursor; Alt+Shift+Up/Down moves it. Clicking into a block shows a small floating toolbar with the same commands. Drag top-level outline headings, or focus one and press Alt+Up/Down, to move a section with its subsections; Left/Right collapse or expand it. Ctrl+Z undoes any move. Click the word count for document statistics.</p>
    <p><b>Visual</b> works like a word processor. Type <code># </code> for a heading, <code>- </code> for a list, or use the toolbar.</p>
    <p><b>Code blocks</b> have a searchable language selector and Copy button at the bottom-right. Select PowerShell, Python, JSON, or another supported language for syntax colors. Code contents are never reformatted or executed. PDF and Word include the colors, not the controls.</p>
    <p><b>Writing assistance:</b> enable offline English grammar checks from the status bar, More tools, or View menu. Harper runs locally in the background. Review underlined suggestions, apply an undoable correction, or ignore it once or throughout the current document. No text is sent online or changed automatically; suggestions can be imperfect.</p>
    <p><b>Structure and Interactive:</b> Structure has table of contents, diagrams, horizontal rules, image descriptions, YAML metadata and include directives. Interactive has editable tabs and variant selectors. Select an example and type/format directly in its body. Click the selected tab or variant choice again, double-click it, or focus its name and press <b>F2</b>, to rename it in place. <b>Enter</b> finishes; <b>Escape</b> cancels the rename. <b>+</b> adds an example or choice; each <b>&times;</b> removes its own item, removing the last one removes the whole block, and undo restores it. Edit metadata directly in its YAML box and edit image settings only when needed. Create a <b>Variant selector</b>, then put the caret where content belongs and choose <b>Add variant content</b> from Interactive. Inactive content has <b>Show and edit</b>. Unsupported syntax remains editable in its inline block field. Save the document to preview and export included content without its document metadata. If an include is outside the document folder, Lekh asks before allowing a suggested project folder; access ends when the document is closed or saved in another folder. The original directives stay in your document. Use interactive HTML export for documents with tabs or variants, including those in included files; Word and PDF do not support them.</p>
    <p><b>Editing views:</b> choose <b>Visual</b>, <b>Markdown</b>, or <b>Split</b> for both side by side. Split scrolling is synchronized in both directions using document anchors and wrapped source lines. Paired documents remain independent.</p>
    <p><b>Sidebar</b>: drag its right edge to resize, or focus the edge and use Left/Right (Home/End set limits). Double-click the edge to reset. Width is remembered between launches and limited to leave room for editing. Use the sidebar button or Ctrl+Shift+B to toggle outline/recent files. <b>View &gt; Focus mode</b> or F9 also hides the document header; Escape restores your previous sidebar preference.</p>
    <p><b>Find</b>: click Find or press Ctrl+F to open or close the find bar. Close and Escape also dismiss it; the search and replacement text are retained.</p>
    <p><b>Right-click</b> for Formatting, Paragraph (Heading 1-6 or normal text), Insert &gt; Alerts / Structure / Interactive, View and tools, Copy / Paste As, and spelling suggestions. Toolbar tools are also available here. Create a Variant selector first; its menu entry then changes to Add variant content. Nested menus stay next to their parent and support arrows/Escape. Choose <b>Table &gt; Insert table</b> or <b>Insert &gt; Table</b> to choose rows and columns. Row/column editing controls become available inside a table.</p>
    <p><b>Insert</b> includes images, links, tables, code fences, Mermaid, horizontal lines, a marked table of contents, and paragraphs before/after. Use the same <b>Table of contents</b> button to refresh the existing marked list after changing headings. Footnotes, link references, math, and YAML insert editable syntax in <b>Markdown view</b>. From Visual mode these go at the end, except YAML at the top. Math and footnotes do not yet have formatted rendering or structured export support; YAML is preserved as document metadata, not article text.</p>
    <p><b>Links:</b> in Visual, click a link to edit its text and address, or right-click and choose <b>Edit link...</b>. The link toolbar button and <b>Ctrl+K</b> also edit the selected link. <b>Remove link</b> keeps its text. <b>Ctrl+click</b> opens a link after confirmation; generated contents links still navigate normally.</p>
    <p><b>Markdown</b> lets you edit exact source text. Use it for advanced syntax or HTML the visual editor doesn't support. Visual editing may normalize Markdown syntax; edits in one editor can require the other editor's history to be refreshed.</p>
    <p><b>Save</b> keeps a regular UTF-8 Markdown file. <b>Export</b> creates a separate HTML, Word, or PDF document, including the active tab's unsaved edits. HTML works offline and retains interactive tabs and variants.</p>
    <p>Insert, paste or drop an image, then choose embedding or a saved document's <b>assets</b> folder. Clipboard bitmaps become PNG. Right-click an image for <b>Copy image</b>. Embedded images travel with the Markdown; relative assets must be kept with its folder. Remote images are not fetched. Word supports PNG, JPEG, and GIF; PDF also supports WebP.</p>
    <p><b>Ctrl+N</b> New tab &nbsp; <b>Ctrl+O</b> Open &nbsp; <b>Ctrl+S</b> Save<br><b>Ctrl+W</b> Close tab &nbsp; <b>Ctrl+Tab</b> Next tab<br><b>Ctrl+Alt+S</b> Save all &nbsp; <b>Ctrl+P</b> PDF<br><b>Ctrl+0-6</b> Paragraph / Headings &nbsp; <b>Ctrl+T</b> Table<br><b>Ctrl+F</b> Find &nbsp; <b>Ctrl+/</b> Switch mode &nbsp; <b>F9</b> Focus</p>
    <p><b>Preview</b> shows a read-only, interactive rendering. Turn on <b>Show Markdown beside preview</b> to edit source on the right, with optional synchronized scrolling. <b>Back to editing</b> restores your previous view. Mermaid diagrams render locally.</p>
    <p>Local draft recovery covers every unsaved tab. Save regularly; recovery is not a substitute for backups. Rendered math is not supported.</p>
    <form method="dialog"><button class="primary">Let's write</button></form>
  </dialog>
`;

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
for (const shortcut of formattingShortcuts) {
  for (const control of document.querySelectorAll<HTMLElement>(`[data-command="${shortcut.command}"]`)) {
    control.title = `${shortcut.label} (${shortcut.accelerator.replace('CmdOrCtrl', 'Ctrl')})`;
    control.setAttribute('aria-keyshortcuts', shortcut.accelerator.replace('CmdOrCtrl', 'Control'));
  }
}
const actionShortcuts: Record<string, string> = {
  new: 'Ctrl+N', open: 'Ctrl+O', save: 'Ctrl+S', 'save-as': 'Ctrl+Shift+S', 'save-all': 'Ctrl+Alt+S',
  find: 'Ctrl+F', link: 'Ctrl+K', image: 'Ctrl+Shift+I', table: 'Ctrl+T',
  undo: 'Ctrl+Z', redo: 'Ctrl+Shift+Z', shortcuts: 'F1',
};
for (const control of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  const shortcut = actionShortcuts[control.dataset.action!];
  if (!shortcut) continue;
  const label = control.querySelector('span')?.textContent ?? control.textContent ?? '';
  control.title = `${label.trim()} (${shortcut})`;
  control.setAttribute('aria-keyshortcuts', shortcut.replaceAll('Ctrl', 'Control'));
  if (control.closest('.dropdown') && !control.querySelector('kbd')) {
    const hint = document.createElement('kbd');
    hint.textContent = shortcut;
    control.append(hint);
  }
}
for (const control of document.querySelectorAll<HTMLElement>('[data-command="codeblock"]')) {
  control.title = 'Code block (Ctrl+Shift+K)';
  control.setAttribute('aria-keyshortcuts', 'Control+Shift+K');
}
let source = element<HTMLTextAreaElement>('source-editor');
let visual = element<HTMLElement>('visual-editor');
const initialPane = createPane(visual, source);
let documentId = '';
const collapsedOutline = new Map<string, Set<string>>();
let markdown = '';
let exportCheckedMarkdown: string | undefined;
let exportCheckedDocumentId = '';
let rawInteractiveExportRequired = false;
let interactiveExportRequired = false;
let exportCheckPending = false;
let exportCheckError = '';
let exportCheckComplete = false;
let exportCheckTimer: ReturnType<typeof setTimeout> | undefined;
let exportCheckRevision = 0;
let savedMarkdown = '';
let documentPath: string | null = null;
let documentName = 'Untitled.md';
let mode: 'visual' | 'source' = 'visual';
let busy = false;
const editorMenu = new ContextMenu(icon);
let contextTarget: HTMLElement | null = null;
let contextPoint = { x: 0, y: 0 };
let sourceUndo: string[] = [];
let sourceRedo: string[] = [];
let searchMatches: SearchMatch[] = [];
let searchIndex = -1;
let searchTimer: ReturnType<typeof setTimeout>;
let searchRevision = 0;
let previewTimer: ReturnType<typeof setTimeout>;
let draftTimer: ReturnType<typeof setTimeout>;
let notificationTimer: ReturnType<typeof setTimeout>;
interface RecoveryDraft { content: string; name: string }
let recovery: RecoveryDraft[] = [];
interface DocumentTab {
  id: string;
  markdown: string;
  savedMarkdown: string;
  name: string;
  path: string | null;
  mode: 'visual' | 'source';
  editor: Editor;
  visual: HTMLElement;
  undo: string[];
  redo: string[];
  selection: [number, number];
  sourceScroll: number;
  canvasScroll: number;
  source: HTMLTextAreaElement;
  pane: HTMLElement;
  viewport: HTMLElement;
  visualViewport: HTMLElement;
  visualMarkdown: string;
  sideBySide?: boolean;
  preview?: boolean;
  previewSource?: boolean;
  previewReturnMode?: 'visual' | 'source';
  previewMarkdown?: string;
  previewRevision?: number;
  variantConfigKey?: string;
  variantConfigRevision?: number;
}
const tabs: DocumentTab[] = [];
const pairs: SplitPair[] = [];
let activeTab: DocumentTab | undefined;
let responsiveFrame = 0;
let untitledCount = 0;
let contextImageSource: string | null = null;
const draftKey = 'lekh-draft-v1';
const themeKey = 'lekh-theme';
const sidebarKey = 'lekh-sidebar-hidden';
const sidebarWidthKey = 'lekh-sidebar-width';
const recentExpandedKey = 'lekh-recent-expanded';
let sidebarHidden = false;
let preferredSidebarWidth = DEFAULT_SIDEBAR_WIDTH;
let recentExpanded = false;
let theme: Theme = 'light';
let tableDocumentId: string | null = null;
let linkSelection: {
  documentId: string; mode: 'visual' | 'source'; from: number; to: number;
  doc: Editor['state']['doc']; content: string; existing: boolean; label: string;
} | null = null;
let splitDocumentId: string | null = null;
try {
  const savedTheme = restoreTheme(localStorage.getItem(themeKey));
  if (savedTheme) theme = savedTheme;
  sidebarHidden = localStorage.getItem(sidebarKey) === 'true';
  recentExpanded = localStorage.getItem(recentExpandedKey) === 'true';
  const raw = localStorage.getItem(draftKey);
  if (raw) {
    const parsed: unknown = JSON.parse(raw);
    const drafts = parsed && typeof parsed === 'object' && 'documents' in parsed ? parsed.documents : [parsed];
    if (!Array.isArray(drafts) || !drafts.every((draft: unknown): draft is RecoveryDraft => Boolean(
      draft && typeof draft === 'object' && 'content' in draft && typeof draft.content === 'string' && 'name' in draft && typeof draft.name === 'string',
    ))) throw new Error('The saved drafts are not valid.');
    recovery = drafts;
    element('recovery-banner').hidden = !recovery.length;
  }
} catch (error) { notify(`Draft/settings storage could not be read: ${String(error)}`, true); }
try {
  const storedWidth = localStorage.getItem(sidebarWidthKey);
  if (storedWidth !== null) {
    if (!storedWidth.trim() || !Number.isFinite(Number(storedWidth))) throw new Error('The saved sidebar width is not valid.');
    preferredSidebarWidth = sidebarWidth(Number(storedWidth), MAX_SIDEBAR_WIDTH + 480);
  }
} catch (error) { notify(`Sidebar width could not be read: ${String(error)}`, true); }
updateThemeUI();
updateSidebar();
updateSidebarWidth();
setFindOpen(false);
updateRecentDisclosure();

function updateThemeUI(): void {
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    root.classList.add('theme-switching');
    root.dataset.theme = theme;
    void root.offsetHeight;
    root.classList.remove('theme-switching');
  }
  const control = element<HTMLButtonElement>('theme-toggle');
  control.querySelector('span')!.textContent = theme === 'dark' ? 'Dark' : 'Light';
  control.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  control.setAttribute('aria-label', control.title);
  element<HTMLImageElement>('brand-icon').src = theme === 'light' ? brandIcon : brandDarkIcon;
}

function updateRecentDisclosure(): void {
  element('recent').hidden = !recentExpanded;
  element('clear-recent').hidden = !recentExpanded;
  const toggle = element<HTMLButtonElement>('recent-toggle');
  toggle.setAttribute('aria-expanded', String(recentExpanded));
  toggle.title = `${recentExpanded ? 'Collapse' : 'Expand'} recent files`;
}

function updateSidebar(): void {
  const visible = !sidebarHidden && !document.body.classList.contains('focus-mode');
  document.body.classList.toggle('sidebar-hidden', sidebarHidden);
  element('sidebar').hidden = document.body.classList.contains('focus-mode');
  const control = element<HTMLButtonElement>('sidebar-toggle');
  control.setAttribute('aria-expanded', String(visible));
  control.setAttribute('aria-label', visible ? 'Collapse sidebar' : 'Expand sidebar');
  control.title = `${visible ? 'Collapse' : 'Expand'} sidebar (Ctrl+Shift+B)`;
  updateSidebarWidth();
}

function setFocusMode(enabled: boolean): void {
  document.body.classList.toggle('focus-mode', enabled);
  updateSidebar();
}

function updateSidebarWidth(): void {
  const width = sidebarWidth(preferredSidebarWidth, window.innerWidth);
  element('sidebar').style.width = `${sidebarHidden ? 40 : width}px`;
  const divider = element('sidebar-resizer');
  divider.setAttribute('aria-valuemin', String(MIN_SIDEBAR_WIDTH));
  divider.setAttribute('aria-valuemax', String(sidebarWidth(MAX_SIDEBAR_WIDTH, window.innerWidth)));
  divider.setAttribute('aria-valuenow', String(width));
  divider.setAttribute('aria-valuetext', `${width} pixels`);
}

function rememberSidebarWidth(): void {
  try { localStorage.setItem(sidebarWidthKey, String(preferredSidebarWidth)); }
  catch (error) { notify(`Sidebar width changed, but could not be remembered: ${String(error)}`, true); }
}

function setFindOpen(open: boolean): void {
  const panel = element('find-panel');
  const returnToEditor = !open && panel.contains(document.activeElement);
  panel.hidden = !open;
  const control = document.querySelector<HTMLButtonElement>('[data-action="find"]')!;
  control.setAttribute('aria-controls', 'find-panel');
  control.setAttribute('aria-expanded', String(open));
  if (open) { element<HTMLInputElement>('find-text').focus(); scheduleSearch(); }
  else if (returnToEditor) {
    if (mode === 'source') source.focus();
    else editor.commands.focus();
  }
  if (!open) {
    searchRevision++;
    clearTimeout(searchTimer);
    for (const tab of tabs) tab.pane.querySelector('.source-highlights')?.replaceChildren();
  }
}

function refreshPreview(tab: DocumentTab): void {
  if (!tab.preview || tab.previewMarkdown === tab.markdown) return;
  const content = tab.viewport.querySelector<HTMLElement>('.document-preview')!;
  const snapshot = tab.markdown;
  const revision = (tab.previewRevision ?? 0) + 1;
  tab.previewRevision = revision;
  tab.previewMarkdown = snapshot;
  void publishingHTML(snapshot, tab.id).then(async html => {
    if (!tab.preview || tab.markdown !== snapshot || tab.previewRevision !== revision || !tabs.includes(tab)) return;
    content.innerHTML = html;
    initializePublishing(content, message => notify(message, true), tab.id);
    await renderMermaidBlocks(content);
  }).catch(error => {
    if (!tab.preview || tab.markdown !== snapshot || tab.previewRevision !== revision || !tabs.includes(tab)) return;
    const message = `Preview could not be rendered: ${String(error)}`;
    content.replaceChildren();
    const warning = document.createElement('p');
    warning.className = 'publishing-error';
    warning.textContent = message;
    content.append(warning);
    notify(message, true);
  });
}

function refreshLocalImages(id: string): void {
  for (const tab of tabs) {
    if (tab.id !== id) continue;
    for (const image of tab.pane.querySelectorAll<HTMLImageElement>('img[data-lekh-source]')) {
      const source = image.getAttribute('src');
      if (!source) continue;
      const refreshed = new URL(source);
      if (refreshed.protocol !== 'lekh-image:') continue;
      refreshed.searchParams.set('refresh', String(Date.now()));
      image.src = refreshed.href;
    }
  }
}

function sharedVariantMetadataField(content: string): string | undefined {
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!frontmatter) return;
  const fields = frontmatter[1].split(/\r?\n/).filter(line => /^zone_pivot_groups\s*:\s*\S/.test(line));
  return fields.length === 1 ? fields[0] : undefined;
}

function refreshProjectVariantLabels(tab: DocumentTab, force = false): void {
  const field = sharedVariantMetadataField(tab.markdown);
  const key = JSON.stringify([tab.path, field]);
  if (!force && tab.variantConfigKey === key) return;
  void loadProjectVariantLabels(tab).catch(error => {
    notify(`Variant labels could not be loaded: ${String(error)}`, true);
  });
}

async function loadProjectVariantLabels(tab: DocumentTab): Promise<boolean> {
  const field = sharedVariantMetadataField(tab.markdown);
  const key = JSON.stringify([tab.path, field]);
  if (tab.variantConfigKey !== key || !field) setProjectVariantLabels(tab.pane, null);
  tab.variantConfigKey = key;
  const revision = (tab.variantConfigRevision ?? 0) + 1;
  tab.variantConfigRevision = revision;
  if (!field) return false;
  const snapshot = tab.markdown;
  const result = await window.lekh.prepareVariantConfiguration(tab.id, snapshot);
  if (!tabs.includes(tab) || tab.variantConfigRevision !== revision) return false;
  if (!result.ok) throw new Error(result.error);
  setProjectVariantLabels(tab.pane, result.value === snapshot ? null : result.value);
  return Boolean(projectVariantOptions(tab.pane));
}

function togglePreview(): void {
  if (!activeTab) return;
  if (activeTab.preview) {
    setEditingView(activeTab.sideBySide ? 'split' : activeTab.previewReturnMode ?? 'visual');
    return;
  }
  activeTab.canvasScroll = visualScroll(activeTab).scrollTop;
  if (!source.hidden) activeTab.sourceScroll = source.scrollTop;
  activeTab.previewReturnMode = mode;
  activeTab.preview = true;
  activeTab.previewSource ??= true;
  if (activeTab.previewSource) {
    prepareSource(activeTab);
    mode = 'source';
  }
  showMode();
  updateToolbar();
  refreshPreview(activeTab);
  activeTab.viewport.querySelector<HTMLElement>('.live-preview')!.focus({ preventScroll: true });
}

function setPreviewSource(show: boolean): void {
  if (!activeTab?.preview) return;
  if (!source.hidden) activeTab.sourceScroll = source.scrollTop;
  activeTab.previewSource = show;
  if (show) {
    prepareSource(activeTab);
    mode = 'source';
  } else mode = activeTab.previewReturnMode ?? mode;
  showMode();
  source.scrollTop = activeTab.sourceScroll;
  updateToolbar();
}

function searchKey(): string {
  return JSON.stringify([
    element<HTMLInputElement>('find-text').value,
    element<HTMLInputElement>('find-case').checked, element<HTMLInputElement>('find-word').checked,
    element<HTMLInputElement>('find-regex').checked, documentId,
  ]);
}
function searchText(): string { return markdown.replace(/\r\n/g, '\n'); }
let lastSearchKey = '';
let lastSearchText = '';

function requestSearch(text: string): Promise<SearchResult> {
  const worker = new Worker(new URL('./search-worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Search exceeded two seconds. Simplify the regular expression or narrow the search.'));
    }, 2000);
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = (event: MessageEvent<Result<SearchResult>>) => {
      finish();
      if (event.data.ok) resolve(event.data.value);
      else reject(new Error(event.data.error));
    };
    worker.onerror = event => { finish(); reject(new Error(`Search worker failed: ${event.message}`)); };
    worker.postMessage({
      text, query: element<HTMLInputElement>('find-text').value,
      replacement: element<HTMLInputElement>('replace-text').value,
      options: {
        caseSensitive: element<HTMLInputElement>('find-case').checked,
        wholeWord: element<HTMLInputElement>('find-word').checked,
        regex: element<HTMLInputElement>('find-regex').checked,
      },
    });
  });
}

function paintSearch(): void {
  for (const tab of tabs) {
    const layer = tab.pane.querySelector<HTMLElement>('.source-highlights')!;
    layer.replaceChildren();
    if (tab !== activeTab || element('find-panel').hidden || !searchMatches.length) continue;
    let position = 0;
    for (const [index, match] of searchMatches.entries()) {
      layer.append(document.createTextNode(source.value.slice(position, match.from)));
      const mark = document.createElement('mark');
      mark.classList.toggle('current-match', index === searchIndex);
      mark.textContent = source.value.slice(match.from, match.to) || '\u200b';
      layer.append(mark);
      position = match.to;
    }
    layer.append(document.createTextNode(source.value.slice(position) + '\n'));
    layer.style.width = `${source.clientWidth}px`;
    layer.scrollTop = source.scrollTop;
    layer.scrollLeft = source.scrollLeft;
  }
}

async function refreshSearch(): Promise<SearchResult | null> {
  const revision = ++searchRevision;
  const text = searchText();
  const key = searchKey();
  try {
    const result = await requestSearch(text);
    if (revision !== searchRevision || key !== searchKey() || text !== searchText()) return null;
    if (lastSearchKey !== key || lastSearchText !== text) searchIndex = -1;
    lastSearchKey = key;
    lastSearchText = text;
    searchMatches = result.matches;
    element('find-result').textContent = `${searchIndex >= 0 ? `${searchIndex + 1} of ` : ''}${result.matches.length.toLocaleString()}${result.truncated ? '+' : ''} matches`;
    paintSearch();
    return result;
  } catch (error) {
    if (revision !== searchRevision) return null;
    searchMatches = [];
    paintSearch();
    throw error;
  }
}

function scheduleSearch(): void {
  clearTimeout(searchTimer);
  searchRevision++;
  searchTimer = setTimeout(() => {
    void refreshSearch().catch(error => {
      element('find-result').textContent = error instanceof Error ? error.message : String(error);
    });
  }, 180);
}

async function navigateSearch(backward = false): Promise<void> {
  clearTimeout(searchTimer);
  if (!element<HTMLInputElement>('find-text').value) throw new Error('Enter some text to find.');
  useSource();
  const result = await refreshSearch();
  if (!result?.matches.length) return;
  searchIndex = (searchIndex + (backward ? (searchIndex < 0 ? 0 : -1) : 1) + result.matches.length) % result.matches.length;
  const match = result.matches[searchIndex];
  source.focus();
  source.setSelectionRange(match.from, match.to);
  source.scrollTop = Math.max(0, markdown.slice(0, match.from).split('\n').length * 24 - 100);
  element('find-result').textContent = `${searchIndex + 1} of ${result.matches.length.toLocaleString()}${result.truncated ? '+' : ''} matches`;
  paintSearch();
}

async function replaceFound(all: boolean): Promise<void> {
  clearTimeout(searchTimer);
  if (!element<HTMLInputElement>('find-text').value) throw new Error('Enter some text to find.');
  useSource();
  const result = await refreshSearch();
  if (!result) throw new Error('The search changed. Try replacing again.');
  if (result.truncated) throw new Error('More than 10,000 matches. Narrow the search before replacing.');
  const matches = all ? result.matches : result.matches.slice(Math.max(0, searchIndex), Math.max(0, searchIndex) + 1);
  const text = replaceSearchMatches(searchText(), matches);
  source.value = text;
  changed(text);
  await refreshSearch();
  element('find-result').textContent = `${matches.length.toLocaleString()} replaced`;
}

async function applyTheme(value: Theme, persist = true): Promise<void> {
  theme = value;
  updateThemeUI();
  if (persist) {
    try { localStorage.setItem(themeKey, theme); }
    catch (error) { notify(`Theme changed, but could not be remembered: ${String(error)}`, true); }
  }
  unwrap(await window.lekh.setTheme(theme));
}

function createEditor(content: string, id = documentId, host = visual): Editor {
  const LocalImage = Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        src: {
          default: null,
          parseHTML: element => element.getAttribute('data-lekh-source') ?? element.getAttribute('src'),
        },
      };
    },
    renderHTML({ HTMLAttributes }) {
      const source = String(HTMLAttributes.src ?? '');
      return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src: imageDisplayURL(source, id), 'data-lekh-source': source })];
    },
  });
  const created: Editor = new Editor({
  element: host,
  extensions: [
    StarterKit.configure({ trailingNode: false, codeBlock: false, link: { openOnClick: false, protocols: ['https', 'http', 'mailto'] } }),
    LanguageCodeBlock.configure({
      copyCode: code => { void run(async () => { unwrap(await window.lekh.writeClipboard(code)); notify('Code copied.'); }); },
      reportError: message => notify(message, true),
    }),
    LocalImage.configure({ allowBase64: true }),
    TableKit.configure({ table: { resizable: false } }),
    TaskList, TaskItem.configure({ nested: true }), ContentsNode,
    AlertNode.configure({ schema: () => created.schema }),
    EditablePublishing.configure({
      schema: () => created.schema, documentId: id,
      reportError: message => notify(message, true),
      refreshIncludeContent: () => { refreshPublishingFiles(); invalidateExportCheck(); },
    }),
    PublishingNode.configure({
      documentId: id,
      editSource: (raw, position) => { void run(async () => editPublishingSource(id, raw, position)); },
      reportError: message => notify(message, true),
    }),
    Markdown, GrammarHighlights, PublishingHeadings, EditorHints,
  ],
  content,
  contentType: 'markdown',
  editorProps: { attributes: { 'aria-label': 'Document text', spellcheck: 'true' } },
  onUpdate: ({ editor: updated }) => {
    if (updated === editor && mode === 'visual') {
      if (activeTab) activeTab.visualMarkdown = updated.getMarkdown();
      changed(updated.getMarkdown());
    }
    else {
      const tab = tabs.find(tab => tab.id === id);
      if (tab?.mode === 'visual') {
        tab.markdown = updated.getMarkdown();
        tab.visualMarkdown = tab.markdown;
        if (tab.sideBySide) mirrorSource(tab);
        update();
        scheduleDraft();
      }
    }
  },
  onSelectionUpdate: ({ editor: updated }) => { if (updated === editor) { updateToolbar(); updateSlashMenu(); scheduleBlockToolbar(); } },
  onFocus: ({ editor: updated }) => { if (updated === editor) scheduleBlockToolbar(); },
  onBlur: () => { slashMenu?.close(); scheduleBlockToolbar(); },
  });
  return created;
}
let editor = createEditor(markdown);

function createPane(host: HTMLElement, text: HTMLTextAreaElement): { pane: HTMLElement; viewport: HTMLElement; visualViewport: HTMLElement } {
  const pane = document.createElement('section');
  pane.className = 'document-pane';
  pane.setAttribute('role', 'region');
  const header = document.createElement('div');
  header.className = 'pane-header';
  header.hidden = true;
  header.innerHTML = '<span class="pane-title"></span>';
  const viewport = document.createElement('div');
  viewport.className = 'pane-content';
  text.classList.add('document-source');
  text.placeholder = 'Write Markdown here. Press Ctrl+Shift+P to search commands, or right-click for tools.';
  const surface = document.createElement('div');
  surface.className = 'source-surface';
  const highlights = document.createElement('pre');
  highlights.className = 'source-highlights';
  highlights.setAttribute('aria-hidden', 'true');
  surface.append(highlights, text);
  const preview = document.createElement('section');
  preview.className = 'live-preview';
  preview.setAttribute('aria-label', 'Read-only Markdown preview');
  preview.tabIndex = 0;
  preview.hidden = true;
  preview.innerHTML = '<div class="preview-heading">Reader preview (read-only)<label><input class="preview-sync" type="checkbox" checked />Sync scrolling</label></div><article class="document-preview"></article>';
  let synchronizing = false;
  const sync = (from: HTMLElement, to: HTMLElement) => {
    if (synchronizing || !preview.querySelector<HTMLInputElement>('.preview-sync')!.checked) return;
    synchronizing = true;
    to.scrollTop = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight) * Math.max(0, to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => { synchronizing = false; });
  };
  text.addEventListener('scroll', () => {
    highlights.scrollTop = text.scrollTop;
    highlights.scrollLeft = text.scrollLeft;
    if (!preview.hidden && !surface.hidden) sync(text, preview);
  });
  preview.addEventListener('scroll', () => { if (!surface.hidden) sync(preview, text); });
  const visualViewport = document.createElement('div');
  visualViewport.className = 'visual-surface';
  visualViewport.append(host);
  let ratio = 0.5;
  const divider = resizeDivider(viewport, 'Resize document views', () => ratio, value => {
    ratio = splitRatio(value);
    viewport.style.setProperty('--pane-columns', `minmax(0, ${ratio}fr) 8px minmax(0, ${1 - ratio}fr)`);
  });
  divider.className = 'pane-divider';
  divider.hidden = true;
  viewport.append(visualViewport, preview, divider, surface);
  pane.append(header, viewport);
  synchronizeDocumentScroll(pane, text, visualViewport, () => tabs.find(tab => tab.pane === pane)?.editor ?? editor);
  return { pane, viewport, visualViewport };
}

function visualScroll(tab: DocumentTab): HTMLElement {
  return tab.sideBySide ? tab.visualViewport : tab.viewport;
}

function mirrorSource(tab: DocumentTab): void {
  if (tab.source.value === tab.markdown) return;
  const { selectionStart, selectionEnd, scrollTop, scrollLeft } = tab.source;
  tab.source.value = tab.markdown;
  tab.source.setSelectionRange(selectionStart, selectionEnd);
  tab.source.scrollTop = scrollTop;
  tab.source.scrollLeft = scrollLeft;
}

function prepareSource(tab: DocumentTab): void {
  if (tab.source.value === tab.markdown) return;
  mirrorSource(tab);
  tab.undo.length = 0;
  tab.redo.length = 0;
}

function syncVisual(): void {
  if (!activeTab || activeTab.visualMarkdown === markdown) return;
  const scroll = visualScroll(activeTab);
  const top = scroll.scrollTop;
  editor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false });
  activeTab.visualMarkdown = markdown;
  scroll.scrollTop = top;
}

function setEditingView(next: 'visual' | 'source' | 'split'): void {
  if (!activeTab) return;
  if (!activeTab.preview && (next === 'split' ? activeTab.sideBySide : !activeTab.sideBySide && mode === next)) return;
  const previousMode = activeTab.preview ? activeTab.previewReturnMode ?? mode : mode;
  const top = activeTab.preview ? activeTab.canvasScroll : visualScroll(activeTab).scrollTop;
  const sourceTop = source.hidden ? activeTab.sourceScroll : source.scrollTop;
  const wasSplit = Boolean(activeTab.sideBySide);
  activeTab.sourceScroll = sourceTop;
  if (activeTab.preview) {
    activeTab.previewMarkdown = undefined;
    activeTab.previewRevision = (activeTab.previewRevision ?? 0) + 1;
  }
  activeTab.preview = false;
  activeTab.sideBySide = next === 'split';
  if (next !== 'visual') prepareSource(activeTab);
  if (next !== 'source' && activeTab.visualMarkdown !== markdown) {
    if (next === 'visual' && !wasSplit) resetVisual(markdown);
    else syncVisual();
  }
  mode = next === 'split' ? previousMode : next;
  showMode();
  visualScroll(activeTab).scrollTop = top;
  source.scrollTop = sourceTop;
  updateToolbar();
  if (mode === 'source') source.focus({ preventScroll: true });
  else editor.view.focus();
}

function visibleTabs(): DocumentTab[] {
  const pair = pairFor(pairs, documentId);
  const ids = pair ? [pair.leftId, pair.rightId] : [documentId];
  return ids.map(id => {
    const tab = tabs.find(tab => tab.id === id);
    if (!tab) throw new Error('A visible document is no longer open.');
    return tab;
  });
}

function resizeSplit(pair: SplitPair, ratio: number): void {
  pair.ratio = splitRatio(ratio);
  element('canvas').style.gridTemplateColumns = `minmax(0, ${pair.ratio}fr) 8px minmax(0, ${1 - pair.ratio}fr)`;
  element('canvas').querySelector(':scope > .split-divider')?.setAttribute('aria-valuenow', String(Math.round(pair.ratio * 100)));
}

function splitDivider(pair: SplitPair): HTMLElement {
  return resizeDivider(element('canvas'), 'Resize split editors', () => pair.ratio, value => resizeSplit(pair, value));
}

function resizeDivider(container: HTMLElement, label: string, ratio: () => number, resize: (value: number) => void): HTMLElement {
  const divider = document.createElement('div');
  divider.className = 'split-divider';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-label', label);
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-valuemin', '25');
  divider.setAttribute('aria-valuemax', '75');
  divider.setAttribute('aria-valuenow', String(Math.round(ratio() * 100)));
  divider.title = 'Drag to resize; Left/Right keys resize, Home/End set limits';
  const updateRatio = (value: number) => {
    const bounded = splitRatio(value);
    resize(bounded);
    divider.setAttribute('aria-valuenow', String(Math.round(bounded * 100)));
  };
  let dragging = false;
  divider.addEventListener('pointerdown', event => {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    divider.focus();
  });
  divider.addEventListener('pointermove', event => {
    if (!dragging || busy) return;
    const bounds = container.getBoundingClientRect();
    if (bounds.width > 0) updateRatio((event.clientX - bounds.left) / bounds.width);
  });
  divider.addEventListener('lostpointercapture', () => { dragging = false; });
  divider.addEventListener('pointerup', event => {
    dragging = false;
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
  });
  divider.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!busy) updateRatio(event.key === 'Home' ? 0.25 : event.key === 'End' ? 0.75 : ratio() + (event.key === 'ArrowLeft' ? -0.05 : 0.05));
  });
  return divider;
}

function updatePaneHeaders(): void {
  const pair = pairFor(pairs, documentId);
  for (const tab of tabs) {
    tab.pane.classList.toggle('active-pane', tab === activeTab);
    tab.pane.setAttribute('aria-label', `${tab.name}${tab === activeTab ? ', active editor' : ''}`);
    const header = tab.pane.querySelector<HTMLElement>('.pane-header')!;
    header.hidden = !pair;
    header.querySelector<HTMLElement>('.pane-title')!.textContent = `${tab.name}${tab.markdown !== tab.savedMarkdown ? ' \u2022' : ''}`;
  }
  const control = document.querySelector<HTMLButtonElement>('[data-action="split"]')!;
  const label = pair ? 'Unsplit files' : 'Split with another file...';
  control.querySelector('span')!.textContent = label;
  control.title = pair ? 'Unsplit the two documents' : 'Split with another document';
  control.setAttribute('aria-pressed', String(Boolean(pair)));
  control.setAttribute('role', 'menuitemcheckbox');
  control.setAttribute('aria-checked', String(Boolean(pair)));
  control.disabled = !pair && !tabs.some(tab => tab.id !== documentId && !pairFor(pairs, tab.id));
  scheduleResponsiveLayout();
}

function showWorkspace(): void {
  const root = element('canvas');
  const visible = visibleTabs();
  const pair = pairFor(pairs, documentId);
  root.classList.toggle('is-split', Boolean(pair));
  if (pair) resizeSplit(pair, pair.ratio);
  else root.style.removeProperty('grid-template-columns');
  const mounted = [...root.querySelectorAll<HTMLElement>(':scope > .document-pane')];
  if (mounted.length !== visible.length || mounted.some((pane, index) => pane !== visible[index].pane)) {
    for (const tab of tabs) {
      if (tab.pane.parentElement === root) {
        if (!tab.preview) tab.canvasScroll = visualScroll(tab).scrollTop;
        if (!tab.source.hidden) tab.sourceScroll = tab.source.scrollTop;
      }
    }
    root.replaceChildren(...(pair ? [visible[0].pane, splitDivider(pair), visible[1].pane] : [visible[0].pane]));
    for (const tab of visible) {
      if (!tab.preview) visualScroll(tab).scrollTop = tab.canvasScroll;
      tab.source.scrollTop = tab.sourceScroll;
    }
  }
  for (const tab of tabs) {
    tab.visual.removeAttribute('id');
    tab.source.removeAttribute('id');
  }
  visual.id = 'visual-editor';
  source.id = 'source-editor';
  if (pair) resizeSplit(pair, pair.ratio);
  root.setAttribute('role', 'tabpanel');
  root.setAttribute('aria-labelledby', `tab-${pair?.leftId ?? documentId}`);
  showMode();
}

function captureTab(): void {
  if (!activeTab) return;
  Object.assign(activeTab, {
    markdown, savedMarkdown, name: documentName, path: documentPath, mode, editor, visual,
    undo: sourceUndo, redo: sourceRedo,
    selection: [source.selectionStart, source.selectionEnd],
    sourceScroll: source.hidden ? activeTab.sourceScroll : source.scrollTop,
    canvasScroll: activeTab.preview ? activeTab.canvasScroll : visualScroll(activeTab).scrollTop,
  });
}

function renderTabs(): void {
  captureTab();
  const list = element('tabs');
  list.replaceChildren();
  const menu = element('tabs-menu');
  menu.replaceChildren();
  for (const group of groupTabs(tabs.map(tab => tab.id), pairs)) {
    const members = group.documentIds.map(id => tabs.find(tab => tab.id === id)!);
    const selected = group.documentIds.includes(documentId);
    const label = members.map(tab => `${tab.name}${tab.markdown !== tab.savedMarkdown ? ' \u2022' : ''}`).join(' | ');
    const wrapper = document.createElement('div');
    wrapper.className = `document-tab${selected ? ' selected' : ''}${group.pair ? ' paired-tab' : ''}`;
    wrapper.dataset.documentId = group.id;
    if (group.pair) wrapper.dataset.paired = 'true';
    const select = document.createElement('button');
    select.className = 'tab-select';
    select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(selected));
    select.id = `tab-${group.id}`;
    select.setAttribute('aria-controls', 'canvas');
    select.setAttribute('aria-label', `${group.pair ? 'Split pair: ' : ''}${members.map(tab => `${tab.name}${tab.markdown !== tab.savedMarkdown ? ', unsaved changes' : ''}`).join(' and ')}`);
    select.tabIndex = selected ? 0 : -1;
    select.title = members.map(tab => tab.path ?? tab.name).join(' | ');
    select.textContent = `${group.pair ? '\u25eb ' : ''}${label}`;
    select.addEventListener('click', () => { void run(async () => activateTab(group.pair?.activeId ?? group.id)); });
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '\u00d7';
    close.title = `Close ${members.map(tab => tab.name).join(' and ')}`;
    close.setAttribute('aria-label', close.title);
    close.addEventListener('click', () => { void run(async () => closeGroup(group.documentIds)); });
    wrapper.addEventListener('contextmenu', event => {
      event.preventDefault();
      showTabMenu(event, group.pair?.activeId ?? group.id);
    });
    wrapper.append(select, close);
    list.append(wrapper);
    const menuItem = document.createElement('button');
    menuItem.type = 'button';
    menuItem.setAttribute('role', 'menuitemradio');
    menuItem.setAttribute('aria-checked', String(selected));
    menuItem.textContent = select.textContent;
    menuItem.title = select.title;
    menuItem.addEventListener('click', () => {
      closeDropdowns();
      void run(async () => activateTab(group.pair?.activeId ?? group.id));
    });
    menu.append(menuItem);
  }
  scheduleResponsiveLayout();
}

function showMode(): void {
  const preview = Boolean(activeTab?.preview);
  const sideBySide = Boolean(activeTab?.sideBySide && !preview);
  const previewSource = Boolean(preview && activeTab?.previewSource);
  source.hidden = preview ? !previewSource : !sideBySide && mode !== 'source';
  source.closest<HTMLElement>('.source-surface')!.hidden = source.hidden;
  visual.hidden = preview || !sideBySide && mode !== 'visual';
  if (activeTab) activeTab.visualViewport.hidden = visual.hidden;
  activeTab?.viewport.classList.toggle('side-by-side', sideBySide);
  activeTab?.viewport.classList.toggle('reader-preview', preview);
  activeTab?.viewport.classList.toggle('has-preview', previewSource);
  if (activeTab) {
    activeTab.viewport.querySelector<HTMLElement>('.live-preview')!.hidden = !preview;
    activeTab.viewport.querySelector<HTMLElement>('.pane-divider')!.hidden = !sideBySide && !previewSource;
    refreshPublishingVariants(activeTab.pane);
  }
  const current = sideBySide ? 'split' : mode === 'source' ? 'markdown' : 'visual';
  for (const view of ['visual', 'markdown', 'split']) {
    const control = element<HTMLButtonElement>(`view-${view}`);
    const pressed = !preview && current === view;
    control.setAttribute('aria-pressed', String(pressed));
    if (control.getAttribute('role') === 'menuitemcheckbox') control.setAttribute('aria-checked', String(pressed));
  }
  const toggle = element<HTMLButtonElement>('preview-toggle');
  toggle.setAttribute('aria-pressed', String(preview));
  if (toggle.getAttribute('role') === 'menuitemcheckbox') toggle.setAttribute('aria-checked', String(preview));
  toggle.querySelector('span')!.textContent = preview ? 'Back to editing' : 'Preview';
  toggle.title = preview ? 'Return to the previous editing view' : 'Open reader preview';
  element('preview-source-option').hidden = !preview;
  element<HTMLInputElement>('preview-source').checked = Boolean(activeTab?.previewSource);
  element('view-hint-text').innerHTML = preview
    ? '<strong>Preview:</strong> Reader view; click choices and tabs without editing the document.'
    : current === 'split'
      ? '<strong>Split:</strong> Visual and Markdown are both editable, side by side.'
      : current === 'markdown'
        ? '<strong>Markdown:</strong> Edit the document source.'
        : '<strong>Visual:</strong> Edit the document as it appears.';
  document.querySelector('.toolbar')!.classList.toggle('source-toolbar', mode === 'source');
  if (activeTab) activeTab.mode = mode;
  updatePaneHeaders();
  if (!visual.hidden) synchronizeVisualHeadingAnchors();
  if (preview && activeTab) refreshPreview(activeTab);
  writingAssistance?.schedule();
}

function activateTab(id: string): void {
  editorMenu.hide();
  const next = tabs.find(tab => tab.id === id);
  if (!next) throw new Error('This tab is no longer open.');
  if (next === activeTab) return;
  captureTab();
  activeTab = next;
  documentId = next.id;
  markdown = next.markdown;
  savedMarkdown = next.savedMarkdown;
  documentName = next.name;
  documentPath = next.path;
  mode = next.mode;
  editor = next.editor;
  visual = next.visual;
  source = next.source;
  const pair = pairFor(pairs, id);
  if (pair) pair.activeId = id;
  sourceUndo = next.undo;
  sourceRedo = next.redo;
  showWorkspace();
  source.setSelectionRange(...next.selection);
  source.scrollTop = next.sourceScroll;
  visualScroll(next).scrollTop = next.canvasScroll;
  searchMatches = [];
  searchIndex = -1;
  element('find-result').textContent = '';
  editor.setEditable(!busy, false);
  source.readOnly = busy;
  update();
}

function addTab(id: string, content: string, name: string, file: string | null, saved = true): void {
  if (tabs.some(tab => tab.id === id)) { activateTab(id); return; }
  const host = document.createElement('article');
  host.className = 'paper';
  host.setAttribute('aria-label', 'Visual Markdown editor');
  const text = document.createElement('textarea');
  text.setAttribute('aria-label', 'Markdown source');
  text.spellcheck = false;
  text.value = content;
  text.hidden = mode !== 'source';
  host.hidden = mode !== 'visual';
  const pane = createPane(host, text);
  pane.pane.dataset.documentId = id;
  const tab: DocumentTab = {
    id, markdown: content, savedMarkdown: saved ? content : '', name, path: file, mode, visualMarkdown: content,
    editor: createEditor(content, id, host), visual: host, undo: [], redo: [],
    selection: [0, 0], sourceScroll: 0, canvasScroll: 0,
    source: text, ...pane,
  };
  tabs.push(tab);
  activateTab(id);
  storeDraft();
}

async function newTab(): Promise<void> {
  const id = unwrap(await window.lekh.newDocument());
  let name: string;
  do {
    untitledCount++;
    name = untitledCount === 1 ? 'Untitled.md' : `Untitled ${untitledCount}.md`;
  } while (tabs.some(tab => tab.name === name));
  addTab(id, '', name, null);
}

function unsplit(): void {
  const pair = pairFor(pairs, documentId);
  if (!pair) throw new Error('This tab is not a split pair.');
  captureTab();
  pairs.splice(pairs.indexOf(pair), 1);
  showWorkspace();
  update();
}

function openSplit(): void {
  if (pairFor(pairs, documentId)) { unsplit(); return; }
  const candidates = tabs.filter(tab => tab.id !== documentId && !pairFor(pairs, tab.id));
  if (!candidates.length) throw new Error('Open another unpaired file before creating a split.');
  splitDocumentId = documentId;
  captureTab();
  const list = element('split-documents');
  list.replaceChildren();
  for (const tab of candidates) {
    const card = document.createElement('button');
    card.type = 'submit';
    card.className = 'split-card';
    card.dataset.documentId = tab.id;
    const dirty = tab.markdown !== tab.savedMarkdown;
    card.setAttribute('aria-label', `Split with ${tab.name}${dirty ? ', unsaved changes' : ''}`);
    card.title = tab.path ?? tab.name;
    const thumbnail = document.createElement('span');
    thumbnail.className = 'split-preview';
    thumbnail.setAttribute('aria-hidden', 'true');
    thumbnail.inert = true;
    const page = document.createElement('div');
    page.className = 'split-preview-page';
    page.innerHTML = documentPreviewHTML(tab.markdown, tab.id);
    const snapshot = tab.markdown;
    void publishingHTML(snapshot, tab.id).then(html => {
      if (!card.isConnected || tab.markdown !== snapshot) return;
      page.innerHTML = html;
      initializePublishing(page, undefined, tab.id);
    }).catch(error => {
      if (!card.isConnected) return;
      page.textContent = `Preview unavailable: ${String(error)}`;
    });
    if (!page.textContent?.trim() && !page.querySelector('img, hr')) page.textContent = 'Empty document';
    thumbnail.append(page);
    const label = document.createElement('span');
    label.className = 'split-card-name';
    label.textContent = `${tab.name}${dirty ? ' \u2022' : ''}`;
    const location = document.createElement('span');
    location.className = 'split-card-path';
    location.textContent = tab.path ?? 'Unsaved document';
    card.append(thumbnail, label, location);
    list.append(card);
  }
  element('split-description').textContent = `Pair ${documentName} with another open file.`;
  element('split-error').hidden = true;
  element<HTMLDialogElement>('split-dialog').showModal();
  list.querySelector<HTMLButtonElement>('button')!.focus();
}

function showTabMenu(event: MouseEvent, id: string): void {
  const menu = element('tab-context-menu');
  const pair = pairFor(pairs, id);
  menu.replaceChildren();
  const choices: [string, () => Promise<void>][] = [
    [pair ? 'Unsplit' : 'Split with...', async () => { activateTab(id); openSplit(); }],
    [pair ? 'Close active file' : 'Close tab', async () => closeTab(id)],
  ];
  if (pair) choices.push(['Close both files', async () => closeGroup([pair.leftId, pair.rightId])]);
  for (const [label, operation] of choices) {
    const control = document.createElement('button');
    control.textContent = label;
    control.setAttribute('role', 'menuitem');
    control.addEventListener('click', event => {
      event.stopPropagation();
      menu.hidePopover();
      void run(operation);
    });
    menu.append(control);
  }
  menu.showPopover();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
  menu.querySelector<HTMLButtonElement>('button')!.focus();
}

async function closeGroup(ids: readonly string[]): Promise<void> {
  if (ids.length === 1) { await closeTab(ids[0]); return; }
  const originalId = documentId;
  for (const id of ids) {
    activateTab(id);
    if (!await mayDiscard()) { activateTab(originalId); return; }
  }
  if (ids.length === tabs.length) { finishClose(); return; }
  const index = tabs.findIndex(tab => tab.id === ids[0]);
  for (const id of ids) {
    const tab = tabs.find(tab => tab.id === id)!;
    unwrap(await window.lekh.closeDocument(id));
    writingAssistance?.forget(id);
    forgetPublishingDocument(id);
    tab.editor.destroy();
    tab.pane.remove();
    tabs.splice(tabs.indexOf(tab), 1);
  }
  for (let index = pairs.length - 1; index >= 0; index--) {
    if (ids.includes(pairs[index].leftId) || ids.includes(pairs[index].rightId)) pairs.splice(index, 1);
  }
  activeTab = undefined;
  activateTab(tabs.some(tab => tab.id === originalId) ? originalId : tabs[Math.min(index, tabs.length - 1)].id);
  storeDraft();
}

async function closeTab(id: string): Promise<void> {
  activateTab(id);
  if (!await mayDiscard()) return;
  if (tabs.length === 1) { finishClose(); return; }
  const pair = pairFor(pairs, id);
  const partner = pair ? (pair.leftId === id ? pair.rightId : pair.leftId) : null;
  const index = tabs.findIndex(tab => tab.id === id);
  unwrap(await window.lekh.closeDocument(id));
  writingAssistance?.forget(id);
  forgetPublishingDocument(id);
  editor.destroy();
  activeTab!.pane.remove();
  tabs.splice(index, 1);
  if (pair) pairs.splice(pairs.indexOf(pair), 1);
  activeTab = undefined;
  activateTab(partner ?? tabs[Math.min(index, tabs.length - 1)].id);
  update();
  storeDraft();
}

function finishClose(): void {
  clearTimeout(draftTimer);
  if (!recovery.length) localStorage.removeItem(draftKey);
  window.removeEventListener('beforeunload', storeDraft);
  window.lekh.close();
}

function resetVisual(content: string): void {
  editor.destroy();
  visual.replaceChildren();
  editor = createEditor(content);
  if (activeTab) { activeTab.editor = editor; activeTab.visualMarkdown = content; }
  if (busy) editor.setEditable(false, false);
}

function notify(message: string, error = false): void {
  const notification = element('notification');
  notification.textContent = message;
  notification.classList.toggle('error', error);
  notification.hidden = false;
  notification.setAttribute('role', error ? 'alert' : 'status');
  clearTimeout(notificationTimer);
  if (!error) notificationTimer = setTimeout(() => { notification.hidden = true; }, 5500);
}
element('notification').addEventListener('click', () => { element('notification').hidden = true; });

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function visualHeadingRecords(): Array<{ element: HTMLElement; range?: { from: number; to: number } } | undefined> {
  const targets: Array<{ element: HTMLElement; range?: { from: number; to: number } } | undefined> = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'heading') {
      const dom = editor.view.nodeDOM(position);
      if (dom instanceof HTMLElement) targets.push({ element: dom, range: { from: position, to: position + node.nodeSize } });
    } else if (node.type.name === 'lekhPublishing') {
      const dom = editor.view.nodeDOM(position);
      if (!(dom instanceof HTMLElement)) return false;
      const candidates = [...dom.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
      let next = 0;
      for (const heading of headings(String(node.attrs.markdown))) {
        const found = candidates.findIndex((candidate, index) => index >= next && candidate.textContent?.trim() === heading.displayText);
        targets.push(found >= 0 ? { element: candidates[found] } : undefined);
        if (found >= 0) next = found + 1;
      }
      return false;
    }
    return true;
  });
  return targets;
}

function visualHeadingTargets(): Array<HTMLElement | undefined> {
  return visualHeadingRecords().map(record => record?.element);
}

function synchronizeVisualHeadingAnchors(): void {
  const records = visualHeadingRecords();
  const used = new Map<string, number>();
  const anchors: Array<{ from: number; to: number; id: string }> = [];
  for (const [index, item] of headings(markdown).entries()) {
    const anchor = headingAnchor(item.text, used);
    const record = records[index];
    if (!record) continue;
    if (record.range) anchors.push({ ...record.range, id: anchor });
    else record.element.id = anchor;
  }
  setPublishingHeadings(editor, anchors);
}

let publishingHeadingFrame = 0;
window.addEventListener('lekh-publishing-rendered', event => {
  if (!(event instanceof CustomEvent) || event.detail !== documentId || publishingHeadingFrame) return;
  publishingHeadingFrame = requestAnimationFrame(() => { publishingHeadingFrame = 0; synchronizeVisualHeadingAnchors(); });
});

function editPublishingSource(id: string, raw: string, position: number): void {
  activateTab(id);
  let ordinal = 0;
  editor.state.doc.descendants((node, offset) => {
    if (offset < position && node.type.name === 'lekhPublishing' && String(node.attrs.markdown) === raw) ordinal++;
  });
  const text = markdown.replace(/\r\n/g, '\n');
  const normalized = raw.replace(/\r\n/g, '\n').trimEnd();
  const ranges = publishingBlockRanges(text).filter(block => block.raw.trimEnd() === normalized);
  const block = ranges[ordinal];
  switchMode('source');
  if (!block) {
    notify('The block changed. Its original Markdown is available in Markdown view.', true);
    return;
  }
  source.focus();
  source.setSelectionRange(block.from, block.to);
  source.scrollTop = Math.max(0, text.slice(0, block.from).split('\n').length * 24 - 50);
}

function dialogResult(dialog: HTMLDialogElement): Promise<string> {
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
}

function sharedVariantReviewEntry(group: SharedVariantGroup): string {
  const quote = (value: string) => JSON.stringify(value.trim());
  return [
    `# Owner: ${group.owner}`,
    `- id: ${group.id}`,
    `  title: ${quote(group.title)}`,
    `  prompt: ${quote(group.prompt)}`,
    '  pivots:',
    ...group.pivots.flatMap(pivot => [`    - id: ${pivot.id}`, `      title: ${quote(pivot.title)}`]),
  ].join('\n');
}

function addSharedVariantChoice(container: HTMLElement, id = '', title = ''): void {
  if (container.querySelectorAll('.shared-variant-choice').length >= 32) return;
  const row = document.createElement('div');
  row.className = 'shared-variant-choice';
  const idLabel = document.createElement('label');
  idLabel.textContent = 'Choice ID';
  const idInput = document.createElement('input');
  idInput.required = true;
  idInput.maxLength = 64;
  idInput.pattern = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}';
  idInput.value = id;
  idInput.setAttribute('aria-label', 'Choice ID');
  idLabel.append(idInput);
  const titleLabel = document.createElement('label');
  titleLabel.textContent = 'Choice title';
  const titleInput = document.createElement('input');
  titleInput.required = true;
  titleInput.maxLength = 512;
  titleInput.value = title;
  titleInput.setAttribute('aria-label', 'Choice title');
  titleLabel.append(titleInput);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.textContent = 'Remove';
  remove.setAttribute('aria-label', 'Remove choice');
  remove.addEventListener('click', () => {
    row.remove();
    const rows = [...container.querySelectorAll<HTMLButtonElement>('.shared-variant-choice button')];
    rows.forEach(button => { button.disabled = rows.length <= 2; });
    element<HTMLButtonElement>('shared-variant-add-choice').disabled = container.querySelectorAll('.shared-variant-choice').length >= 32;
  });
  row.append(idLabel, titleLabel, remove);
  container.append(row);
  const rows = [...container.querySelectorAll<HTMLButtonElement>('.shared-variant-choice button')];
  rows.forEach(button => { button.disabled = rows.length <= 2; });
  element<HTMLButtonElement>('shared-variant-add-choice').disabled = container.querySelectorAll('.shared-variant-choice').length >= 32;
}

async function createSharedVariantSelector(): Promise<'local' | 'cancel' | 'created'> {
  const modeDialog = element<HTMLDialogElement>('variant-storage-dialog');
  modeDialog.returnValue = 'cancel';
  const modeResult = dialogResult(modeDialog);
  modeDialog.showModal();
  const storage = await modeResult;
  if (storage !== 'local' && storage !== 'shared') return 'cancel';
  if (storage === 'local') return 'local';

  const targetId = documentId;
  const originalMarkdown = markdown;
  const selectedFile = unwrap(await window.lekh.chooseVariantConfigFile(targetId));
  if (!selectedFile) return 'cancel';
  if (documentId !== targetId || markdown !== originalMarkdown) throw new Error('The active document changed. Start the shared selector workflow again.');

  const detailsDialog = element<HTMLDialogElement>('shared-variant-details-dialog');
  const detailsForm = element<HTMLFormElement>('shared-variant-details-form');
  const pivots = element('shared-variant-pivots');
  pivots.replaceChildren(Object.assign(document.createElement('legend'), { textContent: 'Choices' }));
  element<HTMLParagraphElement>('shared-variant-file-label').textContent = `Shared file: ${selectedFile.label}`;
  element<HTMLInputElement>('shared-variant-owner').value = '';
  element<HTMLInputElement>('shared-variant-id').value = '';
  element<HTMLInputElement>('shared-variant-title').value = '';
  element<HTMLInputElement>('shared-variant-prompt').value = '';
  addSharedVariantChoice(pivots, 'option-1', 'Option 1');
  addSharedVariantChoice(pivots, 'option-2', 'Option 2');
  element<HTMLButtonElement>('shared-variant-add-choice').onclick = () => {
    const next = pivots.querySelectorAll('.shared-variant-choice').length + 1;
    addSharedVariantChoice(pivots, `option-${next}`, `Option ${next}`);
  };
  detailsDialog.returnValue = 'cancel';
  const detailsResult = dialogResult(detailsDialog);
  detailsDialog.showModal();
  if (await detailsResult !== 'review') return 'cancel';
  if (!detailsForm.reportValidity()) return 'cancel';
  if (documentId !== targetId || markdown !== originalMarkdown) throw new Error('The active document changed. Start the shared selector workflow again.');
  const group: SharedVariantGroup = {
    owner: element<HTMLInputElement>('shared-variant-owner').value.trim(),
    id: element<HTMLInputElement>('shared-variant-id').value.trim(),
    title: element<HTMLInputElement>('shared-variant-title').value.trim(),
    prompt: element<HTMLInputElement>('shared-variant-prompt').value.trim(),
    pivots: [...pivots.querySelectorAll<HTMLElement>('.shared-variant-choice')].map(row => ({
      id: row.querySelector<HTMLInputElement>('input[aria-label="Choice ID"]')!.value.trim(),
      title: row.querySelector<HTMLInputElement>('input[aria-label="Choice title"]')!.value.trim(),
    })),
  };

  const reviewDialog = element<HTMLDialogElement>('shared-variant-review-dialog');
  element<HTMLParagraphElement>('shared-variant-review-file').textContent = `Add this entry to ${selectedFile.label}:`;
  element<HTMLPreElement>('shared-variant-review-entry').textContent = sharedVariantReviewEntry(group);
  element<HTMLParagraphElement>('shared-variant-review-metadata').textContent =
    `Add zone_pivot_groups: ${group.id} to this article's metadata.`;
  reviewDialog.returnValue = 'cancel';
  const reviewResult = dialogResult(reviewDialog);
  reviewDialog.showModal();
  if (await reviewResult !== 'confirm') return 'cancel';
  if (documentId !== targetId || markdown !== originalMarkdown) throw new Error('The active document changed. Review the shared selector again before applying it.');
  const result = unwrap(await window.lekh.createVariantGroup(targetId, selectedFile.token, group, originalMarkdown));
  applyDocumentEdit(result.content);
  const tab = tabs.find(item => item.id === targetId);
  if (tab) refreshProjectVariantLabels(tab, true);
  notify(`Created the shared selector in ${result.file}. Save the article to keep its metadata change.`);
  return 'created';
}

async function insertPublishingBlock(kind: string): Promise<boolean> {
  const template = publishingTemplates.find(item => item.id === kind);
  if (!template) return false;
  const insertionDocument = documentId;
  const sourceSelection = mode === 'source' ? [source.selectionStart, source.selectionEnd] as const : null;
  if (mode === 'visual' && template.category === 'alerts') {
    const changed = editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; }).setAlert(template.color).run();
    if (!changed) throw new Error('The alert could not be applied at the current selection.');
    editor.view.dispatch(closeHistory(editor.state.tr));
    return true;
  }
  if (kind === 'publishing-selector' && documentHasSelector()) {
    return insertPublishingBlock('publishing-zone');
  }
  if (kind === 'publishing-selector') {
    const choice = await createSharedVariantSelector();
    if (choice === 'cancel' || choice === 'created') return true;
  }
  const insertionPosition = kind === 'publishing-zone' && mode === 'visual'
    ? variantInsertionPosition(editor.state.selection) : undefined;
  const selected = insertionPosition === undefined ? selectionMarkdown() : '';
  let raw = publishingTemplateMarkdown(kind, selected)!;
  let insertedVariants: string[] | undefined;
  if (kind === 'publishing-include') {
    const dialog = element<HTMLDialogElement>('publishing-include-dialog');
    const title = element<HTMLInputElement>('publishing-include-name');
    const path = element<HTMLInputElement>('publishing-include-path');
    const preview = element('publishing-include-preview');
    title.value = ''; path.value = '';
    const updatePreview = () => {
      const name = title.value.trim(); const file = path.value.trim();
      preview.textContent = name && file ? includeMarkdown(name, file) : '[!INCLUDE [<title>](<filepath>)]';
    };
    title.oninput = updatePreview; path.oninput = updatePreview; updatePreview();
    dialog.returnValue = 'cancel'; dialog.showModal(); title.focus();
    const choice = await new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (choice !== 'insert') return true;
    const name = title.value.trim(); const file = path.value.trim();
    if (!name || !file) throw new Error('Enter both a title and a file path for the include.');
    raw = includeMarkdown(name, file);
  }
  if (kind === 'publishing-zone') {
    const choices = mode === 'visual' ? documentVariantOptions(editor) : publishingBlockRanges(markdown)
      .flatMap(block => block.kind === 'selector' ? editablePublishingBlockAtStart(block.raw)?.options ?? [] : []);
    if (!choices.length && activeTab) choices.push(...(projectVariantOptions(activeTab.pane)?.options ?? []));
    if (!choices.length && sharedVariantMetadataField(markdown)) {
      if (activeTab) await loadProjectVariantLabels(activeTab);
      if (activeTab) choices.push(...(projectVariantOptions(activeTab.pane)?.options ?? []));
    }
    if (!choices.length && sharedVariantMetadataField(markdown)) {
      const selectedFile = unwrap(await window.lekh.chooseVariantConfigFile(documentId));
      if (!selectedFile) return true;
      if (activeTab) {
        if (!await loadProjectVariantLabels(activeTab)) throw new Error('The selected shared file does not contain this article’s selector group.');
        choices.push(...(projectVariantOptions(activeTab.pane)?.options ?? []));
      }
    }
    if (!choices.length) throw new Error(sharedVariantMetadataField(markdown)
      ? 'Load this article’s shared selector file before adding variant content.'
      : 'Add a Variant selector first, then place its content anywhere in the document.');
    const dialog = element<HTMLDialogElement>('variant-content-dialog');
    const options = element('variant-content-options');
    options.replaceChildren();
    const legend = document.createElement('legend'); legend.textContent = 'Applies to'; options.append(legend);
    for (const [index, choice] of choices.entries()) {
      const label = document.createElement('label');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = choice.id; checkbox.checked = index === 0;
      const text = document.createElement('span'); text.textContent = choice.label;
      label.append(checkbox, text); options.append(label);
    }
    dialog.returnValue = 'cancel'; dialog.showModal();
    const choice = await new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (choice !== 'insert') return true;
    const ids = [...options.querySelectorAll<HTMLInputElement>('input:checked')].map(control => control.value);
    if (!ids.length) throw new Error('Choose at least one existing option for this content.');
    insertedVariants = ids;
    raw = `:::zone pivot="${ids.join(',')}"\n${selected}\n:::zone-end`;
  }
  if (kind === 'publishing-image') {
    const image = unwrap(await window.lekh.insertImage());
    if (!image) return true;
    const dialog = element<HTMLDialogElement>('publishing-image-dialog');
    element<HTMLInputElement>('publishing-image-alt').value = selected;
    element<HTMLTextAreaElement>('publishing-image-description').value = '';
    dialog.returnValue = 'cancel';
    dialog.showModal();
    element<HTMLInputElement>('publishing-image-alt').focus();
    const choice = await new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
    if (choice !== 'insert') return true;
    const alt = element<HTMLInputElement>('publishing-image-alt').value.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    if (!alt) throw new Error('Describe the image before inserting it.');
    const description = element<HTMLTextAreaElement>('publishing-image-description').value.trim();
    raw = description
      ? `:::image type="complex" source="${image}" alt-text="${alt}":::\n${description}\n:::image-end`
      : `:::image type="content" source="${image}" alt-text="${alt}":::`;
  }
  if (documentId !== insertionDocument) throw new Error('The active document changed. Insert the block again in the intended document.');
  const metadata = kind === 'publishing-metadata';
  if (metadata && publishingBlockRanges(markdown).some(block => block.kind === 'metadata' && block.from === 0)) {
    switchMode('visual');
    const block = visual.querySelector<HTMLLabelElement>('[data-lekh-metadata]');
    if (block) { block.scrollIntoView({ block: 'nearest' }); block.querySelector<HTMLTextAreaElement>('textarea')?.focus(); }
    return true;
  }
  if (mode === 'visual') {
    const chain = editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; });
    if (!editor.markdown) throw new Error('The Markdown parser is unavailable.');
    const parsedContent = editor.markdown.parse(raw).content ?? [];
    const variantInsertion = insertedVariants ? prepareVariantInsertion(editor.schema, parsedContent) : null;
    const content = variantInsertion?.content ?? [...parsedContent, { type: 'paragraph' }];
    let reachableVariants = insertedVariants;
    const insertion = metadata ? chain.insertContentAt(0, content)
      : insertionPosition !== undefined ? chain.insertContentAt(insertionPosition, content)
        : chain.insertContent(content);
    const inserted = insertion.command(({ tr }) => {
      if (variantInsertion) reachableVariants = selectInsertedVariant(tr, variantInsertion.zone);
      return true;
    }).run();
    if (!inserted) throw new Error('The publishing block could not be inserted at the current selection.');
    if (reachableVariants && activeTab && !reachableVariants.includes(activeTab.pane.dataset.variantSelection ?? '')) {
      choosePublishingVariant(activeTab.pane, reachableVariants[0]);
      editor.view.focus();
    }
  } else if (metadata) {
    source.value = `${raw}\n\n${markdown}`;
    changed(source.value);
    source.focus();
    source.setSelectionRange(0, raw.length);
  } else {
    const [start, end] = sourceSelection ?? [source.selectionStart, source.selectionEnd];
    if (insertedVariants) {
      const next = `${source.value.slice(0, start)}\n\n${raw}\n\n${source.value.slice(end)}`;
      validateSourceVariantInsertion(next, start + 2);
    }
    source.setRangeText(`\n\n${raw}\n\n`, start, end, 'end');
    changed(source.value);
    source.focus();
  }
  return true;
}

function selectionMarkdown(): string {
  if (mode === 'source') return source.value.slice(source.selectionStart, source.selectionEnd);
  const { from, to } = editor.state.selection;
  if (from === to) return '';
  if (!editor.markdown) throw new Error('The Markdown serializer is unavailable.');
  return editor.markdown.serialize({ type: 'doc', content: editor.state.doc.slice(from, to).content.toJSON() });
}

function update(): void {
  renderTabs();
  updatePaneHeaders();
  for (const tab of tabs) {
    tab.pane.dataset.variantConfig = String(Boolean(sharedVariantMetadataField(tab.markdown)));
    refreshProjectVariantLabels(tab);
    if (tab.pane.isConnected) refreshPublishingVariants(tab.pane);
  }
  synchronizeVisualHeadingAnchors();
  const dirty = markdown !== savedMarkdown;
  element('filename').textContent = documentName;
  element('filename').title = documentPath ?? documentName;
  element('dirty-indicator').textContent = dirty ? ' \u2022' : '';
  document.title = `${dirty ? '* ' : ''}${documentName} - ${productName}`;
  window.lekh.setDirty(tabs.some(tab => tab.markdown !== tab.savedMarkdown));
  const words = wordCount(markdown);
  element('word-count').textContent = `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} \u00b7 ${Math.max(1, Math.ceil(words / 220))} min read`;
  updateCursorPosition();
  element('save-status').innerHTML = `<span class="status-dot ${dirty ? 'unsaved' : ''}"></span>${dirty ? 'Unsaved changes' : documentPath ? 'All changes saved' : 'Ready to write'}`;
  const outline = element('outline');
  outline.replaceChildren();
  const tokens = parser.parse(markdown, {});
  if (exportCheckedMarkdown !== markdown || exportCheckedDocumentId !== documentId) {
    exportCheckedMarkdown = markdown;
    exportCheckedDocumentId = documentId;
    rawInteractiveExportRequired = hasInteractivePublishing(tokens);
    interactiveExportRequired = rawInteractiveExportRequired;
    exportCheckPending = false;
    exportCheckError = '';
    exportCheckComplete = false;
    exportCheckRevision++;
  }
  const outlineHeadings = headings(markdown, tokens);
  const collapsed = collapsedOutline.get(documentId) ?? new Set<string>();
  const occurrences = new Map<string, number>();
  const keys = outlineHeadings.map(item => {
    const base = `${item.level}:${item.displayText}`;
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    return `${base}:${count}`;
  });
  const ancestors: { level: number; key: string }[] = [];
  for (const [index, item] of outlineHeadings.entries()) {
    while (ancestors.length && ancestors[ancestors.length - 1].level >= item.level) ancestors.pop();
    const hiddenByParent = ancestors.some(ancestor => collapsed.has(ancestor.key));
    ancestors.push({ level: item.level, key: keys[index] });
    const row = document.createElement('div');
    row.className = 'outline-row';
    row.hidden = hiddenByParent;
    row.style.paddingLeft = `${(item.level - 1) * 12}px`;
    const hasChildren = (outlineHeadings[index + 1]?.level ?? 0) > item.level;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'outline-toggle';
    toggle.tabIndex = -1;
    if (hasChildren) {
      const isCollapsed = collapsed.has(keys[index]);
      toggle.innerHTML = icon('chevron');
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} \u201c${item.displayText || 'Untitled heading'}\u201d`);
      toggle.title = isCollapsed ? 'Expand section' : 'Collapse section';
      toggle.addEventListener('click', () => {
        const next = new Set(collapsed);
        if (next.has(keys[index])) next.delete(keys[index]); else next.add(keys[index]);
        collapsedOutline.set(documentId, next);
        update();
        element('outline').querySelector<HTMLButtonElement>(`.outline-entry[data-outline-index="${index}"]`)?.focus();
      });
    } else {
      toggle.setAttribute('aria-hidden', 'true');
      toggle.disabled = true;
    }
    const entry = document.createElement('button');
    entry.textContent = item.displayText || 'Untitled heading';
    entry.title = item.displayText;
    entry.className = `outline-entry outline-level-${item.level}`;
    entry.draggable = item.root;
    entry.dataset.outlineIndex = String(index);
    if (item.root) entry.setAttribute('aria-description', 'Drag, or press Alt+Up or Alt+Down, to move this section with its subsections.' + (hasChildren ? ' Press Left or Right to collapse or expand it.' : ''));
    entry.addEventListener('keydown', event => {
      if (!event.altKey && hasChildren && ((event.key === 'ArrowLeft' && !collapsed.has(keys[index])) || (event.key === 'ArrowRight' && collapsed.has(keys[index])))) { event.preventDefault(); toggle.click(); return; }
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (!busy) moveOutlineSection(index, event.key === 'ArrowUp' ? -1 : 1);
    });
    entry.addEventListener('dragstart', event => {
      event.dataTransfer?.setData('application/x-lekh-section', String(index));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      entry.classList.add('dragging');
    });
    entry.addEventListener('dragend', () => {
      entry.classList.remove('dragging');
      for (const target of outline.querySelectorAll('.drop-before, .drop-after')) target.classList.remove('drop-before', 'drop-after');
    });
    entry.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('application/x-lekh-section')) return;
      event.preventDefault();
      const after = event.offsetY > entry.clientHeight / 2;
      entry.classList.toggle('drop-after', after);
      entry.classList.toggle('drop-before', !after);
    });
    entry.addEventListener('dragleave', () => entry.classList.remove('drop-before', 'drop-after'));
    entry.addEventListener('drop', event => {
      if (!event.dataTransfer?.types.includes('application/x-lekh-section')) return;
      const from = Number(event.dataTransfer.getData('application/x-lekh-section'));
      event.preventDefault();
      entry.classList.remove('drop-before', 'drop-after');
      if (!Number.isInteger(from) || busy) return;
      const after = event.offsetY > entry.clientHeight / 2;
      const target = after ? sectionEndIndex(outlineHeadings, index) : index;
      moveOutlineSectionTo(from, target);
    });
    entry.addEventListener('click', () => {
      if (activeTab?.preview && !activeTab.previewSource) {
        const preview = activeTab.viewport.querySelector<HTMLElement>('.document-preview')!;
        const used = new Map<string, number>();
        const anchor = outlineHeadings.slice(0, index + 1).map(heading => headingAnchor(heading.text, used)).at(-1);
        const target = [...preview.querySelectorAll<HTMLElement>('[id]')].find(candidate => candidate.id === anchor)
          ?? preview.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[index];
        if (target) { revealPublishingElement(target); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      } else if (mode === 'source') {
        const offset = markdown.split('\n').slice(0, item.line).join('\n').length + (item.line > 0 ? 1 : 0);
        source.focus();
        source.setSelectionRange(offset, offset);
        source.scrollTop = Math.max(0, item.line * 24 - 50);
      } else {
        const target = visualHeadingTargets()[index];
        if (target) { revealPublishingElement(target); target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      }
    });
    row.append(toggle, entry);
    outline.append(row);
  }
  if (!outline.childElementCount) outline.innerHTML = '<p class="empty-note">Add a heading to give your ideas a little structure.</p>';
  updateToolbar();
  if (activeTab?.preview) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { if (activeTab) refreshPreview(activeTab); }, 120);
  }
  if (!element('find-panel').hidden) scheduleSearch();
  writingAssistance?.schedule();
  learnPanel?.schedule();
}

function changed(content: string, record = true): void {
  if (content === markdown) return;
  if (mode === 'source' && record) {
    sourceUndo.push(markdown);
    if (sourceUndo.length > 100) sourceUndo.shift();
    sourceRedo.length = 0;
  }
  markdown = content;
  if (activeTab?.sideBySide) {
    activeTab.markdown = markdown;
    if (mode === 'source') syncVisual();
    else {
      mirrorSource(activeTab);
      sourceUndo.length = 0;
      sourceRedo.length = 0;
    }
  }
  update();
  scheduleDraft();
}

function scheduleDraft(): void {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(storeDraft, 700);
}

function storeDraft(): void {
  if (recovery.length) return;
  captureTab();
  try {
    const documents = tabs.filter(tab => tab.markdown !== tab.savedMarkdown).map(tab => ({ content: tab.markdown, name: tab.name }));
    if (documents.length) localStorage.setItem(draftKey, JSON.stringify({ documents }));
    else localStorage.removeItem(draftKey);
  } catch (error) { notify(`Your draft could not be stored for recovery. Save your file now. ${String(error)}`, true); }
}

function switchMode(next: 'visual' | 'source'): void {
  editorMenu.hide();
  setEditingView(next);
}

function useSource(): void {
  if (activeTab?.preview) {
    if (!activeTab.previewSource) setPreviewSource(true);
    mode = 'source';
    activeTab.mode = mode;
    updateToolbar();
    writingAssistance?.schedule();
  } else if (activeTab?.sideBySide) {
    mode = 'source';
    activeTab.mode = mode;
    updateToolbar();
    writingAssistance?.schedule();
  } else if (mode !== 'source') switchMode('source');
}

function editingAvailable(target?: EventTarget | null): boolean {
  const inPreview = target instanceof Element && Boolean(target.closest('.live-preview'));
  if (!activeTab?.preview || (activeTab.previewSource && !inPreview)) return true;
  notify('Preview is read-only. Return to editing or show Markdown beside the preview.');
  return false;
}

function updateToolbar(): void {
  if (!editor) return;
  const readerOnly = Boolean(activeTab?.preview && !activeTab.previewSource);
  for (const control of document.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
    '[data-group="style"] select, [data-group="text"] button, [data-group="paragraph"] button, [data-group="insert"] button, [data-group="insert-extra"] button, [data-action="undo"], [data-action="redo"], #alerts-menu button, #structure-menu button, #interactive-menu button',
  )) control.disabled = readerOnly;
  if (exportCheckedMarkdown !== markdown || exportCheckedDocumentId !== documentId) {
    exportCheckedMarkdown = markdown;
    exportCheckedDocumentId = documentId;
    rawInteractiveExportRequired = requiresInteractiveExport(markdown);
    interactiveExportRequired = rawInteractiveExportRequired;
    exportCheckPending = false;
    exportCheckError = '';
    exportCheckComplete = false;
    exportCheckRevision++;
  }
  if (!rawInteractiveExportRequired && !exportCheckPending && !exportCheckComplete && documentId &&
      /\[!INCLUDE\b|^zone_pivot_groups\s*:/im.test(markdown)) {
    exportCheckPending = true;
    clearTimeout(exportCheckTimer);
    const revision = exportCheckRevision;
    exportCheckTimer = setTimeout(() => {
      if (revision !== exportCheckRevision) return;
      exportCheckPending = false;
      void checkLocalVariantExportRestrictions();
    }, 250);
  }
  const restriction = element('export-restriction');
  restriction.hidden = !interactiveExportRequired && !exportCheckPending && !exportCheckError;
  document.querySelector('#export-menu [data-action="export-html"]')?.classList.toggle('recommended', interactiveExportRequired);
  restriction.textContent = exportCheckPending ? 'Checking local includes and variant configuration...' :
    exportCheckError || 'Tabbed examples and variants require HTML. Word and PDF are not supported for this document.';
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-action="export-docx"],[data-action="export-pdf"]')) {
    control.disabled = interactiveExportRequired || exportCheckPending || Boolean(exportCheckError);
    control.title = interactiveExportRequired ? interactiveExportMessage : exportCheckPending || exportCheckError ? restriction.textContent : control.textContent?.trim() ?? '';
    if (control.disabled) control.setAttribute('aria-describedby', 'export-restriction');
    else control.removeAttribute('aria-describedby');
  }
  const names: Record<string, string> = { bold: 'bold', italic: 'italic', strike: 'strike', code: 'code', bullet: 'bulletList', ordered: 'orderedList', task: 'taskList', quote: 'blockquote', codeblock: 'codeBlock', rule: 'horizontalRule' };
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-command]')) {
    const active = mode === 'visual' && editor.isActive(names[control.dataset.command!] ?? '');
    control.classList.toggle('active', active);
    control.setAttribute('aria-pressed', String(active));
    if (control.closest('#toolbar-overflow')) control.setAttribute('aria-checked', String(active));
  }
  const sourceLineStart = source.selectionStart === 0 ? 0 : source.value.lastIndexOf('\n', source.selectionStart - 1) + 1;
  const level = mode === 'visual'
    ? editor.getAttributes('heading').level
    : source.value.slice(sourceLineStart).match(/^ {0,3}(#{1,6})[ \t]+/)?.[1].length;
  element<HTMLSelectElement>('heading').value = String(level ?? 0);
  element('table-tools').hidden = mode !== 'visual' || !editor.isActive('table');
  const hasSelector = documentHasSelector();
  for (const control of document.querySelectorAll<HTMLButtonElement>('[data-action="insert:publishing-selector"]')) {
    const template = variantInsertionTemplate(hasSelector);
    control.querySelector('span')!.textContent = template.label;
    control.title = template.description;
    control.setAttribute('aria-description', control.title);
  }
  window.lekh.setEditorContext({
    mode, heading: Number(level ?? 0), inTable: mode === 'visual' && editor.isActive('table'),
    view: activeTab?.sideBySide ? 'split' : activeTab?.preview ? activeTab.previewReturnMode ?? mode : mode,
    preview: Boolean(activeTab?.preview), previewSource: Boolean(activeTab?.previewSource),
    hasVariantSelector: hasSelector, hasInteractivePublishing: interactiveExportRequired || exportCheckPending || Boolean(exportCheckError),
    formField: document.activeElement instanceof Element && Boolean(document.activeElement.closest('.publishing-field, .publishing-raw-editor')),
    active: mode === 'visual' ? Object.entries(names).filter(([, name]) => editor.isActive(name)).map(([command]) => command) : [],
  });
}

function invalidateExportCheck(): void {
  exportCheckedMarkdown = undefined;
  exportCheckRevision++;
  exportCheckPending = false;
  exportCheckError = '';
  exportCheckComplete = false;
  clearTimeout(exportCheckTimer);
  updateToolbar();
}

async function checkLocalVariantExportRestrictions(): Promise<void> {
  if (!documentId || rawInteractiveExportRequired || exportCheckPending || exportCheckComplete ||
      !/\[!INCLUDE\b|^zone_pivot_groups\s*:/im.test(markdown)) return;
  const id = documentId;
  const content = markdown;
  const revision = ++exportCheckRevision;
  exportCheckPending = true;
  exportCheckError = '';
  updateToolbar();
  try {
    const interactive = unwrap(await window.lekh.includesRequireInteractiveExport(id, content));
    if (revision === exportCheckRevision && id === documentId && content === markdown) {
      interactiveExportRequired = interactive;
    }
  } catch (error) {
    if (revision === exportCheckRevision && id === documentId && content === markdown) {
      exportCheckError = `Could not check included content for export: ${error instanceof Error ? error.message : String(error)}`;
    }
  } finally {
    if (revision === exportCheckRevision && id === documentId && content === markdown) {
      exportCheckPending = false;
      exportCheckComplete = true;
      updateToolbar();
    }
  }
}

function setHeading(value: number): void {
  if (!editingAvailable()) return;
  if (!Number.isInteger(value) || value < 0 || value > 6) throw new Error('Unsupported heading level.');
  if (mode === 'source') {
    const start = source.selectionStart === 0 ? 0 : source.value.lastIndexOf('\n', source.selectionStart - 1) + 1;
    const endOfLine = source.value.indexOf('\n', source.selectionEnd);
    const end = endOfLine < 0 ? source.value.length : endOfLine;
    const text = source.value.slice(start, end).replace(/^ {0,3}#{1,6}[ \t]+/, '');
    source.setRangeText(`${'#'.repeat(value)}${value ? ' ' : ''}${text}`, start, end, 'select');
    source.focus();
    changed(source.value);
  } else if (value === 0) editor.chain().focus().setParagraph().run();
  else {
    const level = ([1, 2, 3, 4, 5, 6] as const).find(item => item === value);
    if (level) editor.chain().focus().setHeading({ level }).run();
  }
  updateToolbar();
}

function insertParagraph(after: boolean): void {
  if (mode === 'source') {
    const start = source.selectionStart === 0 ? 0 : source.value.lastIndexOf('\n', source.selectionStart - 1) + 1;
    const endOfLine = source.value.indexOf('\n', source.selectionEnd);
    const end = endOfLine < 0 ? source.value.length : endOfLine;
    const position = after ? end : start;
    source.setRangeText('\n\n', position, position, 'end');
    source.setSelectionRange(after ? position + 2 : position, after ? position + 2 : position);
    changed(source.value);
    source.focus();
  } else {
    const { $from, from, to } = editor.state.selection;
    const position = $from.depth ? (after ? $from.after(1) : $from.before(1)) : (after ? to : from);
    editor.chain().focus().insertContentAt(position, { type: 'paragraph' }).setTextSelection(position + 1).run();
  }
}

function insertAdvanced(kind: string): void {
  const wasVisual = mode === 'visual';
  switchMode('source');
  if (wasVisual) source.setSelectionRange(source.value.length, source.value.length);
  if (kind === 'frontmatter') {
    if (/^(?:\uFEFF)?---\r?\n/.test(source.value)) throw new Error('This document already starts with a front-matter block. Edit it in Markdown view instead.');
    source.setSelectionRange(0, 0);
    insertSource('---\ntitle: Untitled\nauthor: ""\ndate: ""\n---\n\n');
  } else if (kind === 'math') insertSource('\n\n$$\nx^2 + y^2 = z^2\n$$\n\n');
  else if (kind === 'footnote') {
    let number = 1;
    while (source.value.includes(`[^${number}]`)) number++;
    const position = source.selectionStart;
    const marker = `[^${number}]`;
    const selected = source.value.slice(position, source.selectionEnd);
    const value = source.value.slice(0, position) + selected + marker + source.value.slice(source.selectionEnd);
    source.value = `${value}\n\n${marker}: Footnote text\n`;
    source.setSelectionRange(position + selected.length + marker.length, position + selected.length + marker.length);
    changed(source.value);
    source.focus();
  } else if (kind === 'reference') {
    let number = 1;
    while (source.value.includes(`[link-${number}]`)) number++;
    const position = source.selectionStart;
    const selected = source.value.slice(position, source.selectionEnd) || 'Link text';
    const marker = `[${selected.replace(/[[\]\\]/g, '\\$&')}][link-${number}]`;
    const value = source.value.slice(0, position) + marker + source.value.slice(source.selectionEnd);
    source.value = `${value}\n\n[link-${number}]: https://example.com\n`;
    source.setSelectionRange(position, position + marker.length);
    changed(source.value);
    source.focus();
  } else throw new Error('Unsupported insert command.');
  notify('Inserted in Markdown view. Math and footnotes remain source syntax; YAML is preserved as metadata rather than article text.');
}

function applyDocumentEdit(updated: string): void {
  if (mode === 'visual') editor.commands.setContent(updated, { contentType: 'markdown', emitUpdate: false });
  else source.value = updated;
  changed(updated);
}

function moveOutlineSectionTo(from: number, target: number): void {
  const tokens = parser.parse(markdown, {});
  const list = headings(markdown, tokens);
  if (!canMoveSection(list, from)) { notify('Headings inside lists, quotes, zones or tabbed examples move with their block.'); return; }
  const result = relocateSection(markdown, list, from, target, topLevelBlocks(tokens));
  if (result === undefined) { if (target !== from && target !== sectionEndIndex(list, from)) notify('A section cannot be moved inside itself or into a quote, list, table, zone or tabbed example.'); return; }
  applyDocumentEdit(result.markdown);
  focusOutlineLine(result.line);
  notify(`Moved section \u201c${list[from].displayText || 'Untitled heading'}\u201d. Press Ctrl+Z to undo.`);
}

function moveOutlineSection(index: number, direction: -1 | 1): void {
  const list = headings(markdown);
  if (!canMoveSection(list, index)) { notify('Headings inside lists, quotes, zones or tabbed examples move with their block.'); return; }
  const target = siblingTarget(list, index, direction);
  if (target === undefined) { notify(`This section is already the ${direction < 0 ? 'first' : 'last'} at its level.`); return; }
  moveOutlineSectionTo(index, target);
}

function focusOutlineLine(line: number): void {
  const index = headings(markdown).findIndex(item => item.line === line);
  element('outline').querySelector<HTMLButtonElement>(`.outline-entry[data-outline-index="${index}"]`)?.focus();
}

function documentHasSelector(): boolean {
  return Boolean(sharedVariantMetadataField(markdown)) || (mode === 'visual' ? documentVariantOptions(editor).length > 0 :
    publishingBlockRanges(markdown).some(block => block.kind === 'selector'));
}

function updateCursorPosition(): void {
  const status = element('cursor-position');
  status.hidden = mode !== 'source';
  if (status.hidden) return;
  const before = source.value.slice(0, source.selectionStart);
  const line = before.split('\n').length;
  status.textContent = `Ln ${line}, Col ${source.selectionStart - before.lastIndexOf('\n')}`;
}

/** Moves, duplicates or removes the top-level Visual block that contains the selection. */
function editBlock(operation: 'up' | 'down' | 'duplicate' | 'remove'): void {
  if (mode !== 'visual') throw new Error('Block commands work in Visual mode. Switch to Visual, place the cursor in a block and try again.');
  const { state } = editor;
  const { doc, selection } = state;
  const index = selection.$from.index(0);
  if (index >= doc.childCount) throw new Error('Place the cursor inside a block first.');
  const node = doc.child(index);
  let from = 0;
  for (let child = 0; child < index; child++) from += doc.child(child).nodeSize;
  const offset = selection.from - from;
  const wholeNode = selection instanceof NodeSelection && selection.from === from;
  const tr = closeHistory(state.tr);
  let target = from;
  if (operation === 'up' || operation === 'down') {
    const neighbor = operation === 'up' ? index - 1 : index + 1;
    if (neighbor < 0 || neighbor >= doc.childCount) { notify(`This block is already the ${operation === 'up' ? 'first' : 'last'} in the document.`); return; }
    const other = doc.child(neighbor);
    if (operation === 'up') {
      target = from - other.nodeSize;
      tr.replaceWith(target, from + node.nodeSize, Fragment.from([node, other]));
    } else {
      target = from + other.nodeSize;
      tr.replaceWith(from, from + node.nodeSize + other.nodeSize, Fragment.from([other, node]));
    }
  } else if (operation === 'duplicate') {
    target = from + node.nodeSize;
    tr.insert(target, node.copy(node.content));
  } else {
    if (doc.childCount === 1) tr.replaceWith(0, doc.content.size, state.schema.nodes.paragraph.create());
    else tr.delete(from, from + node.nodeSize);
    target = Math.min(from, tr.doc.content.size);
    tr.setSelection(Selection.near(tr.doc.resolve(target), index === doc.childCount - 1 ? -1 : 1));
  }
  if (operation !== 'remove') {
    tr.setSelection(wholeNode || node.isAtom ? NodeSelection.create(tr.doc, target) : Selection.near(tr.doc.resolve(Math.min(target + offset, tr.doc.content.size))));
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  if (operation === 'remove') notify('Block removed. Press Ctrl+Z to undo.');
}

function updateSlashMenu(): void {
  const menu = slashMenu;
  if (!menu) return;
  const { selection } = editor.state;
  const { $from } = selection;
  const text = $from.parent.textContent;
  const match = /^\/([\p{L}\p{N} -]{0,24})$/u.exec(text);
  const eligible = mode === 'visual' && !busy && editor.isEditable && editor.isFocused && selection.empty && $from.depth === 1 &&
    $from.parent.type.name === 'paragraph' && $from.parentOffset === text.length && match;
  const key = `${$from.start()}:${text}`;
  if (!eligible || slashDismissed === key) { menu.close(); if (!eligible) slashDismissed = ''; return; }
  const coordinates = editor.view.coordsAtPos($from.pos);
  menu.update(match[1], new DOMRect(coordinates.left, coordinates.top, 0, coordinates.bottom - coordinates.top));
}

function runSlashEntry(entry: CommandEntry): void {
  slashMenu?.close();
  const { $from } = editor.state.selection;
  if (/^\//.test($from.parent.textContent)) editor.chain().focus().deleteRange({ from: $from.start(), to: $from.end() }).run();
  void runAction(entry.id);
}

function dismissSlashMenu(): void {
  const { $from } = editor.state.selection;
  slashDismissed = `${$from.start()}:${$from.parent.textContent}`;
  slashMenu?.close();
}

let blockToolbar: HTMLElement | undefined;
let blockToolbarFrame = 0;
let blockToolbarTyping = false;

function scheduleBlockToolbar(): void {
  cancelAnimationFrame(blockToolbarFrame);
  blockToolbarFrame = requestAnimationFrame(positionBlockToolbar);
}

/** Small floating toolbar with move, duplicate and remove actions for the top-level block holding the cursor. */
function positionBlockToolbar(): void {
  const toolbar = blockToolbar;
  if (!toolbar) return;
  const hide = () => { toolbar.hidden = true; };
  if (mode !== 'visual' || busy || blockToolbarTyping || !editor.isEditable || !editor.view.hasFocus() || slashMenu?.isOpen ||
    commandPalette.isOpen || document.querySelector('dialog[open]')) return hide();
  const { doc, selection } = editor.state;
  const index = selection.$from.index(0);
  if (index >= doc.childCount || (doc.childCount === 1 && !doc.firstChild!.textContent && doc.firstChild!.type.name === 'paragraph')) return hide();
  let from = 0;
  for (let child = 0; child < index; child++) from += doc.child(child).nodeSize;
  const dom = editor.view.nodeDOM(from);
  const canvas = element('canvas').getBoundingClientRect();
  if (!(dom instanceof HTMLElement)) return hide();
  const rect = dom.getBoundingClientRect();
  if (rect.bottom < canvas.top || rect.top > canvas.bottom) return hide();
  toolbar.querySelector<HTMLButtonElement>('[data-action="block:up"]')!.disabled = index === 0;
  toolbar.querySelector<HTMLButtonElement>('[data-action="block:down"]')!.disabled = index === doc.childCount - 1;
  toolbar.hidden = false;
  const width = toolbar.offsetWidth;
  const height = toolbar.offsetHeight;
  const top = Math.min(Math.max(canvas.top + 4, rect.top - height - 4), canvas.bottom - height - 4);
  const left = Math.min(Math.max(canvas.left + 4, rect.right - width), canvas.right - width - 12);
  toolbar.style.top = `${top}px`;
  toolbar.style.left = `${left}px`;
}

function createBlockToolbar(): void {
  const toolbar = document.createElement('div');
  toolbar.id = 'block-toolbar';
  toolbar.className = 'block-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Block actions');
  toolbar.hidden = true;
  const buttons: [string, Icon, string][] = [
    ['block:up', 'up', 'Move block up (Alt+Shift+Up)'],
    ['block:down', 'down', 'Move block down (Alt+Shift+Down)'],
    ['block:duplicate', 'copy', 'Duplicate block'],
    ['block:remove', 'delete', 'Remove block'],
  ];
  toolbar.innerHTML = buttons.map(([action, name, label]) => `<button type="button" data-action="${action}" aria-label="${label}" title="${label}" tabindex="-1">${icon(name)}</button>`).join('');
  toolbar.addEventListener('mousedown', event => event.preventDefault());
  document.body.append(toolbar);
  blockToolbar = toolbar;
  element('canvas').addEventListener('scroll', scheduleBlockToolbar, true);
  window.addEventListener('resize', scheduleBlockToolbar);
  element('canvas').addEventListener('mousedown', () => { blockToolbarTyping = false; scheduleBlockToolbar(); });
  element('canvas').addEventListener('keydown', event => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.tiptap')) return;
    const typing = !event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || event.key === 'Enter' || event.key === 'Backspace' || event.key === 'Delete');
    if (typing !== blockToolbarTyping) { blockToolbarTyping = typing; scheduleBlockToolbar(); }
  });
}

function insertContents(): void {
  if (hasMarkedTableOfContents(markdown)) {
    const updated = updateTableOfContents(markdown);
    applyDocumentEdit(updated);
    notify('Table of contents updated. Surrounding Markdown is unchanged.');
    return;
  }
  const contents = `${tableOfContents(markdown)}\n\n`;
  if (mode === 'source') insertSource(contents);
  else editor.chain().focus().insertContent(contents, { contentType: 'markdown' }).run();
  notify('Inserted a marked table of contents. Use the same button to refresh it after changing headings.');
}

async function save(saveAs = false): Promise<boolean> {
  const snapshot = markdown;
  const result = unwrap(await window.lekh.save(documentId, snapshot, saveAs));
  if (!result) return false;
  documentPath = result.path;
  documentName = result.path.split(/[\\/]/).at(-1)!;
  savedMarkdown = snapshot;
  update();
  storeDraft();
  await refreshRecent();
  refreshPublishingFiles();
  notify(`${documentName} saved`);
  return true;
}

function refreshPublishingFiles(id?: string): void {
  for (const tab of tabs) {
    if (id && tab.id !== id) continue;
    if (!/\[!INCLUDE\b/i.test(tab.markdown) && !sharedVariantMetadataField(tab.markdown)) continue;
    if (sharedVariantMetadataField(tab.markdown)) refreshProjectVariantLabels(tab, true);
    tab.previewMarkdown = undefined;
    refreshPreview(tab);
    window.dispatchEvent(new CustomEvent('lekh-publishing-refresh', { detail: tab.id }));
  }
  if ((!id || id === documentId) && (/\[!INCLUDE\b/i.test(markdown) || sharedVariantMetadataField(markdown))) invalidateExportCheck();
}

let zoomRevision = 0;
async function refreshZoom(command?: 'in' | 'out' | 'reset'): Promise<void> {
  const revision = ++zoomRevision;
  const factor = unwrap(await window.lekh.zoom(command));
  if (revision !== zoomRevision) return;
  const percentage = Math.round(factor * 100);
  element('zoom-reset').textContent = `${percentage}%`;
  element<HTMLButtonElement>('zoom-out').disabled = percentage <= 50;
  element<HTMLButtonElement>('zoom-in').disabled = percentage >= 300;
}
let zoomTimer: ReturnType<typeof setTimeout>;
window.addEventListener('resize', () => {
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    void refreshZoom().catch(error => notify(`Zoom could not be refreshed: ${String(error)}`, true));
  }, 100);
});

async function mayDiscard(): Promise<boolean> {
  if (markdown === savedMarkdown) return true;
  const choice = unwrap(await window.lekh.confirmUnsaved(documentName));
  if (choice === 'cancel') return false;
  return choice === 'save' ? save() : true;
}

async function refreshRecent(): Promise<void> {
  const files = unwrap(await window.lekh.recent());
  const recent = element('recent');
  recent.replaceChildren();
  for (const file of files) {
    const control = document.createElement('button');
    control.className = 'recent-file';
    control.textContent = file.split(/[\\/]/).at(-1)!;
    control.title = file;
    control.addEventListener('click', () => { void run(async () => open(file)); });
    recent.append(control);
  }
  if (!files.length) recent.innerHTML = '<p class="empty-note">Your opened files will appear here.</p>';
  element<HTMLButtonElement>('clear-recent').disabled = files.length === 0;
  element('recent-count').textContent = `(${files.length})`;
}

async function open(file?: string): Promise<void> {
  const opened = unwrap(await window.lekh.open(file));
  if (!opened) return;
  addTab(opened.id, opened.content, opened.path.split(/[\\/]/).at(-1)!, opened.path);
  await refreshRecent();
}

let pendingExternalOpen = false;

async function openPending(): Promise<void> {
  const results = unwrap(await window.lekh.openPending());
  const errors: string[] = [];
  for (const result of results) {
    if (!result.ok) { errors.push(result.error); continue; }
    const opened = result.value;
    addTab(opened.id, opened.content, opened.path.split(/[\\/]/).at(-1)!, opened.path);
  }
  if (results.length) await refreshRecent();
  if (errors.length) throw new Error(errors.join('\n'));
}

async function runAction(action: string): Promise<void> {
  const edits = action.startsWith('format:') || action.startsWith('heading:') || action.startsWith('insert:') || action.startsWith('block:') ||
    ['undo', 'redo', 'paste-markdown', 'paste-image', 'link', 'image', 'table', 'row', 'column', 'delete-row', 'delete-column', 'delete-table'].includes(action);
  if (edits && !editingAvailable()) return;
  const focused = document.activeElement;
  if (action === 'command-palette') { commandPalette.open(); return; }
  if ((action === 'undo' || action === 'redo') && mode === 'visual' && !busy && editor.isEditable &&
    (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) && focused.closest('.publishing-field')) {
    if (action === 'undo') editor.commands.undo(); else editor.commands.redo();
    return;
  }
  const id = documentId;
  await run(async () => dispatch(action));
  if ((action.startsWith('insert:callout-') || action.startsWith('insert:publishing-') || action.startsWith('block:')) && documentId === id && mode === 'visual' &&
    !busy && editor.isEditable && !document.querySelector('dialog[open]') &&
    !(document.activeElement instanceof Element && document.activeElement.closest('.publishing-field'))) editor.view.focus();
}

async function run(operation: () => Promise<unknown>): Promise<void> {
  if (busy) { notify('Please wait for the current operation to finish.'); return; }
  const focusedTab = document.activeElement === source ? activeTab : undefined;
  busy = true;
  app.setAttribute('aria-busy', 'true');
  element<HTMLButtonElement>('theme-toggle').disabled = true;
  for (const tab of tabs) {
    tab.editor.setEditable(false, false);
    setPublishingEditable(tab.editor, false);
    tab.source.readOnly = true;
  }
  if (!tabs.length) { editor.setEditable(false, false); setPublishingEditable(editor, false); source.readOnly = true; }
  try { await operation(); }
  catch (error) { notify(error instanceof Error ? error.message : String(error), true); }
  finally {
    busy = false;
    app.setAttribute('aria-busy', 'false');
    element<HTMLButtonElement>('theme-toggle').disabled = false;
    for (const tab of tabs) {
      tab.editor.setEditable(true, false);
      setPublishingEditable(tab.editor, true);
      tab.source.readOnly = false;
    }
    if (!tabs.length) { editor.setEditable(true, false); setPublishingEditable(editor, true); source.readOnly = false; }
    if (focusedTab && focusedTab === activeTab && source.hidden && mode === 'visual') {
      const scroll = visualScroll(focusedTab);
      const top = scroll.scrollTop;
      editor.view.focus();
      scroll.scrollTop = top;
    }
    if (pendingExternalOpen) {
      pendingExternalOpen = false;
      void run(openPending);
    }
  }
}

function insertSource(before: string, after = ''): void {
  const start = source.selectionStart;
  const end = source.selectionEnd;
  const selected = source.value.slice(start, end);
  source.setRangeText(before + selected + after, start, end, 'select');
  source.focus();
  changed(source.value);
}

function insertEmbeddedImage(image: string): void {
  if (new TextEncoder().encode(markdown + image).length > 10 * 1024 * 1024) throw new Error('This image would make your document exceed the 10 MB limit. Choose a smaller image.');
  if (mode === 'visual') editor.chain().focus().setImage({ src: image, alt: 'Image' }).run();
  else {
    source.setRangeText(`![Image](${image})`, source.selectionStart, source.selectionEnd, 'end');
    changed(source.value);
    source.focus();
  }
}

async function chooseImageStorage(image: string): Promise<void> {
  const dialog = element<HTMLDialogElement>('image-storage-dialog');
  const id = documentId;
  const assets = dialog.querySelector<HTMLInputElement>('[value="assets"]')!;
  assets.disabled = !documentPath;
  dialog.querySelector<HTMLInputElement>('[value="embedded"]')!.checked = true;
  dialog.returnValue = '';
  const choice = new Promise<string>(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  dialog.showModal();
  if (await choice !== 'insert') return;
  if (id !== documentId) throw new Error('The active document changed. Insert the image again in the intended document.');
  const storage = assets.checked ? 'assets' : 'embedded';
  const value = unwrap(await window.lekh.storeImage(id, image, storage));
  insertEmbeddedImage(value);
}

function format(command: string): void {
  if (!editingAvailable()) return;
  if (mode === 'source') {
    const syntax: Record<string, [string, string]> = {
      bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], code: ['`', '`'],
      bullet: ['\n- ', ''], ordered: ['\n1. ', ''], task: ['\n- [ ] ', ''], quote: ['\n> ', ''],
      codeblock: ['\n```\n', '\n```\n'], rule: ['\n\n---\n\n', ''],
    };
    const pair = syntax[command];
    if (pair) insertSource(...pair);
    return;
  }
  const chain = editor.chain().focus();
  switch (command) {
    case 'bold': chain.toggleBold().run(); break;
    case 'italic': chain.toggleItalic().run(); break;
    case 'strike': chain.toggleStrike().run(); break;
    case 'code': chain.toggleCode().run(); break;
    case 'bullet': chain.toggleBulletList().run(); break;
    case 'ordered': chain.toggleOrderedList().run(); break;
    case 'task': chain.toggleTaskList().run(); break;
    case 'quote': chain.toggleBlockquote().run(); break;
    case 'codeblock': chain.toggleCodeBlock().run(); break;
    case 'rule': chain.setHorizontalRule().run(); break;
    case 'clear': chain.unsetAllMarks().clearNodes().run(); break;
  }
  updateToolbar();
}

function showLinkDialog(link?: HTMLAnchorElement): void {
  const dialog = element<HTMLDialogElement>('link-dialog');
  if (dialog.open) return;
  let from = mode === 'source' ? source.selectionStart : editor.state.selection.from;
  let to = mode === 'source' ? source.selectionEnd : editor.state.selection.to;
  let existing = false;
  if (mode === 'visual') {
    const position = link ? editor.view.posAtDOM(link, 0) : from;
    const range = getMarkRange(editor.state.doc.resolve(position), editor.schema.marks.link);
    if (range && (link || to <= range.to)) {
      ({ from, to } = range);
      existing = true;
      editor.commands.setTextSelection(range);
    }
  }
  const label = mode === 'source' ? source.value.slice(from, to) : editor.state.doc.textBetween(from, to);
  linkSelection = { documentId, mode, from, to, doc: editor.state.doc, content: markdown, existing, label };
  element('link-title').textContent = existing ? 'Edit link' : 'Add a link';
  element('link-submit').textContent = existing ? 'Save changes' : 'Insert link';
  element('link-remove').hidden = !existing;
  element<HTMLInputElement>('link-label').value = label;
  element<HTMLInputElement>('link-url').value = existing ? String(editor.getAttributes('link').href ?? '') : 'https://';
  element('link-error').hidden = true;
  dialog.showModal();
  element<HTMLInputElement>('link-label').focus();
}

async function dispatch(action: string): Promise<void> {
  editorMenu.hide();
  closeDropdowns();
  if (action.startsWith('theme:')) {
    const value = action.slice(6);
    if (!isTheme(value)) throw new Error('Unsupported color theme.');
    await applyTheme(value);
    return;
  }
  if (action.startsWith('format:')) { format(action.slice(7)); return; }
  if (action.startsWith('heading:')) { setHeading(Number(action.slice(8))); return; }
  if (action.startsWith('insert:')) {
    const kind = action.slice(7);
    if (await insertPublishingBlock(kind)) return;
    if (kind === 'before' || kind === 'after') insertParagraph(kind === 'after');
    else if (kind === 'toc') insertContents();
    else if (kind === 'mermaid') {
      const template = 'flowchart LR\n  A[Start] --> B[Write something]';
      if (mode === 'visual') {
        const inserted = editor.chain().focus()
          .command(({ tr }) => { closeHistory(tr); return true; })
          .insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: template }] })
          .run();
        if (!inserted) throw new Error('The Mermaid diagram could not be inserted at the current selection.');
      } else {
        insertSource(`\n\`\`\`mermaid\n${template}\n\`\`\`\n`);
        if (!activeTab?.preview && !activeTab?.sideBySide) togglePreview();
      }
    }
    else insertAdvanced(kind);
    return;
  }
  if (action.startsWith('block:')) {
    const operation = action.slice(6);
    if (operation !== 'up' && operation !== 'down' && operation !== 'duplicate' && operation !== 'remove') throw new Error('Unsupported block command.');
    editBlock(operation);
    return;
  }
  switch (action) {
    case 'command-palette': commandPalette.open(); break;
    case 'revoke-image-folder': {
      unwrap(await window.lekh.revokeImageFolder(documentId));
      invalidateExportCheck();
      refreshLocalImages(documentId);
      for (const tab of tabs) {
        if (tab.id !== documentId) continue;
        refreshProjectVariantLabels(tab, true);
        tab.previewMarkdown = undefined;
        refreshPreview(tab);
      }
      learnPanel?.refresh();
      notify('Project-folder image access has been stopped for this document.');
      break;
    }
    case 'allow-image-folder': {
      if (unwrap(await window.lekh.allowImageFolder(documentId))) {
        refreshPublishingFiles();
        refreshLocalImages(documentId);
        invalidateExportCheck();
        learnPanel?.refresh();
        notify('Project images and variant labels are allowed within the selected folder for this document and session.');
      }
      break;
    }
    case 'writing-assistance': writingAssistance?.open(); break;
    case 'learn-checks': learnPanel?.open(); break;
    case 'document-stats': {
      const words = wordCount(markdown);
      const tokens = parser.parse(markdown, {});
      const paragraphs = tokens.filter(token => token.type === 'paragraph_open').length;
      const headingCount = tokens.filter(token => token.type === 'heading_open').length;
      notify(`${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} \u00b7 ${markdown.length.toLocaleString()} characters \u00b7 ${paragraphs.toLocaleString()} ${paragraphs === 1 ? 'paragraph' : 'paragraphs'} \u00b7 ${headingCount.toLocaleString()} ${headingCount === 1 ? 'heading' : 'headings'} \u00b7 about ${Math.max(1, Math.ceil(words / 220))} min read`);
      break;
    }
    case 'edit-split': setEditingView('split'); break;
    case 'side-by-side': setEditingView(activeTab?.sideBySide && !activeTab.preview ? 'visual' : 'split'); break;
    case 'split': openSplit(); break;
    case 'preview': togglePreview(); break;
    case 'preview-source':
      if (!activeTab?.preview) throw new Error('Open Preview before showing Markdown beside it.');
      setPreviewSource(!activeTab.previewSource);
      break;
    case 'unsplit': unsplit(); break;
    case 'paste-image': {
      const image = unwrap(await window.lekh.readClipboardImage());
      if (!image) throw new Error('The clipboard has no image to paste. Copy an image or take a screenshot first.');
      await chooseImageStorage(image);
      break;
    }
    case 'copy-image': {
      const source = contextImageSource ?? editor.getAttributes('image').src;
      if (typeof source !== 'string' || !source) throw new Error('Select an image to copy.');
      unwrap(await window.lekh.copyImage(documentId, source));
      notify('Image copied to the clipboard.');
      break;
    }
    case 'copy-document':
      unwrap(await window.lekh.writeClipboard(markdown));
      break;
    case 'copy-markdown': {
      const selected = selectionMarkdown();
      if (!selected) throw new Error('Select text to copy as Markdown.');
      unwrap(await window.lekh.writeClipboard(selected));
      break;
    }
    case 'paste-markdown': {
      const text = unwrap(await window.lekh.readClipboard());
      if (!text) throw new Error('The clipboard has no text to paste.');
      if (mode === 'source') {
        source.setRangeText(text, source.selectionStart, source.selectionEnd, 'end');
        changed(source.value);
        source.focus();
      }
      else editor.chain().focus().insertContent(text, { contentType: 'markdown' }).run();
      break;
    }
    case 'new':
      await newTab();
      break;
    case 'open': await open(); break;
    case 'save': await save(); break;
    case 'save-as': await save(true); break;
    case 'zoom-in': await refreshZoom('in'); break;
    case 'zoom-out': await refreshZoom('out'); break;
    case 'zoom-reset': await refreshZoom('reset'); break;
    case 'clear-recent':
      unwrap(await window.lekh.clearRecent());
      await refreshRecent();
      notify('Recent file history cleared. Your documents have not been deleted.');
      break;
    case 'save-all': {
      captureTab();
      const originalId = documentId;
      for (const tab of tabs) {
        if (tab.markdown === tab.savedMarkdown) continue;
        activateTab(tab.id);
        if (!await save()) return;
      }
      activateTab(originalId);
      break;
    }
    case 'close-tab': await closeTab(documentId); break;
    case 'next-tab':
    case 'previous-tab': {
      const groups = groupTabs(tabs.map(tab => tab.id), pairs);
      const index = groups.findIndex(group => group.documentIds.includes(documentId));
      activateTab(groups[(index + (action === 'next-tab' ? 1 : groups.length - 1)) % groups.length].activeId);
      break;
    }
    case 'export-docx':
    case 'export-pdf':
    case 'export-html': {
      const format = action === 'export-pdf' ? 'pdf' : action === 'export-html' ? 'html' : 'docx';
      const file = unwrap(await window.lekh.exportDocument(documentId, markdown, format));
      if (file) notify(`Exported successfully: ${file}`);
      break;
    }
    case 'close':
      captureTab();
      for (const tab of tabs) {
        if (tab.markdown === tab.savedMarkdown) continue;
        activateTab(tab.id);
        if (!await mayDiscard()) return;
      }
      finishClose();
      break;
    case 'visual': switchMode('visual'); break;
    case 'source': switchMode('source'); break;
    case 'mode': switchMode(mode === 'visual' ? 'source' : 'visual'); break;
    case 'focus': setFocusMode(!document.body.classList.contains('focus-mode')); break;
    case 'sidebar':
      if (document.body.classList.contains('focus-mode')) {
        sidebarHidden = false;
        setFocusMode(false);
      } else {
        sidebarHidden = !sidebarHidden;
        updateSidebar();
      }
      try { localStorage.setItem(sidebarKey, String(sidebarHidden)); }
      catch (error) { notify(`Sidebar changed, but could not be remembered: ${String(error)}`, true); }
      break;
    case 'theme':
      await applyTheme(themes[(themes.findIndex(option => option.id === theme) + 1) % themes.length].id);
      break;
    case 'find':
      setFindOpen(element('find-panel').hidden);
      break;
    case 'find-close': setFindOpen(false); break;
    case 'find-next': await navigateSearch(); break;
    case 'find-previous': await navigateSearch(true); break;
    case 'replace-one': await replaceFound(false); break;
    case 'replace-all': await replaceFound(true); break;
    case 'link': showLinkDialog(); break;
    case 'image': {
      const image = unwrap(await window.lekh.insertImage());
      if (image) await chooseImageStorage(image);
      break;
    }
    case 'table':
      if (element<HTMLDialogElement>('table-dialog').open) break;
      tableDocumentId = documentId;
      element<HTMLInputElement>('table-columns').value = '3';
      element<HTMLInputElement>('table-rows').value = '4';
      element('table-error').hidden = true;
      element<HTMLDialogElement>('table-dialog').showModal();
      break;
    case 'row': editor.chain().focus().addRowAfter().run(); break;
    case 'column': editor.chain().focus().addColumnAfter().run(); break;
    case 'delete-row': editor.chain().focus().deleteRow().run(); break;
    case 'delete-column': editor.chain().focus().deleteColumn().run(); break;
    case 'delete-table': editor.chain().focus().deleteTable().run(); break;
    case 'undo':
      if (mode === 'visual') editor.chain().focus().undo().run();
      else if (sourceUndo.length) {
        sourceRedo.push(markdown);
        source.value = sourceUndo.pop()!;
        changed(source.value, false);
        source.focus();
      }
      break;
    case 'redo':
      if (mode === 'visual') editor.chain().focus().redo().run();
      else if (sourceRedo.length) {
        sourceUndo.push(markdown);
        source.value = sourceRedo.pop()!;
        changed(source.value, false);
        source.focus();
      }
      break;
    case 'help': element<HTMLDialogElement>('help-dialog').showModal(); break;
    case 'shortcuts': element<HTMLDialogElement>('shortcuts-dialog').showModal(); break;
    case 'recover':
      while (recovery.length) {
        const draft = recovery[0];
        const id = unwrap(await window.lekh.newDocument());
        addTab(id, draft.content, `Recovered - ${draft.name}`, null, false);
        recovery.shift();
      }
      element('recovery-banner').hidden = true;
      storeDraft();
      notify('Drafts recovered in new unsaved tabs. Save them to keep them.');
      break;
    case 'dismiss-recovery':
      recovery = [];
      element('recovery-banner').hidden = true;
      storeDraft();
      break;
  }
}

function activateEventPane(event: Event): void {
  if (busy || !(event.target instanceof HTMLElement)) return;
  const id = event.target.closest<HTMLElement>('.document-pane')?.dataset.documentId;
  if (id && id !== documentId) activateTab(id);
  if (activeTab?.sideBySide && !activeTab.preview) {
    const next = event.target.closest('.source-surface') ? 'source' : event.target.closest('.visual-surface') ? 'visual' : null;
    if (next && next !== mode) {
      mode = next;
      activeTab.mode = next;
      updateToolbar();
      writingAssistance?.schedule();
    }
  }
  if (event.type === 'contextmenu' || event.type === 'focusin') updateToolbar();
}
element('canvas').addEventListener('pointerdown', activateEventPane, true);
element('canvas').addEventListener('focusin', activateEventPane, true);
element('canvas').addEventListener('contextmenu', activateEventPane, true);
element<HTMLInputElement>('preview-source').addEventListener('change', event => {
  if (!busy) setPreviewSource((event.target as HTMLInputElement).checked);
});
for (const id of ['find-text', 'replace-text', 'find-case', 'find-word', 'find-regex']) {
  element(id).addEventListener('input', scheduleSearch);
}
element('find-text').addEventListener('keydown', event => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void run(async () => navigateSearch(event.shiftKey));
});
window.addEventListener('resize', () => { if (!element('find-panel').hidden) paintSearch(); });
element('canvas').addEventListener('input', event => {
  if (!(event.target instanceof HTMLTextAreaElement) || !event.target.classList.contains('document-source')) return;
  activateEventPane(event);
  changed(event.target.value);
});
element('canvas').addEventListener('keydown', event => {
  if (!(event.target instanceof HTMLTextAreaElement) || !event.target.classList.contains('document-source')) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    void run(async () => dispatch(event.shiftKey ? 'redo' : 'undo'));
  }
  if (event.key === 'Tab' && !busy) {
    event.preventDefault();
    insertSource('  ');
  }
});
for (const type of ['keyup', 'mouseup', 'focusin', 'select'] as const) {
  element('canvas').addEventListener(type, event => { if (event.target === source) updateCursorPosition(); });
}
document.querySelector('.toolbar')!.addEventListener('mousedown', event => {
  if ((event.target as HTMLElement).closest('button')) event.preventDefault();
});
document.querySelector('header .command-search')!.addEventListener('mousedown', event => event.preventDefault());
document.addEventListener('click', event => {
  const target = event.target as HTMLElement;
  const command = target.closest<HTMLElement>('[data-command]')?.dataset.command;
  if (command) {
    closeDropdowns();
    if (!busy) format(command);
    return;
  }
  const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
  if (action && dropdownIds.includes(action)) {
    const expanded = !element(action).hidden;
    closeDropdowns();
    if (!expanded) {
      element(action).hidden = false;
      positionViewMenu();
      target.closest('button')!.setAttribute('aria-expanded', 'true');
      if (action === 'export-menu') void checkLocalVariantExportRestrictions();
    }
    return;
  }
  if (action) void runAction(action);
  else if (!target.closest('.dropdown')) closeDropdowns();
  const link = target.closest<HTMLAnchorElement>('.tiptap a, .document-preview a');
  if (link) {
    event.preventDefault();
    activateEventPane(event);
    void run(async () => {
      const href = link.getAttribute('href') ?? '';
      const publishing = link.closest('.publishing-block-content');
      const navigate = event.ctrlKey || event.metaKey || Boolean(link.closest('[data-lekh-contents], .contents-node'));
      if (href.startsWith('#') && (navigate || link.closest('.document-preview') || publishing)) {
        const anchor = decodeURIComponent(href.slice(1));
        const used = new Map<string, number>();
        const index = headings(markdown).findIndex(item => headingAnchor(item.text, used) === anchor);
        const container = link.closest('.document-preview') ?? visual;
        const rendered = [...(publishing ?? container).querySelectorAll<HTMLElement>('[id]')].find(item => item.id === anchor);
        synchronizeVisualHeadingAnchors();
        const visualTarget = index < 0 ? undefined : visualHeadingTargets()[index];
        const heading = container === visual ? visualTarget ?? rendered : rendered ?? (index < 0 ? undefined : container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[index]);
        if (!heading) throw new Error('That heading was not found. Reinsert the table of contents after changing headings.');
        revealPublishingElement(heading);
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (navigate) unwrap(await window.lekh.openExternal(href));
      else if (publishing) notify('Use Edit source to change links in this block. Ctrl+click opens web links.');
      else if (link.closest('.document-preview')) notify('Switch to Visual to edit this link. Ctrl+click opens it.');
      else showLinkDialog(link);
    });
  }
});
element<HTMLSelectElement>('heading').addEventListener('change', event => {
  if (busy) return;
  setHeading(Number((event.target as HTMLSelectElement).value));
});
element('canvas').addEventListener('select', event => { if (event.target === source) updateToolbar(); }, true);
element('recent-toggle').addEventListener('click', () => {
  recentExpanded = !recentExpanded;
  updateRecentDisclosure();
  try { localStorage.setItem(recentExpandedKey, String(recentExpanded)); }
  catch (error) { notify(`Recent Files changed, but could not be remembered: ${String(error)}`, true); }
});
const sidebarResizer = element('sidebar-resizer');
let sidebarDrag: { pointerId: number; startX: number; startWidth: number } | undefined;
sidebarResizer.addEventListener('pointerdown', event => {
  if (busy || event.button !== 0) return;
  event.preventDefault();
  sidebarDrag = { pointerId: event.pointerId, startX: event.clientX, startWidth: element('sidebar').getBoundingClientRect().width };
  sidebarResizer.setPointerCapture(event.pointerId);
  sidebarResizer.focus();
  document.body.classList.add('resizing-sidebar');
});
sidebarResizer.addEventListener('pointermove', event => {
  if (!sidebarDrag || event.pointerId !== sidebarDrag.pointerId) return;
  preferredSidebarWidth = sidebarWidth(sidebarDrag.startWidth + event.clientX - sidebarDrag.startX, window.innerWidth);
  updateSidebarWidth();
});
sidebarResizer.addEventListener('lostpointercapture', () => {
  if (!sidebarDrag) return;
  sidebarDrag = undefined;
  document.body.classList.remove('resizing-sidebar');
  rememberSidebarWidth();
});
sidebarResizer.addEventListener('pointerup', event => {
  if (sidebarResizer.hasPointerCapture(event.pointerId)) sidebarResizer.releasePointerCapture(event.pointerId);
});
sidebarResizer.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (busy) return;
  const width = sidebarWidth(preferredSidebarWidth, window.innerWidth);
  preferredSidebarWidth = sidebarWidth(event.key === 'Home' ? MIN_SIDEBAR_WIDTH : event.key === 'End' ? MAX_SIDEBAR_WIDTH : width + (event.key === 'ArrowLeft' ? -10 : 10), window.innerWidth);
  updateSidebarWidth();
  rememberSidebarWidth();
});
sidebarResizer.addEventListener('dblclick', () => {
  if (busy) return;
  preferredSidebarWidth = DEFAULT_SIDEBAR_WIDTH;
  updateSidebarWidth();
  rememberSidebarWidth();
});
window.addEventListener('resize', updateSidebarWidth);
element<HTMLFormElement>('table-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    try {
      if (documentId !== tableDocumentId) throw new Error('The active document changed. Cancel and reopen Insert table in the intended tab.');
      const rows = element<HTMLInputElement>('table-rows').valueAsNumber;
      const columns = element<HTMLInputElement>('table-columns').valueAsNumber;
      validateTableSize(rows, columns);
      if (mode === 'visual') {
        if (!editor.chain().focus().insertTable({ rows, cols: columns, withHeaderRow: true }).run()) {
          throw new Error('A table cannot be inserted here. Choose a paragraph outside an existing table.');
        }
      } else {
        source.setRangeText(tableMarkdown(rows, columns), source.selectionStart, source.selectionEnd, 'end');
        changed(source.value);
        source.focus();
      }
      element<HTMLDialogElement>('table-dialog').close('insert');
    } catch (error) {
      element('table-error').textContent = error instanceof Error ? error.message : String(error);
      element('table-error').hidden = false;
      throw error;
    }
  });
});
element('table-cancel').addEventListener('click', () => {
  element<HTMLDialogElement>('table-dialog').close('cancel');
});
element<HTMLFormElement>('split-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    try {
      if (documentId !== splitDocumentId) throw new Error('The active file changed. Cancel and reopen Split with... in the intended tab.');
      const target = event.submitter;
      if (!(target instanceof HTMLButtonElement) || !target.dataset.documentId) throw new Error('Choose an open document preview to create a split.');
      const pair = createPair(tabs.map(tab => tab.id), pairs, documentId, target.dataset.documentId);
      captureTab();
      pairs.push(pair);
      showWorkspace();
      update();
      element<HTMLDialogElement>('split-dialog').close('split');
    } catch (error) {
      element('split-error').textContent = error instanceof Error ? error.message : String(error);
      element('split-error').hidden = false;
      throw error;
    }
  });
});
element('split-cancel').addEventListener('click', () => element<HTMLDialogElement>('split-dialog').close('cancel'));
element('split-dialog').addEventListener('close', () => {
  if (!element<HTMLDialogElement>('split-dialog').open) element('split-documents').replaceChildren();
});
element('tab-context-menu').addEventListener('keydown', event => {
  const menu = element('tab-context-menu');
  if (event.key === 'Escape') { event.stopPropagation(); menu.hidePopover(); return; }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const controls = [...menu.querySelectorAll<HTMLButtonElement>('button')];
  const index = controls.findIndex(control => control === document.activeElement);
  controls[event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length].focus();
});
element('link-dialog').querySelector('form')!.addEventListener('submit', event => {
  event.preventDefault();
  const dialog = element<HTMLDialogElement>('link-dialog');
  const action = event.submitter instanceof HTMLButtonElement ? event.submitter.value : 'insert';
  if (action === 'cancel') { dialog.close('cancel'); return; }
  const selection = linkSelection;
  void run(async () => {
    try {
      if (!selection || documentId !== selection.documentId || mode !== selection.mode
        || (mode === 'visual' ? !editor.state.doc.eq(selection.doc) : markdown !== selection.content)) {
        throw new Error('The active document changed. Cancel and reopen the link editor in the intended document.');
      }
      const range = { from: selection.from, to: selection.to };
      const change = () => editor.chain().command(({ tr }) => { closeHistory(tr); return true; });
      if (action === 'remove') {
        if (!selection.existing || mode !== 'visual') throw new Error('Choose an existing Visual link to remove.');
        if (!change().setTextSelection(range).unsetLink().run()) throw new Error('The link could not be removed.');
      } else {
        const label = element<HTMLInputElement>('link-label').value;
        const url = element<HTMLInputElement>('link-url').value.trim();
        if (!label.trim()) throw new Error('Enter the text to display for this link.');
        if (!isSafeLink(url) && !/^#[^\s]*$/.test(url)) throw new Error('Use an http, https, mailto, or #heading address.');
        if (mode === 'source') {
          const address = url.replace(/[()\s]/g, character => character === '(' ? '%28' : character === ')' ? '%29' : encodeURIComponent(character));
          source.setRangeText(`[${label.replace(/[[\]\\]/g, '\\$&')}](${address})`, range.from, range.to, 'end');
          source.focus();
          changed(source.value);
        } else if (selection.existing && label === selection.label) {
          if (!change().setTextSelection(range).updateAttributes('link', { href: url }).run()) throw new Error('The link could not be updated.');
        } else {
          const marks = selection.existing
            ? selection.doc.resolve(selection.from).nodeAfter?.marks.map(mark => mark.type.name === 'link'
              ? { ...mark.toJSON(), attrs: { ...mark.attrs, href: url } } : mark.toJSON())
            : [{ type: 'link', attrs: { href: url } }];
          if (!change().insertContentAt(range, { type: 'text', text: label, marks }).run()) throw new Error('The link could not be inserted.');
        }
      }
      if (mode === 'visual') editor.view.dispatch(closeHistory(editor.state.tr));
      dialog.close(action);
    } catch (error) {
      element('link-error').textContent = error instanceof Error ? error.message : String(error);
      element('link-error').hidden = false;
      throw error;
    }
  }).then(() => {
    if (dialog.open || busy || !selection || documentId !== selection.documentId || mode !== selection.mode) return;
    // Deferred Tiptap focus can otherwise reactivate a previously edited split pane.
    if (mode === 'visual') editor.view.focus();
    else source.focus();
  });
});
element('link-dialog').addEventListener('close', () => {
  // An earlier close event may arrive after the dialog has reopened.
  if (!element<HTMLDialogElement>('link-dialog').open) linkSelection = null;
});
element('canvas').addEventListener('error', event => {
  if (!(event.target instanceof HTMLImageElement)) return;
  const image = event.target;
  const id = image.closest<HTMLElement>('.document-pane')?.dataset.documentId;
  notify('An image could not be displayed. Check its path, choose its project folder, or use Insert image to embed it.', true);
  if (!id || !tabs.find(tab => tab.id === id)?.path || !image.src.startsWith('lekh-image:')) return;
  const control = document.createElement('button');
  control.type = 'button';
  control.className = 'notification-action';
  control.textContent = 'Choose project folder...';
  control.addEventListener('click', event => {
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent('lekh-project-assets', { detail: id }));
  });
  element('notification').append(' ', control);
}, true);
window.addEventListener('lekh-project-assets', event => {
  const id: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof id !== 'string' || !tabs.some(tab => tab.id === id)) return;
  void run(async () => { activateTab(id); await dispatch('allow-image-folder'); });
});
window.addEventListener('lekh-shared-variant-file', event => {
  const id: unknown = (event as CustomEvent<unknown>).detail;
  if (typeof id !== 'string' || !tabs.some(tab => tab.id === id)) return;
  void run(async () => {
    activateTab(id);
    const chosen = unwrap(await window.lekh.chooseVariantConfigFile(id));
    if (!chosen) return;
    const tab = tabs.find(item => item.id === id);
    if (!tab) throw new Error('This document is no longer open.');
    if (!await loadProjectVariantLabels(tab)) throw new Error('The selected shared file does not contain this article’s selector group.');
    tab.previewMarkdown = undefined;
    refreshPreview(tab);
    notify(`Loaded selector choices from ${chosen.label}.`);
  });
});
element('canvas').addEventListener('contextmenu', event => {
  contextImageSource = event.target instanceof HTMLImageElement ? event.target.getAttribute('data-lekh-source') : null;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tiptap a') : null;
  if (!busy && link && !link.closest('[data-lekh-contents], .contents-node')) {
    const range = getMarkRange(editor.state.doc.resolve(editor.view.posAtDOM(link, 0)), editor.schema.marks.link);
    if (range) editor.commands.setTextSelection(range);
  }
});
document.addEventListener('contextmenu', event => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  contextTarget = target?.closest<HTMLElement>('#canvas .tiptap, #canvas .document-source') ?? null;
  if (target?.closest('.code-block-controls')) contextTarget = null;
  if (target?.closest('.publishing-field, .publishing-raw-editor')) contextTarget = null;
  const bounds = contextTarget?.getBoundingClientRect();
  contextPoint = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY }
    : { x: (bounds?.left ?? 0) + 12, y: (bounds?.top ?? 0) + 12 };
}, true);
window.lekh.onContextMenu(menu => {
  const origin = contextTarget;
  contextTarget = null;
  const report = (error: unknown) => notify(error instanceof Error ? error.message : String(error), true);
  if (!origin || busy) {
    void window.lekh.contextMenuCommand(menu.id, 'native').then(unwrap).catch(report);
    return;
  }
  closeDropdowns();
  const id = documentId;
  const currentMode = mode;
  editorMenu.show({ ...menu, ...contextPoint }, origin, command => {
    if (busy || documentId !== id || mode !== currentMode) {
      notify('The active editor changed. Open the context menu again in the intended document.', true);
      return;
    }
    void window.lekh.contextMenuCommand(menu.id, command).then(unwrap).catch(report);
  });
});
element('canvas').addEventListener('paste', event => {
  const file = [...(event.clipboardData?.files ?? [])].find(item => item.type.startsWith('image/'));
  const hasImage = file || [...(event.clipboardData?.types ?? [])].some(type => type.startsWith('image/'));
  if (!hasImage) return;
  event.preventDefault();
  event.stopPropagation();
  activateEventPane(event);
  if (!editingAvailable(event.target)) return;
  void run(async () => {
    if (!file) { await dispatch('paste-image'); return; }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) throw new Error('Paste a PNG, JPEG, GIF, or WebP image.');
    if (file.size > 20 * 1024 * 1024) throw new Error('The clipboard image exceeds the 20 MB image limit.');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The clipboard image could not be read.'));
      reader.onerror = () => reject(new Error('The clipboard image could not be read.'));
      reader.readAsDataURL(file);
    });
    await chooseImageStorage(data);
  });
}, true);
element('canvas').addEventListener('dragover', event => {
  if ([...(event.dataTransfer?.items ?? [])].some(item => item.kind === 'file')) event.preventDefault();
});
element('canvas').addEventListener('drop', event => {
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  activateEventPane(event);
  if (!editingAvailable(event.target)) return;
  void run(async () => {
    if (files.length !== 1) throw new Error('Drop one image at a time.');
    const file = files[0];
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)) throw new Error('Drop a PNG, JPEG, GIF, or WebP image.');
    if (file.size > 20 * 1024 * 1024) throw new Error('The dropped image exceeds the 20 MB image limit.');
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('The dropped image could not be read.'));
      reader.onerror = () => reject(new Error('The dropped image could not be read.'));
      reader.readAsDataURL(file);
    });
    await chooseImageStorage(data);
  });
}, true);
element('canvas').addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'v') return;
  const target = event.target;
  if (target !== source && (!(target instanceof HTMLElement) || !target.closest('.tiptap') || target.closest('.code-block-controls'))) return;
  event.preventDefault();
  event.stopPropagation();
  if (busy) notify('Please wait for the current operation to finish.');
  else window.lekh.paste();
}, true);
function copySelectedImage(event: ClipboardEvent, cut: boolean): void {
  if (mode !== 'visual') return;
  const { from, to } = editor.state.selection;
  const node = editor.state.doc.nodeAt(from);
  if (node?.type.name !== 'image' || to !== from + node.nodeSize) return;
  event.preventDefault();
  void run(async () => {
    unwrap(await window.lekh.copyImage(documentId, String(node.attrs.src)));
    if (cut) editor.chain().focus().deleteSelection().run();
  });
}
element('canvas').addEventListener('copy', event => copySelectedImage(event, false), true);
element('canvas').addEventListener('cut', event => copySelectedImage(event, true), true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    editorMenu.hide();
    closeDropdowns();
    setFindOpen(false);
    setFocusMode(false);
  }
});
const dropdownIds = ['save-menu', 'export-menu', 'format-menu', 'tabs-menu', 'structure-menu', 'interactive-menu', 'alerts-menu'];
function closeDropdowns(): void {
  for (const id of dropdownIds) {
    element(id).hidden = true;
    document.querySelector(`[aria-controls="${id}"]`)!.setAttribute('aria-expanded', 'false');
  }
}
function dropdownAnchor(id: string): HTMLElement {
  const control = document.querySelector<HTMLElement>(`[aria-controls="${id}"]`)!;
  return control.getClientRects().length ? control : document.querySelector<HTMLElement>('[aria-controls="format-menu"]')!;
}
function positionViewMenu(): void {
  for (const id of ['format-menu', 'tabs-menu', 'structure-menu', 'interactive-menu', 'alerts-menu']) {
    const menu = element(id);
    if (menu.hidden) continue;
    const trigger = dropdownAnchor(id).getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(trigger.right - bounds.width, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(trigger.bottom + 5, innerHeight - bounds.height - 8))}px`;
  }
}
const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
const overflow = element('toolbar-overflow');
const toolbarSlots = [...toolbar.querySelectorAll<HTMLElement>(':scope > .toolbar-group:not([data-group="insert"]), .toolbar-insert-extra')]
  .map(control => {
    const slot = document.createComment('toolbar position');
    control.before(slot);
    return { control, slot };
  });
let toolbarLayoutKey = '';
function scheduleResponsiveLayout(): void {
  if (responsiveFrame) return;
  responsiveFrame = requestAnimationFrame(() => {
    responsiveFrame = 0;
    layoutResponsiveChrome();
  });
}
function layoutResponsiveChrome(): void {
  if (!toolbar.getClientRects().length) return;
  const focused = document.activeElement;
  const key = `${toolbar.clientWidth}:${element('preview-toggle').textContent}`;
  if (key !== toolbarLayoutKey) {
    toolbarLayoutKey = key;
    for (const { control, slot } of toolbarSlots) {
      slot.after(control);
      control.setAttribute('role', 'group');
      for (const item of control.querySelectorAll<HTMLButtonElement>('button')) {
        item.removeAttribute('role');
        item.removeAttribute('aria-checked');
      }
    }
    // Move whole groups, retaining selection, handlers, and formatting state; captions become section headers.
    for (const { control } of [...toolbarSlots].reverse()) {
      if (toolbar.scrollWidth <= toolbar.clientWidth) break;
      overflow.prepend(control);
      for (const item of control.querySelectorAll<HTMLButtonElement>('button')) {
        const checked = Boolean(item.dataset.command) || item.id.startsWith('view-') || item.id === 'preview-toggle';
        item.setAttribute('role', checked ? 'menuitemcheckbox' : 'menuitem');
        if (checked) item.setAttribute('aria-checked', item.getAttribute('aria-pressed') ?? 'false');
      }
    }
    toolbar.scrollLeft = 0;
    overflow.hidden = !overflow.children.length;
    if (focused instanceof HTMLElement && overflow.contains(focused) && element('format-menu').hidden) {
      document.querySelector<HTMLButtonElement>('[aria-controls="format-menu"]')!.focus();
    }
  }
  const list = element('tabs');
  const allTabs = [...list.querySelectorAll<HTMLElement>('.document-tab')];
  for (const tab of allTabs) tab.hidden = false;
  for (const tab of [...allTabs].reverse()) {
    if (list.scrollWidth <= list.clientWidth) break;
    if (!tab.classList.contains('selected')) tab.hidden = true;
  }
  list.scrollLeft = 0;
  if (focused instanceof HTMLElement && focused.closest('.document-tab[hidden]')) {
    document.querySelector<HTMLButtonElement>('[aria-controls="tabs-menu"]')!.focus();
  }
  positionViewMenu();
}
const chromeObserver = new ResizeObserver(scheduleResponsiveLayout);
chromeObserver.observe(toolbar);
chromeObserver.observe(document.querySelector('.tabs-bar')!);
chromeObserver.observe(element('tabs'));
overflow.addEventListener('mousedown', event => {
  if ((event.target as HTMLElement).closest('button')) event.preventDefault();
});
scheduleResponsiveLayout();
for (const id of dropdownIds) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`)!;
  const menu = element(id);
  for (const control of menu.querySelectorAll('button')) control.setAttribute('role', 'menuitem');
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    closeDropdowns();
    menu.hidden = false;
    positionViewMenu();
    trigger.setAttribute('aria-expanded', 'true');
    if (id === 'export-menu') void checkLocalVariantExportRestrictions();
    const items = menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    items[event.key === 'ArrowUp' ? items.length - 1 : 0].focus();
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeDropdowns();
      dropdownAnchor(id).focus();
      return;
    }
    if (event.key === 'Tab') { closeDropdowns(); dropdownAnchor(id).focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const controls = [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = controls.findIndex(control => control === document.activeElement);
    controls[event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length].focus();
  });
}
// Handle formatting before Tiptap, but only inside a document editor.
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !(event.target instanceof HTMLElement)) return;
  const shortcut = formattingShortcuts.find(item => item.code === event.code && item.shift === event.shiftKey);
  if (!shortcut || !event.target.closest('.tiptap, .document-source') || event.target.closest('.code-block-controls')) return;
  event.preventDefault();
  event.stopPropagation();
  activateEventPane(event);
  void run(async () => format(shortcut.command));
}, true);
window.addEventListener('beforeunload', storeDraft);
const slashIcons: Record<string, Icon> = { 'format:bullet': 'bullet', 'format:ordered': 'ordered', 'format:task': 'task', 'format:quote': 'quote', image: 'image', table: 'table', 'format:codeblock': 'codeblock', 'format:rule': 'rule', 'insert:toc': 'contents', 'insert:mermaid': 'diagram' };
const slashIcon = (entry: CommandEntry): string => {
  if (entry.id.startsWith('heading:')) return `<b class="heading-glyph">H${entry.id.slice(8)}</b>`;
  const template = publishingTemplates.find(item => `insert:${item.id}` === entry.id);
  if (template) return publishingIcon(template.icon);
  return icon(slashIcons[entry.id] ?? 'blocks');
};
const commandPalette = new CommandPalette(() => commandEntries(documentHasSelector()), id => { void runAction(id); });
slashMenu = new SlashMenu(() => slashEntries(documentHasSelector()), runSlashEntry, slashIcon);
createBlockToolbar();
document.addEventListener('keydown', event => {
  if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey || event.code !== 'KeyP') return;
  event.preventDefault();
  if (!document.querySelector('dialog[open]')) void runAction('command-palette');
}, true);
element('canvas').addEventListener('keydown', event => {
  if (!(event.target instanceof HTMLElement) || !event.target.closest('.tiptap') || event.target.closest('.publishing-field, .publishing-raw-editor, .code-block-controls')) return;
  if (slashMenu?.isOpen) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismissSlashMenu(); return; }
    if (slashMenu.key(event)) { event.preventDefault(); event.stopPropagation(); return; }
  }
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    event.preventDefault();
    event.stopPropagation();
    activateEventPane(event);
    void runAction(event.key === 'ArrowUp' ? 'block:up' : 'block:down');
  }
}, true);
window.lekh.onIncludeAccessChanged(id => {
  refreshPublishingFiles(id);
  refreshLocalImages(id);
  if (id === documentId) learnPanel?.refresh();
});
window.lekh.onAction(action => {
  if (action === 'open-pending') {
    pendingExternalOpen = true;
    if (!busy) { pendingExternalOpen = false; void run(openPending); }
  } else void runAction(action);
});
element('tabs').addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  void run(async () => {
    const groups = groupTabs(tabs.map(tab => tab.id), pairs);
    if (event.key === 'Home') activateTab(groups[0].activeId);
    else if (event.key === 'End') activateTab(groups.at(-1)!.activeId);
    else await dispatch(event.key === 'ArrowRight' ? 'next-tab' : 'previous-tab');
    element('tabs').querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  });
});
void run(async () => {
  documentId = unwrap(await window.lekh.newDocument());
  activeTab = {
    id: documentId, markdown, savedMarkdown, name: documentName, path: null, mode,
    editor, visual, undo: sourceUndo, redo: sourceRedo, selection: [0, 0], sourceScroll: 0, canvasScroll: 0,
    source, visualMarkdown: markdown, ...initialPane,
  };
  initialPane.pane.dataset.documentId = documentId;
  tabs.push(activeTab);
  source.value = markdown;
  resetVisual(markdown);
  writingAssistance = new WritingAssistance({
    context: () => activeTab ? { id: documentId, markdown, mode, editor, source, pane: activeTab.pane } : undefined,
    applySource: (from, to, replacement) => {
      useSource();
      source.focus();
      source.setRangeText(replacement, from, to, 'end');
      changed(source.value);
    },
    report: message => notify(message, true),
  });
  learnPanel = new LearnChecksPanel({
    context: () => activeTab ? { id: documentId, markdown, path: documentPath ?? null } : undefined,
    checkPaths: async (id, paths) => unwrap(await window.lekh.checkLearnPaths(id, paths)),
    jump: line => {
      useSource();
      const lines = markdown.split('\n');
      const target = Math.min(Math.max(1, line), lines.length);
      const offset = lines.slice(0, target - 1).join('\n').length + (target > 1 ? 1 : 0);
      source.focus();
      source.setSelectionRange(offset, offset);
      source.scrollTop = Math.max(0, (target - 1) * 24 - 50);
    },
    allowFolder: async kind => {
      if (kind === 'image') await dispatch('allow-image-folder');
      else if (unwrap(await window.lekh.allowIncludeFolder(documentId))) notify('Local includes are allowed within the selected folder for this document and session.');
    },
    report: message => notify(message, true),
  });
  showWorkspace();
  update();
  await refreshZoom();
  await applyTheme(theme);
  await refreshRecent();
  await openPending();
  const initial = tabs.find(tab => tab.id === initialPane.pane.dataset.documentId);
  if (tabs.length > 1 && initial && initial !== activeTab && !initial.path && initial.markdown === '' && initial.savedMarkdown === '') {
    unwrap(await window.lekh.closeDocument(initial.id));
    initial.editor.destroy();
    initial.pane.remove();
    tabs.splice(tabs.indexOf(initial), 1);
    update();
  }
});
