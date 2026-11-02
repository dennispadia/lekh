import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publishingTemplateMarkdown, publishingTemplates, variantInsertionTemplate } from '../lib/publishing-templates.js';
import { parser, documentPreviewHTML } from '../lib/markdown.js';
import { includeMarkdown, publishingBlockAtStart } from '../lib/publishing.js';
import { publishingIcon } from '../lib/publishing-icons.js';

test('toolbar exposes every alert type and reusable authoring building block', () => {
  for (const kind of ['note', 'tip', 'important', 'caution', 'warning']) {
    assert.ok(publishingTemplates.some(item => item.id === `callout-${kind}`));
    assert.match(publishingTemplateMarkdown(`callout-${kind}`)!, new RegExp(`> \\[!${kind.toUpperCase()}\\]`));
  }
  for (const kind of ['tabs', 'selector', 'image', 'metadata', 'include']) {
    assert.ok(publishingTemplates.some(item => item.id === `publishing-${kind}`));
  }
  assert.ok(!publishingTemplates.some(item => String(item.id) === 'publishing-steps'));
  assert.equal(publishingTemplateMarkdown('publishing-steps'), undefined);
  for (const item of publishingTemplates) {
    assert.ok(item.description.length > 20);
    assert.match(publishingIcon(item.icon), /<svg[^>]*aria-hidden="true"/);
    assert.equal(item.category, item.id.startsWith('callout-') ? 'alerts' : item.id === 'publishing-zone' ? 'variant' : 'content');
  }
});

test('new interactive blocks use the agreed example and option names', () => {
  const tabs = publishingTemplateMarkdown('publishing-tabs')!;
  const selector = publishingTemplateMarkdown('publishing-selector')!;
  assert.match(tabs, /\[Example 1\].*\[Example 2\]/s);
  assert.match(selector, /\[Option 1\].*\[Option 2\]/s);
});

test('include insertion formats the title and file path', async () => {
  assert.equal(publishingTemplates.find(item => item.id === 'publishing-include')?.label, 'Include…');
  assert.equal(publishingTemplateMarkdown('publishing-include'), '');
  assert.equal(includeMarkdown('Prerequisites', '../includes/prerequisites.md'), '[!INCLUDE [Prerequisites](../includes/prerequisites.md)]');
  assert.equal(includeMarkdown('A [B] & C', '../includes/A (B & C).md'),
    '[!INCLUDE [A \\[B\\] &amp; C](../includes/A%20%28B%20%26%20C%29.md)]');
  const renderer = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(renderer, /templateItem\('publishing-include'\)/);
  assert.match(electron, /'publishing-metadata', 'publishing-image', 'publishing-include'/);
});

test('variant creation is a single prerequisite-aware tool, not two independent block options', () => {
  assert.equal(variantInsertionTemplate(false).id, 'publishing-selector');
  assert.equal(variantInsertionTemplate(true).id, 'publishing-zone');
  assert.equal(variantInsertionTemplate(true).label, 'Add variant content\u2026');
  assert.equal(publishingTemplates.filter(item => item.category === 'content' && item.id === 'publishing-selector').length, 1);
  assert.ok(!publishingTemplates.some(item => item.category === 'content' && String(item.id) === 'publishing-zone'));
});

test('the selector points to the Interactive menu instead of inserting content beside itself', async () => {
  const source = await readFile(new URL('../src/editable-publishing.ts', import.meta.url), 'utf8');
  const selector = source.slice(source.indexOf('const SelectorNode ='), source.indexOf('const MetadataNode ='));
  assert.match(selector, /publishing-variant-guidance/);
  assert.match(selector, /Add variant content.*Interactive/);
  assert.doesNotMatch(selector, /publishing-add-variant-content|addVariantContent/);
  assert.match(publishingTemplates.find(item => item.id === 'publishing-selector')!.description, /Interactive menu/);
});

test('metadata editing exposes only the complete YAML field without a heading', async () => {
  const source = await readFile(new URL('../src/editable-publishing.ts', import.meta.url), 'utf8');
  const metadata = source.slice(source.indexOf('const MetadataNode ='), source.indexOf('const IncludeNode ='));
  assert.match(metadata, /field\(context, 'Metadata YAML'/);
  assert.match(metadata, /yaml\.wrapper\.dataset\.lekhMetadata/);
  assert.match(metadata, /yaml\.wrapper\.querySelector\('span'\)\?\.remove\(\)/);
  assert.doesNotMatch(metadata, /Document title|Document description|All metadata \(YAML\)|<summary>|Make these choices editable/);
});

test('tabbed and variant documents disable Word and PDF exports in the app menus', async () => {
  const renderer = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(renderer, /control\.disabled = interactiveExportRequired \|\| exportCheckPending/);
  assert.match(styles, /\[data-action="export-docx"\]:disabled.*opacity:\s*\.45/);
  assert.match(styles, /\[data-action="export-pdf"\]:disabled.*opacity:\s*\.45/);
  assert.match(electron, /id: 'export-docx'/);
  assert.match(electron, /id: 'export-pdf'/);
  assert.match(electron, /if \(item\) item\.enabled = !interactive/);
});

test('the toolbar and insert menu provide one insert-or-refresh table-of-contents action', async () => {
  const renderer = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(renderer, /data-action="insert:toc"', icon\('contents'\), 'Table of contents'/);
  assert.equal(renderer.match(/data-action="insert:toc"/g)?.length, 1);
  assert.doesNotMatch(renderer, /insert:toc-update|Update table of contents/);
  assert.match(electron, /label: 'Table of contents', click: \(\) => action\('insert:toc'\)/);
  assert.doesNotMatch(electron, /insert:toc-update|Update table of contents/);
});

test('Structure and Interactive are distinct toolbar and right-click menus with pinned controls', async () => {
  const renderer = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  for (const menu of ['structure', 'interactive']) {
    assert.match(renderer, new RegExp(`data-action="${menu}-menu"`));
    assert.match(renderer, new RegExp(`id="${menu}-menu"`));
  }
  assert.match(renderer, /group\('insert', 'Insert'/);
  assert.match(renderer, /:scope > \.toolbar-group:not\(\[data-group="insert"\]\), \.toolbar-insert-extra/);
  assert.doesNotMatch(renderer, /group\('(alerts|structure|interactive)'/);
  assert.doesNotMatch(renderer, /data-action="publishing-menu"/);
  assert.match(electron, /label: 'Structure', submenu/);
  assert.match(electron, /label: 'Interactive', submenu/);
  assert.doesNotMatch(electron, /label: 'Publishing blocks'/);
});

test('right-click keeps formatting grouped and uses only eight quick actions', async () => {
  const source = await readFile(new URL('../src/context-menu.ts', import.meta.url), 'utf8');
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const actions = source.slice(source.indexOf('const directActions:'), source.indexOf('export class ContextMenu'));
  assert.equal(actions.match(/\['/g)?.length, 8);
  assert.doesNotMatch(source, /item\.label === 'Formatting'/);
  assert.match(electron, /label: 'Edit', submenu/);
  assert.match(electron, /label: 'Copy \/ Paste As', submenu/);
});

test('alert markers inside quoted fences and comments do not truncate the surrounding alert', () => {
  for (const fence of ['```', '~~~']) {
    const raw = `> [!NOTE]\n> Before.\n>\n> ${fence}markdown\n> [!WARNING]\n> literal text\n> ${fence}\n>\n> After.\n`;
    assert.equal(publishingBlockAtStart(raw)!.raw, raw);
    const tokens = parser.parse(raw, {});
    assert.equal(tokens.filter(token => token.type === 'publishing_callout_open').length, 1);
    assert.ok(tokens.some(token => token.type === 'fence' && token.content.includes('[!WARNING]')));
    assert.match(documentPreviewHTML(raw, 'test'), /After\./);
  }
  const comments = '> [!NOTE]\n> <!--\n> [!WARNING]\n> -->\n> Kept text.\n';
  assert.equal(publishingBlockAtStart(comments)!.raw, comments);
  const adjacent = '> [!NOTE]\n> One.\n> [!TIP]\n> Two.\n';
  assert.equal(parser.parse(adjacent, {}).filter(token => token.type === 'publishing_callout_open').length, 2);
});

test('formatting selected text retains Markdown, code and literal replacement characters', () => {
  const selected = '**Keep this** and $& $1.\n\n```text\nretain <tags>\n```';
  const callout = publishingTemplateMarkdown('callout-note', selected)!;
  assert.equal(callout.split('\n').slice(1).map(line => line.slice(2)).join('\n'), selected);
  assert.ok(publishingTemplateMarkdown('publishing-tabs', selected)!.includes(selected));
  assert.ok(publishingTemplateMarkdown('publishing-selector', selected)!.includes(selected));
  assert.equal(publishingTemplateMarkdown('unknown'), undefined);
});

test('include loading has a separate, revocable folder grant and visible refresh controls', async () => {
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../src/editable-publishing.ts', import.meta.url), 'utf8');
  assert.match(electron, /includeRoots\.set\(String\(id\), \{ root \}\)/);
  assert.match(electron, /includeRoots\.delete\(String\(id\)\)/);
  assert.match(bridge, /allowIncludeFolder/);
  assert.match(bridge, /revokeIncludeFolder/);
  assert.match(renderer, /Refresh content/);
  assert.match(renderer, /Allow include folder/);
  assert.match(bridge, /allowImageFolder/);
  assert.match(bridge, /revokeImageFolder/);
  assert.match(electron, /imageRoots\.set\(String\(id\), \{ root \}\)/);
  assert.match(electron, /resolveIncludes\(prepared, currentPath, includeGrant\?\.root/);
});

test('image-folder permission commands are absent from menus while contextual access remains scoped', async () => {
  const renderer = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const formatMenu = renderer.slice(renderer.indexOf('<div id="format-menu"'), renderer.indexOf('<div id="notification"'));
  assert.doesNotMatch(formatMenu, /allow-image-folder|revoke-image-folder/);
  assert.doesNotMatch(electron, /label: '(?:Allow local image folder|Stop local image folder access)/);
  assert.match(renderer, /Choose project folder\.\.\./);
  assert.match(electron, /imageRoots\.set\(String\(id\), \{ root \}\)/);
  assert.match(electron, /imageRoots\.delete\(String\(id\)\)/);
});
