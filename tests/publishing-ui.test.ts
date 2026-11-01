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
  for (const kind of ['tabs', 'selector', 'steps', 'image', 'metadata']) {
    assert.ok(publishingTemplates.some(item => item.id === `publishing-${kind}`));
  }
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
  assert.ok(publishingTemplateMarkdown('publishing-steps', selected)!.includes(selected));
  assert.equal(publishingTemplateMarkdown('unknown'), undefined);
});

test('local include access is document-scoped, explicitly granted and revocable', async () => {
  const source = await readFile(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.match(source, /handle\('publishing:allow-includes'/);
  assert.match(source, /properties: \['openDirectory'\]/);
  assert.match(source, /publishingRoots\.set\(String\(id\), \{ root \}\)/);
  assert.match(source, /handle\('publishing:revoke-includes'/);
  assert.match(source, /publishingRoots\.delete\(String\(id\)\)/);
  assert.match(source, /const imageRoot = grant\?\.root \?\? null/);
  assert.match(source, /preparePublishing\(content, currentPath, imageRoot\)/);
  assert.match(source, /publishingRoots\.get\(String\(id\)\) !== grant/);
});
