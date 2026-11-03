import { publishingTemplates } from './publishing-templates.js';
import { formattingShortcuts } from './shortcuts.js';
import { themes } from './themes.js';

export type CommandEntry = { id: string; label: string; group: string; shortcut?: string; keywords?: string; description?: string };

const shortcut = (command: string) => formattingShortcuts.find(item => item.command === command)?.accelerator.replace('CmdOrCtrl', 'Ctrl');

export const blockCommands: CommandEntry[] = [
  { id: 'block:up', label: 'Move block up', group: 'Edit', shortcut: 'Alt+Shift+Up', keywords: 'reorder' },
  { id: 'block:down', label: 'Move block down', group: 'Edit', shortcut: 'Alt+Shift+Down', keywords: 'reorder' },
  { id: 'block:duplicate', label: 'Duplicate block', group: 'Edit', keywords: 'copy clone' },
  { id: 'block:remove', label: 'Remove block', group: 'Edit', keywords: 'delete' },
];

export function commandEntries(hasVariantSelector = false): CommandEntry[] {
  const publishing = publishingTemplates.filter(item => item.category !== 'variant').map(item => {
    const variant = item.id === 'publishing-selector' && hasVariantSelector ? publishingTemplates.find(entry => entry.id === 'publishing-zone')! : item;
    const group = item.category === 'alerts' ? 'Alerts' : ['publishing-tabs', 'publishing-selector'].includes(item.id) ? 'Interactive' : 'Structure';
    return { id: `insert:${item.id}`, label: variant.label, group, description: variant.description, keywords: item.category === 'alerts' ? 'alert callout' : 'block publishing' };
  });
  return [
    { id: 'new', label: 'New document', group: 'File', shortcut: 'Ctrl+N' },
    { id: 'open', label: 'Open file...', group: 'File', shortcut: 'Ctrl+O' },
    { id: 'save', label: 'Save', group: 'File', shortcut: 'Ctrl+S' },
    { id: 'save-as', label: 'Save as...', group: 'File', shortcut: 'Ctrl+Shift+S' },
    { id: 'save-all', label: 'Save all files', group: 'File', shortcut: 'Ctrl+Alt+S' },
    { id: 'close-tab', label: 'Close tab', group: 'File', shortcut: 'Ctrl+W' },
    { id: 'export-html', label: 'Export interactive HTML (.html)...', group: 'Export', keywords: 'web offline review' },
    { id: 'export-docx', label: 'Export Word document (.docx)...', group: 'Export', keywords: 'word' },
    { id: 'export-pdf', label: 'Export PDF document (.pdf)...', group: 'Export', shortcut: 'Ctrl+P', keywords: 'print' },
    { id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z' },
    { id: 'redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Shift+Z' },
    { id: 'find', label: 'Find and replace', group: 'Edit', shortcut: 'Ctrl+F', keywords: 'search' },
    { id: 'copy-document', label: 'Copy document as Markdown', group: 'Edit' },
    { id: 'paste-markdown', label: 'Paste as Markdown', group: 'Edit' },
    { id: 'paste-image', label: 'Paste image', group: 'Edit' },
    ...formattingShortcuts.filter(item => ['bold', 'italic', 'strike', 'code'].includes(item.command))
      .map(item => ({ id: `format:${item.command}`, label: item.label, group: 'Text', shortcut: shortcut(item.command) })),
    { id: 'link', label: 'Insert or edit link...', group: 'Text', shortcut: 'Ctrl+K', keywords: 'url hyperlink' },
    { id: 'format:clear', label: 'Clear formatting', group: 'Text' },
    { id: 'heading:0', label: 'Paragraph', group: 'Style', shortcut: 'Ctrl+0', keywords: 'normal text' },
    ...[1, 2, 3, 4, 5, 6].map(level => ({ id: `heading:${level}`, label: `Heading ${level}`, group: 'Style', shortcut: `Ctrl+${level}`, keywords: 'title' })),
    ...formattingShortcuts.filter(item => ['bullet', 'ordered', 'task', 'quote'].includes(item.command))
      .map(item => ({ id: `format:${item.command}`, label: item.label, group: 'Paragraph', shortcut: shortcut(item.command), keywords: 'list' })),
    { id: 'image', label: 'Image...', group: 'Insert', shortcut: 'Ctrl+Shift+I', keywords: 'picture photo screenshot' },
    { id: 'table', label: 'Table...', group: 'Insert', shortcut: 'Ctrl+T', keywords: 'grid rows columns' },
    { id: 'format:codeblock', label: 'Code block', group: 'Insert', shortcut: 'Ctrl+Shift+K', keywords: 'fence snippet' },
    { id: 'format:rule', label: 'Horizontal rule', group: 'Structure', keywords: 'divider line separator' },
    { id: 'insert:toc', label: 'Table of contents', group: 'Structure', description: 'Insert, or refresh the existing one', keywords: 'toc contents' },
    { id: 'insert:mermaid', label: 'Mermaid diagram', group: 'Structure', keywords: 'flowchart sequence chart' },
    { id: 'insert:math', label: 'Math block (Markdown)', group: 'Insert', shortcut: 'Ctrl+Shift+M', keywords: 'latex equation source' },
    { id: 'insert:footnote', label: 'Footnote (Markdown)', group: 'Insert', keywords: 'source' },
    { id: 'insert:before', label: 'Paragraph before', group: 'Insert' },
    { id: 'insert:after', label: 'Paragraph after', group: 'Insert' },
    ...publishing,
    ...blockCommands,
    { id: 'visual', label: 'Visual', group: 'View' },
    { id: 'source', label: 'Markdown', group: 'View', keywords: 'source raw' },
    { id: 'edit-split', label: 'Split (Visual and Markdown)', group: 'View', keywords: 'dual side by side' },
    { id: 'preview', label: 'Preview / Back to editing', group: 'View', keywords: 'read only interactive' },
    { id: 'preview-source', label: 'Show Markdown beside preview', group: 'View' },
    { id: 'split', label: 'Split with another file...', group: 'View', keywords: 'compare pair' },
    { id: 'unsplit', label: 'Unsplit', group: 'View' },
    { id: 'sidebar', label: 'Toggle sidebar', group: 'View', shortcut: 'Ctrl+Shift+B', keywords: 'outline' },
    { id: 'focus', label: 'Focus mode', group: 'View', shortcut: 'F9', keywords: 'distraction free zen' },
    { id: 'zoom-in', label: 'Zoom in', group: 'View' },
    { id: 'zoom-out', label: 'Zoom out', group: 'View' },
    { id: 'zoom-reset', label: 'Reset zoom', group: 'View' },
    ...themes.map(theme => ({ id: `theme:${theme.id}`, label: `${theme.label} theme`, group: 'View', keywords: 'color dark light mode' })),
    { id: 'next-tab', label: 'Next tab', group: 'View', shortcut: 'Ctrl+Tab' },
    { id: 'previous-tab', label: 'Previous tab', group: 'View', shortcut: 'Ctrl+Shift+Tab' },
    { id: 'writing-assistance', label: 'Writing assistance', group: 'Review', keywords: 'grammar spelling harper' },
    { id: 'learn-checks', label: 'Learn checks', group: 'Review', keywords: 'microsoft learn docfx validate alt text missing image include metadata' },
    { id: 'include-relationships', label: 'Include relationships', group: 'Review', keywords: 'repository workspace used by references consumers dependencies' },
    { id: 'document-stats', label: 'Document statistics', group: 'Review', keywords: 'word count characters reading time' },
    { id: 'clear-recent', label: 'Clear recent files', group: 'Tools' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Help', shortcut: 'F1' },
    { id: 'help', label: 'Getting started', group: 'Help' },
  ];
}

const slashDescriptions: Record<string, string> = {
  'heading:1': 'Large section title',
  'heading:2': 'Medium section title',
  'heading:3': 'Small section title',
  'format:bullet': 'Simple bulleted list',
  'format:ordered': 'List with numbers',
  'format:task': 'Checklist with tick boxes',
  'format:quote': 'Highlighted quotation',
  image: 'Embed a picture from your computer',
  table: 'Rows and columns',
  'format:codeblock': 'Code with syntax highlighting',
  'format:rule': 'Divider between sections',
  'insert:mermaid': 'Diagram written as text',
};

/** Slash-menu entries: blocks that can be inserted on an empty line. */
export function slashEntries(hasVariantSelector = false): CommandEntry[] {
  const ids = new Set(['heading:1', 'heading:2', 'heading:3', 'format:bullet', 'format:ordered', 'format:task', 'format:quote',
    'image', 'table', 'format:codeblock', 'format:rule', 'insert:toc', 'insert:mermaid']);
  return commandEntries(hasVariantSelector)
    .filter(entry => ids.has(entry.id) || entry.id.startsWith('insert:callout-') || entry.id.startsWith('insert:publishing-'))
    .map(entry => ({ ...entry, label: entry.label.replace(/(\.\.\.|\u2026)$/, ''), description: entry.description ?? slashDescriptions[entry.id] }));
}

export function filterCommands(entries: CommandEntry[], query: string): CommandEntry[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  const scored = entries.map((entry, index) => {
    const label = entry.label.toLowerCase();
    const haystack = `${label} ${entry.group.toLowerCase()} ${entry.keywords ?? ''} ${entry.description?.toLowerCase() ?? ''}`;
    if (!terms.every(term => haystack.includes(term))) return undefined;
    const score = label.startsWith(terms[0]) ? 0 : label.split(/[\s(./]+/).some(word => word.startsWith(terms[0])) ? 1 : label.includes(terms[0]) ? 2 : 3;
    return { entry, score, index, length: label.length };
  }).filter(item => item !== undefined);
  return scored.sort((a, b) => a.score - b.score || (a.score === 0 ? a.length - b.length : 0) || a.index - b.index).map(item => item.entry);
}
