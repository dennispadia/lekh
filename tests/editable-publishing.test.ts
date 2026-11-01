import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Marked } from 'marked';
import type { Schema, Node as ModelNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { AlertNode } from '../src/alert-node.js';
import { PublishingNode } from '../src/publishing-node.js';
import { EditablePublishing, updateMetadataValue } from '../src/editable-publishing.js';
import { editablePublishingBlockAtStart } from '../lib/publishing.js';
import { publishingTemplateMarkdown } from '../lib/publishing-templates.js';
import { documentPreviewHTML } from '../lib/markdown.js';
import { toDocx, toOfflineHTML, toPrintHTML } from '../lib/export.js';

function fixture() {
  let schema: Schema;
  const extensions = [
    StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }), Image,
    TableKit, TaskList, TaskItem.configure({ nested: true }),
    AlertNode.configure({ schema: () => schema }), EditablePublishing.configure({ schema: () => schema }), PublishingNode,
  ];
  schema = getSchema(extensions);
  const manager = new MarkdownManager({ extensions, marked: new Marked() as unknown as typeof import('marked').marked });
  const parse = (source: string) => schema.nodeFromJSON(manager.parse(source));
  return { schema, manager, parse };
}

function types(node: ModelNode): string[] {
  const result: string[] = [];
  node.descendants(child => { result.push(child.type.name); });
  return result;
}
function changeText(doc: ModelNode, text: string, addition = ' edited'): ModelNode {
  let position: number | undefined;
  doc.descendants((node, offset) => { if (node.isText && node.text?.includes(text) && position === undefined) position = offset + node.text.indexOf(text) + text.length; });
  assert.notEqual(position, undefined, `Editable model text exists: ${text}`);
  return EditorState.create({ schema: doc.type.schema, doc }).tr.insertText(addition, position).doc;
}
const selector = ':::selector title="Choose an option"\n- [Availability Zones](#variant/zones)\n- [Scale Set](#variant/scale-set)\n:::selector-end';
const zone = ':::zone pivot="zones"\n## Availability\n\nEditable **rich** content.\n:::zone-end';

test('all supported publishing bodies are real model content, not opaque source atoms', () => {
  const { parse } = fixture();
  for (const [source, type] of [
    [zone, 'lekhZone'], [':::steps\n1. First **step**.\n2. Next step.\n:::steps-end', 'lekhSteps'],
    ['# [Example](#tab/a)\n\nEditable _example_.\n\n---', 'lekhTabs'],
    ['> [!div class="checklist"]\n> - Check this.', 'lekhDivision'],
    [':::image type="complex" source="image.png" alt-text="Diagram":::\nLong **description**.\n:::image-end', 'lekhImageDescription'],
  ]) {
    const doc = parse(source);
    assert.equal(doc.firstChild?.type.name, type, source);
    assert.notEqual(doc.firstChild?.type.spec.atom, true);
    assert.ok(doc.textContent.length > 0);
    doc.check();
  }
  for (const [source, type] of [
    [selector, 'lekhSelector'], ['---\ntitle: Title\ndescription: Description\n---', 'lekhMetadata'],
    ['[!INCLUDE [Shared content](./includes/shared.md)]', 'lekhInclude'],
    [':::image type="content" source="image.png" alt-text="Diagram":::', 'lekhImageDescription'],
  ]) assert.equal(parse(source).firstChild?.type.name, type, source);
});

test('source provenance retains exact untouched directive and heading syntax', () => {
  const { parse, manager } = fixture();
  for (const raw of [
    zone, selector, ':::steps\n3. Start here.\n4. Continue.\n:::steps-end',
    '#### [MSI](#tab/msi)\n\nUse `code`.\n\n#### [SPN](#tab/spn)\n\nAlternative.\n',
    ':::tabs\n:::tab First\nText.\n:::tab-end\n:::tab Second\nMore.\n:::tab-end\n:::tabs-end',
    '---\n# Comment\ntitle: "Quoted"\ncustom: [one, two]\n...\n',
    '[!INCLUDE [Résumé 日本語](./includes/shared.md)]',
    ':::image type="content" source="image.png" alt-text="A \\"quote\\"" border="false":::',
  ]) assert.equal(manager.serialize(parse(raw).toJSON()).trimEnd(), raw.trimEnd(), raw);
});

test('distributed variant bodies remain editable and independent of selector position', () => {
  const { parse, manager } = fixture();
  const raw = `${selector}\n\nIntroduction.\n\n${zone}\n\nUnconditional section.\n\n:::zone pivot="scale-set"\nScale set text.\n:::zone-end\n\nLater.\n\n${zone}`;
  const doc = parse(raw);
  assert.equal(types(doc).filter(type => type === 'lekhZone').length, 3);
  const edited = changeText(doc, 'Scale set text.');
  const saved = manager.serialize(edited.toJSON());
  assert.match(saved, /Scale set text\. edited/);
  assert.equal((saved.match(/:::zone pivot="zones"/g) ?? []).length, 2);
  assert.ok(saved.includes('Unconditional section.'));
  assert.ok(saved.includes(selector));
  parse(saved).check();
});

test('renaming selector labels preserves stable IDs and all distant content', () => {
  const { parse, manager } = fixture();
  const doc = parse(`${selector}\n\n${zone}`);
  const selected = doc.firstChild!;
  const changed = EditorState.create({ schema: doc.type.schema, doc }).tr.setNodeMarkup(0, undefined, {
    ...selected.attrs, title: 'Choose your deployment', options: [{ id: 'zones', label: 'Availability [Zones]' }, { id: 'scale-set', label: 'Scale Set "VMs"' }],
  }).doc;
  const saved = manager.serialize(changed.toJSON());
  assert.match(saved, /#variant\/zones/); assert.ok(saved.includes(zone));
  const reparsed = parse(saved);
  assert.equal(reparsed.firstChild!.attrs.options[0].label, 'Availability [Zones]');
  assert.equal(reparsed.firstChild!.attrs.options[1].label, 'Scale Set "VMs"');
  assert.equal(reparsed.firstChild!.attrs.title, 'Choose your deployment');
});

test('each tab has editable body and label; editing one retains every alternative', () => {
  const { parse, manager } = fixture();
  const raw = '# [First](#tab/first)\n\nFirst **body**.\n\n# [Second](#tab/second)\n\nSecond body.\n\n---';
  const doc = parse(raw);
  assert.equal(types(doc).filter(type => type === 'lekhTab').length, 2);
  const edited = changeText(doc, 'Second body.');
  const panel = edited.firstChild!.child(1);
  const pos = 1 + edited.firstChild!.child(0).nodeSize;
  const renamed = EditorState.create({ schema: doc.type.schema, doc: edited }).tr.setNodeMarkup(pos, undefined, { ...panel.attrs, label: 'Scale [Set] \\ example' }).doc;
  const saved = manager.serialize(renamed.toJSON());
  const parsed = parse(saved);
  assert.equal(parsed.firstChild!.child(1).attrs.label, 'Scale [Set] \\ example');
  assert.match(parsed.firstChild!.child(1).textContent, /Second body\. edited/);
  assert.match(saved, /First \*\*body\*\*/);
  assert.equal(parsed.firstChild!.childCount, 2);
});

test('nested alerts, lists, code, tables and tab groups preserve editable structure', () => {
  const { parse, manager } = fixture();
  const raw = `${selector}\n\n:::zone pivot="zones,scale-set"\n> [!NOTE]\n> Rich **alert**.\n\n:::steps\n1. One\n2. Two\n:::steps-end\n\n:::tabs\n:::tab Code\n\`\`\`js\nconst x = \":::zone-end\";\n\`\`\`\n:::tab-end\n:::tab Table\n| A | B |\n| - | - |\n| 1 | 2 |\n:::tab-end\n:::tabs-end\n:::zone-end`;
  const doc = parse(raw);
  for (const type of ['lekhZone', 'lekhAlert', 'lekhSteps', 'lekhTabs', 'lekhTab', 'codeBlock', 'table']) assert.ok(types(doc).includes(type), type);
  const edited = changeText(doc, 'Rich ', 'excellent ');
  const saved = manager.serialize(edited.toJSON());
  const reparsed = parse(saved);
  reparsed.check();
  assert.match(reparsed.textContent, /Rich excellent/);
  assert.match(saved, /:::zone pivot="zones,scale-set"/);
  assert.match(saved, /const x = ":::zone-end";/);
});

test('metadata edits preserve arbitrary fields/comments and avoid evaluating YAML', () => {
  const raw = '# Kept comment\ntitle: Old\ndescription: Old description\ncustom: [one, two]\nunsafe: !!js/function >\n  function(){}\n';
  const changed = updateMetadataValue(raw, 'title', 'New: "quoted" title');
  assert.ok(changed.includes('# Kept comment'));
  assert.ok(changed.includes('custom: [one, two]'));
  assert.ok(changed.includes('unsafe: !!js/function'));
  assert.ok(changed.includes('title: "New: \\"quoted\\" title"'));
  assert.throws(() => updateMetadataValue('title: |\n  Multiline\n', 'title', 'Changed'), /multiline/);
  assert.equal(updateMetadataValue('title: "Keep # literal" # keep comment\n', 'title', 'Changed'), 'title: "Changed" # keep comment\n');
  assert.equal(updateMetadataValue('title: "Keep # literal"\n', 'title', 'Changed'), 'title: "Changed"\n');
  const { parse, manager } = fixture();
  const doc = parse(`---\n${raw}---\n\nBody.`);
  const metadata = doc.firstChild!;
  const edited = EditorState.create({ schema: doc.type.schema, doc }).tr.setNodeMarkup(0, undefined, { ...metadata.attrs, yaml: changed }).doc;
  const saved = manager.serialize(edited.toJSON());
  assert.ok(saved.includes(changed.trimEnd()));
  assert.match(saved, /Body\./);
  assert.doesNotMatch(documentPreviewHTML(saved, 'test'), /<script\b|<iframe\b/);
});

test('reference consumers in edited and sibling publishing containers retain destinations', async () => {
  const { parse, manager } = fixture();
  const raw = ':::zone pivot="a"\nProducer text.\n\n[target]: https://example.com/path "Title"\n:::zone-end\n\n:::tabs\n:::tab First\n[Use][target]\n:::tab-end\n:::tab Second\nOther.\n:::tab-end\n:::tabs-end\n\n> [!NOTE]\n> [Sibling][target]';
  const saved = manager.serialize(changeText(parse(raw), 'Producer text.').toJSON());
  assert.ok(saved.includes('[target]: https://example.com/path "Title"'));
  const html = await toOfflineHTML(saved, null);
  assert.ok(html.includes('https://example.com/path'));
  assert.match(html, /Sibling/);
  await assert.rejects(() => toDocx(saved, async () => { throw new Error('No image expected.'); }), /Word and PDF export.*HTML/);
  await assert.rejects(() => toPrintHTML(saved, null), /Word and PDF export.*HTML/);
});

test('all tabs and variants remain in interactive HTML after Visual model editing', async () => {
  const { parse, manager } = fixture();
  const raw = `${selector}\n\n${zone}\n\n:::zone pivot="scale-set"\nScale Set content.\n:::zone-end\n\n# [First](#tab/first)\n\nFirst body.\n\n# [Second](#tab/second)\n\nSecond body.\n\n---`;
  const saved = manager.serialize(changeText(parse(raw), 'Second body.').toJSON());
  const html = await toOfflineHTML(saved, null);
  for (const text of ['Availability Zones', 'Scale Set content.', 'First body.', 'Second body. edited']) assert.ok(html.includes(text), text);
  await assert.rejects(() => toDocx(saved, async () => { throw new Error('No image expected.'); }), /Word and PDF export.*HTML/);
  await assert.rejects(() => toPrintHTML(saved, null), /Word and PDF export.*HTML/);
});

test('selector insertion is separate from content and never discards selected text', () => {
  assert.doesNotMatch(publishingTemplateMarkdown('publishing-selector')!, /:::zone/);
  assert.ok(publishingTemplateMarkdown('publishing-selector', 'Retain selected **text**.')!.endsWith('Retain selected **text**.'));
});

test('variant labels work before the selector, and literal escapes/entities survive edits', () => {
  const { parse, manager } = fixture();
  const doc = parse(`${zone}\n\n${selector}`);
  const selectorPosition = doc.firstChild!.nodeSize;
  const choices = doc.child(1);
  const changed = EditorState.create({ schema: doc.type.schema, doc }).tr.setNodeMarkup(selectorPosition, undefined, {
    ...choices.attrs, options: [{ id: 'zones', label: 'Zone \\[literal] &amp;' }, { id: 'scale-set', label: 'Scale & Set' }],
  }).doc;
  const saved = manager.serialize(changed.toJSON());
  assert.equal(parse(saved).child(1).attrs.options[0].label, 'Zone \\[literal] &amp;');
  assert.ok(documentPreviewHTML(saved, 'test').includes('Zone \\[literal] &amp;amp;'));
  assert.match(documentPreviewHTML(`${zone}\n\n${selector}`, 'test'), /publishing-zone-label">Availability Zones/);
});

test('unsupported/deep syntax is retained rather than silently flattened', () => {
  const { parse, manager } = fixture();
  const raw = ':::unknown option="value"\nUnrecognized **body**.\n:::unknown-end';
  assert.equal(parse(raw).firstChild?.type.name, 'lekhPublishing');
  assert.equal(manager.serialize(parse(raw).toJSON()), raw);
  assert.equal(editablePublishingBlockAtStart('```text\n:::zone pivot="a"\n```'), null);
});

test('division body edits preserve an unquoted title without progressively escaping it', () => {
  const { parse, manager } = fixture();
  const title = 'Custom "title" \\ here';
  let doc = parse(`> [!div class="nextstepaction"] ${title}\n> Body text.`);
  for (let cycle = 0; cycle < 3; cycle++) {
    doc = parse(manager.serialize(changeText(doc, 'Body text.').toJSON()));
    assert.equal(doc.firstChild!.attrs.title, title);
    assert.ok(manager.serialize(doc.toJSON()).startsWith(`> [!div class="nextstepaction"] ${title}\n`));
  }
});
