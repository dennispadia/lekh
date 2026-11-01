import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { publishingTemplateMarkdown, publishingTemplates, variantInsertionTemplate } from '../lib/publishing-templates.js';
import { parser, documentPreviewHTML } from '../lib/markdown.js';
import { publishingBlockAtStart } from '../lib/publishing.js';
import { publishingIcon } from '../lib/publishing-icons.js';

test('toolbar exposes every alert type and reusable authoring building block', () => {
  for (const kind of ['note', 'tip', 'important', 'caution', 'warning']) {
    assert.ok(publishingTemplates.some(item => item.id === `callout-${kind}`));
    assert.match(publishingTemplateMarkdown(`callout-${kind}`)!, new RegExp(`> \\[!${kind.toUpperCase()}\\]`));
  }
  for (const kind of ['tabs', 'selector', 'image', 'metadata']) {
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

test('local includes are not offered as an insertion tool', () => {
  assert.ok(!publishingTemplates.some(item => String(item.id) === 'publishing-include'));
  assert.equal(publishingTemplateMarkdown('publishing-include'), undefined);
});

test('variant creation is a single prerequisite-aware tool, not two independent block options', () => {
  assert.equal(variantInsertionTemplate(false).id, 'publishing-selector');
  assert.equal(variantInsertionTemplate(true).id, 'publishing-zone');
  assert.equal(variantInsertionTemplate(true).label, 'Add variant content\u2026');
  assert.equal(publishingTemplates.filter(item => item.category === 'content' && item.id === 'publishing-selector').length, 1);
  assert.ok(!publishingTemplates.some(item => item.category === 'content' && String(item.id) === 'publishing-zone'));
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

test('local include directives remain inert and have no authorization or file-opening actions', async () => {
  const electron = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const bridge = await readFile(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  const renderer = await readFile(new URL('../src/editable-publishing.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(electron, /publishing:(?:allow|revoke|open)-includes|readAuthorizedInclude/);
  assert.doesNotMatch(bridge, /allowPublishingIncludes|revokePublishingIncludes|openPublishingInclude/);
  assert.doesNotMatch(renderer, /Allow project folder|Open shared file in Visual/);
  assert.match(renderer, /Include directive \(not loaded\)/);
  assert.match(renderer, /Referenced files are not opened or included/);
  assert.match(bridge, /allowImageFolder/);
  assert.match(bridge, /revokeImageFolder/);
  assert.match(electron, /imageRoots\.set\(String\(id\), \{ root \}\)/);
  assert.match(electron, /const imageRoot = grant\?\.root \?\? null/);
});
