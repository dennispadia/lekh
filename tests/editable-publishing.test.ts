import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, getSchema } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Marked } from 'marked';
import type { Schema, Node as ModelNode } from '@tiptap/pm/model';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { closeHistory, history, undo } from '@tiptap/pm/history';
import { AlertNode } from '../src/alert-node.js';
import { PublishingNode } from '../src/publishing-node.js';
import { LanguageCodeBlock } from '../src/code-block.js';
import { EditablePublishing } from '../src/editable-publishing.js';
import { prepareVariantInsertion, reachableVariantChoices, selectInsertedVariant, validateSourceVariantInsertion, validateVariantAssignment, variantInsertionPosition } from '../src/publishing-insert.js';
import { editablePublishingBlockAtStart, includeMarkdown } from '../lib/publishing.js';
import { publishingTemplateMarkdown } from '../lib/publishing-templates.js';
import { documentPreviewHTML } from '../lib/markdown.js';
import { toDocx, toOfflineHTML, toPrintHTML } from '../lib/export.js';

function fixture() {
  let schema: Schema;
  const extensions = [
    StarterKit.configure({ trailingNode: false, codeBlock: false, link: { openOnClick: false } }), LanguageCodeBlock, Image,
    TableKit, TaskList, TaskItem.configure({ nested: true }),
    AlertNode.configure({ schema: () => schema }), EditablePublishing.configure({ schema: () => schema }), PublishingNode,
  ];
  schema = getSchema(extensions);
  const manager = new MarkdownManager({ extensions, marked: new Marked() as unknown as typeof import('marked').marked });
  const parse = (source: string) => schema.nodeFromJSON(manager.parse(source));
  return { schema, manager, parse, extensions };
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

test('code-only variant bodies retain their editable code with the desktop language extension', () => {
  const { parse, manager } = fixture();
  for (const spacing of ['', '\n']) {
    const code = 'sudo zypper -n install sbd';
    const raw = `:::zone pivot="sbd-shared-disk"\n${spacing}\`\`\`bash\n${code}\n\`\`\`\n${spacing}:::zone-end`;
    for (const context of ['document', 'list', 'quote']) {
      const source = context === 'list' ? `1. Install fencing packages.\n\n${raw.split('\n').map(line => `   ${line}`).join('\n')}`
        : context === 'quote' ? raw.split('\n').map(line => `> ${line}`).join('\n') : raw;
      const doc = parse(source);
      const zones: ModelNode[] = [];
      doc.descendants(node => { if (node.type.name === 'lekhZone') zones.push(node); });
      assert.equal(zones.length, 1, source);
      assert.equal(zones[0].textContent, code, `Variant content in ${context}`);
      const codeBlock = Array.from({ length: zones[0].childCount }, (_, index) => zones[0].child(index)).find(node => node.type.name === 'codeBlock');
      assert.ok(codeBlock);
      assert.equal(codeBlock.attrs.language, 'bash');
      const reopenedCode: string[] = [];
      parse(manager.serialize(doc.toJSON())).descendants(node => {
        if (node.type.name === 'codeBlock') reopenedCode.push(node.textContent);
      });
      assert.deepEqual(reopenedCode, [code], 'Code survives serialization and reopening without whitespace changes');
      if (context === 'document') assert.equal(manager.serialize(doc.toJSON()).trimEnd(), raw);
      const edited = changeText(doc, code);
      assert.ok(manager.serialize(edited.toJSON()).includes(`${code} edited`));
    }
  }
});

test('indented backtick and tilde fences retain language, whitespace and following content', () => {
  const { parse, manager } = fixture();
  const code = 'def setup():\n    return "ready"';
  for (const fence of ['```', '~~~']) {
    for (const indent of ['', ' ', '  ', '   ']) {
      const doc = parse(`Before.\n\n${indent}${fence}python\n${code.split('\n').map(line => indent + line).join('\n')}\n${indent}${fence}\n\nAfter.`);
      assert.equal(doc.child(1).type.name, 'codeBlock');
      assert.equal(doc.child(1).attrs.language, 'python');
      assert.equal(doc.child(1).textContent, code);
      const reloaded = parse(manager.serialize(changeText(doc, 'Before.').toJSON()));
      assert.equal(reloaded.child(1).textContent, code);
      assert.ok(reloaded.textContent.endsWith('After.'));
    }
  }
  const indented = parse('    not a fenced block\n    keep indentation');
  assert.equal(indented.firstChild?.type.name, 'codeBlock');
  assert.equal(indented.firstChild?.textContent, 'not a fenced block\nkeep indentation');
});

test('editing one fenced variant inside list items retains every alternative on reopen', () => {
  const { parse, manager } = fixture();
  const commands = ['sudo zypper -n install sbd', 'sudo zypper -n install sbd open-iscsi'];
  for (const [prefix, indent] of [['1. ', '   '], ['- ', '  '], ['- [ ] ', '  ']]) {
    const source = `${prefix}Install fencing packages.\n\n` + commands.map((code, index) =>
      [`:::zone pivot="variant-${index}"`, '```bash', code, '```', ':::zone-end'].map(line => indent + line).join('\n'))
      .join('\n\n') + `\n\n${prefix === '1. ' ? '2. ' : prefix}Configure DNS.`;
    const edited = changeText(parse(source), commands[0], '\n# Edited in Visual');
    const saved = manager.serialize(edited.toJSON());
    const reopened = parse(saved);
    const zones: ModelNode[] = [];
    reopened.descendants(node => { if (node.type.name === 'lekhZone') zones.push(node); });
    assert.equal(zones.length, 2, saved);
    assert.deepEqual(zones.map(node => node.textContent), [commands[0] + '\n# Edited in Visual', commands[1]]);
    assert.ok(reopened.textContent.endsWith('Configure DNS.'));
  }
});

test('a zone directly after list text contains both implicit DocFX tabs without a terminator', () => {
  const { parse, manager } = fixture();
  const commands = ['sudo crm configure primitive rsc_ASCS_ENSA2', 'sudo crm configure primitive rsc_ASCS_ENSA1'];
  const source = '1. Create the ASCS and ERS services.\n   :::zone pivot="azurefiles"\n' +
    commands.map((code, index) => `   #### [ENSA${2 - index}](#tab/ensa${2 - index})\n   \`\`\`bash\n   ${code}\n   \`\`\``).join('\n\n') +
    '\n   :::zone-end\n\n2. Continue setup.';
  const doc = parse(source);
  assert.equal(types(doc).filter(type => type === 'lekhZone').length, 1);
  assert.equal(types(doc).filter(type => type === 'lekhTabs').length, 1);
  assert.equal(types(doc).filter(type => type === 'lekhTab').length, 2);
  assert.ok(!types(doc).includes('lekhPublishing'), 'Valid zone boundaries and tab panels never become unsupported blocks');
  for (const code of commands) assert.ok(doc.textContent.includes(code));
  const saved = manager.serialize(changeText(doc, commands[0]).toJSON());
  const reopened = parse(saved);
  assert.equal(types(reopened).filter(type => type === 'lekhZone').length, 1, saved);
  assert.equal(types(reopened).filter(type => type === 'lekhTab').length, 2, saved);
  assert.ok(!types(reopened).includes('lekhPublishing'), saved);
  for (const code of [commands[0] + ' edited', commands[1]]) assert.ok(reopened.textContent.includes(code));
});

test('zone examples inside list code fences remain literal when a real zone follows', () => {
  const { parse, manager } = fixture();
  for (const fence of ['```', '~~~']) {
    for (const newline of ['\n', '\r\n']) {
      for (const includeZone of [false, true]) {
        const lines = [
          '1. Read the example.',
          `   ${fence}markdown`,
          '   :::zone pivot="literal"',
          '   Example',
          '   :::zone-end',
          `   ${fence}`,
          ...(includeZone ? ['   :::zone pivot="real"', '   Actual content.', '   :::zone-end'] : []),
          '',
          '2. Continue.',
          '',
          'After the list.',
        ];
        const doc = parse(lines.join(newline));
        doc.check();
        const codes: ModelNode[] = [];
        const zones: ModelNode[] = [];
        doc.descendants(node => {
          if (node.type.name === 'codeBlock') codes.push(node);
          if (node.type.name === 'lekhZone') zones.push(node);
        });
        assert.equal(codes.length, 1);
        assert.deepEqual(codes[0].textContent.split('\n').map(line => line.trimStart()),
          [':::zone pivot="literal"', 'Example', ':::zone-end']);
        assert.equal(zones.length, Number(includeZone));
        if (includeZone) assert.match(zones[0].textContent, /Actual content\./);
        assert.ok(!types(doc).includes('lekhPublishing'));
        assert.ok(doc.textContent.endsWith('After the list.'));
        const reopened = parse(manager.serialize(doc.toJSON()));
        assert.ok(reopened.textContent.includes('After the list.'));
        assert.equal(types(reopened).filter(type => type === 'lekhZone').length, Number(includeZone));
      }
    }
  }
});

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

test('include titles and file paths survive parsing and visual edits', () => {
  const { parse, manager } = fixture();
  const raw = includeMarkdown('Setup [Linux] & Windows', '../includes/setup (guide).md');
  const doc = parse(raw);
  assert.equal(doc.firstChild?.type.name, 'lekhInclude');
  assert.equal(doc.firstChild?.attrs.label, 'Setup [Linux] & Windows');
  assert.equal(doc.firstChild?.attrs.source, '../includes/setup%20%28guide%29.md');
  assert.equal(manager.serialize(doc.toJSON()).trimEnd(), raw);
  const edited = EditorState.create({ schema: doc.type.schema, doc }).tr.setNodeMarkup(0, undefined, {
    ...doc.firstChild!.attrs, label: 'Updated title', source: '../includes/new.md',
  }).doc;
  assert.equal(manager.serialize(edited.toJSON()).trimEnd(), '[!INCLUDE [Updated title](../includes/new.md)]');
  assert.equal(parse(manager.serialize(edited.toJSON())).firstChild?.attrs.source, '../includes/new.md');
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

test('new variant content receives the caret at boundaries, in selections, and inside existing variants', () => {
  const { manager, extensions } = fixture();
  const document = `Before selector.\n\n${selector}\n\nAfter selector.\n\n:::zone pivot="zones"\nExisting variant.\n:::zone-end`;
  const cases: Array<[string, number, number]> = [
    ['Before selector.', 0, 0],
    ['Before selector.', 7, 7],
    ['Before selector.', 16, 16],
    ['Before selector.', 0, 6],
    ['After selector.', 0, 0],
    ['After selector.', 15, 15],
    ['Existing variant.', 0, 0],
    ['Existing variant.', 8, 8],
    ['Existing variant.', 17, 17],
    ['Existing variant.', 0, 8],
  ];
  for (const [text, start, end] of cases) {
    const editor = new Editor({ element: null, extensions, content: manager.parse(document) });
    const { doc } = editor.state;
    let textPosition: number | undefined;
    doc.descendants((node, offset) => {
      if (node.isText && node.text === text) textPosition = offset;
    });
    assert.notEqual(textPosition, undefined, text);
    const from = textPosition! + start, to = textPosition! + end;
    const state = EditorState.create({ schema: editor.schema, doc, selection: TextSelection.create(doc, from, to), plugins: [history()] });
    editor.view.updateState(state);
    const selected = text.slice(start, end);
    const raw = `:::zone pivot="zones"\n${selected}\n:::zone-end`;
    const insertion = prepareVariantInsertion(editor.schema, manager.parse(raw).content ?? []);
    assert.equal(editor.chain().command(({ tr }) => { closeHistory(tr); return true; })
      .insertContent(insertion.content).command(({ tr }) => { selectInsertedVariant(tr, insertion.zone); return true; }).run(), true);
    const result = editor.state;
    const caret = result.selection.$from;
    assert.ok(Array.from({ length: caret.depth }, (_, index) => caret.node(index + 1)).includes(insertion.zone),
      `The caret is inside the newly inserted zone for ${text} at ${start}-${end}`);
    assert.equal(result.doc.textContent, doc.textContent, 'Insertion preserves surrounding and selected text');
    let inserted = 0;
    result.doc.descendants(node => { if (node === insertion.zone) inserted++; });
    assert.equal(inserted, 1, 'Only the new zone is targeted');
    assert.equal(undo(result, tr => editor.view.dispatch(tr)), true);
    assert.ok(editor.state.doc.eq(doc), `One undo restores ${text} at ${start}-${end}`);
    editor.destroy();
  }
});

test('variant insertion replaces an empty paragraph and is independently undoable', () => {
  const { manager, extensions } = fixture();
  const content = [...(manager.parse(selector).content ?? []), { type: 'paragraph' }];
  const editor = new Editor({ element: null, extensions, content: { type: 'doc', content } });
  const doc = editor.state.doc;
  const position = doc.firstChild!.nodeSize + 1;
  editor.view.updateState(EditorState.create({
    schema: editor.schema, doc, selection: TextSelection.create(doc, position), plugins: [history()],
  }));
  const insertion = prepareVariantInsertion(editor.schema, manager.parse(':::zone pivot="zones"\n\n:::zone-end').content ?? []);
  assert.equal(editor.chain().command(({ tr }) => { closeHistory(tr); return true; })
    .insertContent(insertion.content).command(({ tr }) => { selectInsertedVariant(tr, insertion.zone); return true; }).run(), true);
  assert.equal(editor.state.doc.childCount, 3, 'The empty paragraph is replaced by the variant and a following paragraph');
  assert.equal(editor.state.selection.$from.node(1), insertion.zone);
  assert.equal(undo(editor.state, tr => editor.view.dispatch(tr)), true);
  assert.ok(editor.state.doc.eq(doc));
  editor.destroy();
});

test('variant insertion follows a selected block instead of wrapping or replacing it', () => {
  const { manager, extensions, parse } = fixture();
  for (const source of [selector, '[!INCLUDE [Shared](./shared.md)]', '---\ntitle: Document\n---',
    ':::image type="content" source="image.png" alt-text="Diagram":::']) {
    const editor = new Editor({ element: null, extensions, content: manager.parse(source) });
    const doc = editor.state.doc;
    editor.view.updateState(EditorState.create({
      schema: editor.schema, doc, selection: NodeSelection.create(doc, 0), plugins: [history()],
    }));
    const position = variantInsertionPosition(editor.state.selection);
    assert.equal(position, doc.firstChild!.nodeSize);
    const insertion = prepareVariantInsertion(editor.schema, manager.parse(':::zone pivot="zones"\n\n:::zone-end').content ?? []);
    assert.equal(editor.chain().command(({ tr }) => { closeHistory(tr); return true; })
      .insertContentAt(position!, insertion.content).command(({ tr }) => { selectInsertedVariant(tr, insertion.zone); return true; }).run(), true);
    assert.ok(editor.state.doc.child(0).eq(doc.child(0)), 'The selected block is unchanged');
    assert.equal(editor.state.doc.child(1), insertion.zone);
    assert.equal(editor.state.doc.child(2).type.name, 'paragraph');
    assert.equal(editor.state.selection.$from.node(1), insertion.zone, 'The caret enters the new variant');
    assert.equal(undo(editor.state, tr => editor.view.dispatch(tr)), true);
    assert.ok(editor.state.doc.eq(doc), 'One undo restores the original block');
    editor.destroy();
  }
  const text = parse('Selected text.');
  assert.equal(variantInsertionPosition(TextSelection.create(text, 1, 9)), undefined, 'Text selections remain eligible for wrapping');
});

test('variant insertion reports malformed or missing inserted content', () => {
  const { parse, schema, manager } = fixture();
  assert.throws(() => prepareVariantInsertion(schema, [{ type: 'paragraph' }]), /could not be prepared/);
  const insertion = prepareVariantInsertion(schema, manager.parse(':::zone pivot="zones"\n\n:::zone-end').content ?? []);
  const tr = EditorState.create({ schema, doc: parse('Existing content.') }).tr;
  assert.throws(() => selectInsertedVariant(tr, insertion.zone), /could not be located/);
});

test('nested variant insertion keeps an enclosing choice visible and rejects unreachable content', () => {
  const { manager, extensions } = fixture();
  const source = `${selector}\n\n:::zone pivot="zones,scale-set"\nOuter.\n\n:::zone pivot="zones"\nInner.\n:::zone-end\n:::zone-end`;
  const editor = new Editor({ element: null, extensions, content: manager.parse(source) });
  const doc = editor.state.doc;
  let position = 0;
  doc.descendants((node, offset) => { if (node.isText && node.text === 'Inner.') position = offset + node.nodeSize; });
  editor.view.updateState(EditorState.create({ schema: editor.schema, doc, selection: TextSelection.create(doc, position) }));
  const insertion = prepareVariantInsertion(editor.schema, manager.parse(':::zone pivot="scale-set,zones"\n\n:::zone-end').content ?? []);
  let reachable: string[] = [];
  assert.equal(editor.chain().insertContent(insertion.content).command(({ tr }) => {
    reachable = selectInsertedVariant(tr, insertion.zone);
    return true;
  }).run(), true);
  assert.deepEqual(reachable, ['zones'], 'The selected option must reveal every enclosing variant');
  assert.equal(editor.state.selection.$from.node(editor.state.selection.$from.depth - 1), insertion.zone);

  editor.view.updateState(EditorState.create({ schema: editor.schema, doc, selection: TextSelection.create(doc, position) }));
  const disjoint = prepareVariantInsertion(editor.schema, manager.parse(':::zone pivot="scale-set"\n\n:::zone-end').content ?? []);
  assert.throws(() => editor.chain().insertContent(disjoint.content).command(({ tr }) => {
    selectInsertedVariant(tr, disjoint.zone);
    return true;
  }).run(), /share.*option/i);
  assert.ok(editor.state.doc.eq(doc), 'An unreachable insertion does not modify the document');
  editor.destroy();
});

test('changing variant assignments preserves reachability of nested alternatives', () => {
  const { parse } = fixture();
  const doc = parse(':::zone pivot="zones,scale-set"\nOuter.\n\n:::zone pivot="zones"\nInner.\n:::zone-end\n:::zone-end');
  let inner = -1;
  doc.descendants((node, offset) => { if (node.type.name === 'lekhZone' && offset > 0) inner = offset; });
  assert.ok(inner > 0);
  assert.deepEqual(validateVariantAssignment(doc, 0, ['zones']), ['zones']);
  assert.throws(() => validateVariantAssignment(doc, 0, ['scale-set']), /share.*option/i);
  assert.throws(() => validateVariantAssignment(doc, inner, ['unrelated']), /share.*option/i);
  assert.deepEqual(reachableVariantChoices(doc, inner, ['scale-set', 'zones']), ['scale-set', 'zones']);
  assert.throws(() => validateVariantAssignment(doc, inner, []), /at least one option/i);
});

test('Markdown variant insertion rejects unreachable nesting without changing source', () => {
  const outer = `${selector}\n\n:::zone pivot="zones"\nInsert here.\n:::zone-end`;
  const at = outer.indexOf('Insert here.') + 'Insert here.'.length;
  const candidate = (raw: string) => `${outer.slice(0, at)}\n\n${raw}\n\n${outer.slice(at)}`;
  assert.doesNotThrow(() => validateSourceVariantInsertion(candidate(':::zone pivot="scale-set,zones"\n\n:::zone-end'), at + 2));
  assert.throws(() => validateSourceVariantInsertion(candidate(':::zone pivot="scale-set"\n\n:::zone-end'), at + 2), /share.*option/i);
  const wrapper = candidate(':::zone pivot="zones"\n:::zone pivot="scale-set"\nHidden.\n:::zone-end\n:::zone-end');
  assert.throws(() => validateSourceVariantInsertion(wrapper, at + 2), /share.*option/i);
  const fenced = '```md\n\n:::zone pivot="zones"\n\n:::zone-end\n\n```';
  assert.throws(() => validateSourceVariantInsertion(fenced, fenced.indexOf(':::zone')), /could not be inserted/i);
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

test('renamed tab labels become readable source tab identifiers', () => {
  const { parse, manager } = fixture();
  const doc = parse('# [First example](#tab/firstexample)\nFirst.\n\n# [Second example](#tab/secondexample)\nSecond.\n\n# [Third example](#tab/thirdexample)\nThird.\n\n---');
  const group = doc.firstChild!;
  let position = 1;
  let tr = EditorState.create({ schema: doc.type.schema, doc }).tr;
  for (const [index, name] of ['MSI', 'Service Principal', 'Both'].entries()) {
    const panel = tr.doc.firstChild!.child(index);
    tr = tr.setNodeMarkup(position, undefined, { ...panel.attrs, label: name });
    position += panel.nodeSize;
  }
  const saved = manager.serialize(tr.doc.toJSON());
  assert.match(saved, /# \[MSI\]\(#tab\/msi\)/);
  assert.match(saved, /# \[Service Principal\]\(#tab\/serviceprincipal\)/);
  assert.match(saved, /# \[Both\]\(#tab\/both\)/);
});

test('new interactive cards have empty prompts and bodies, not sample document text', async () => {
  const { parse, manager } = fixture();
  const tabs = parse(publishingTemplateMarkdown('publishing-tabs')!);
  assert.equal(tabs.firstChild?.type.name, 'lekhTabs');
  assert.equal(tabs.firstChild?.childCount, 2);
  assert.equal(tabs.textContent, '');
  for (const panel of tabs.firstChild!.content.content) {
    assert.equal(panel.childCount, 1);
    assert.equal(panel.firstChild?.type.name, 'paragraph');
    assert.equal(panel.firstChild?.content.size, 0);
  }
  const raw = `${publishingTemplateMarkdown('publishing-selector')}\n\n:::zone pivot="first"\n\n:::zone-end`;
  const content = parse(raw);
  assert.equal(content.firstChild!.attrs.title, '');
  assert.equal(content.textContent, '');
  assert.equal(parse(manager.serialize(content.toJSON())).firstChild!.attrs.title, '');
  const saved = manager.serialize(tabs.toJSON());
  assert.equal(parse(saved).textContent, '');
  const html = await toOfflineHTML(`${raw}\n\n${saved}`, null);
  assert.doesNotMatch(html, /Write this example|Write content for|Write a prompt|Content for the first example/);
  assert.match(html, /aria-label="Variant options"/, 'An empty prompt retains accessible selector controls in exports');
});

test('clearing an existing selector prompt persists through serialization and reload', () => {
  const { parse, manager } = fixture();
  const doc = parse(`${selector}\n\n${zone}`);
  const cleared = EditorState.create({ schema: doc.type.schema, doc }).tr.setNodeMarkup(0, undefined, {
    ...doc.firstChild!.attrs, title: '',
  }).doc;
  const saved = manager.serialize(cleared.toJSON());
  assert.match(saved, /:::selector title=""/);
  assert.equal(parse(saved).firstChild!.attrs.title, '');
  assert.ok(saved.includes(zone), 'Clearing a prompt never changes authored variant content');
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

test('metadata YAML is edited as one field, preserving arbitrary fields/comments without evaluating YAML', () => {
  const raw = '# Kept comment\ntitle: Old\ndescription: Old description\ncustom: [one, two]\nunsafe: !!js/function >\n  function(){}\n';
  const { parse, manager } = fixture();
  const doc = parse(`---\n${raw}---\n\nBody.`);
  const metadata = doc.firstChild!;
  const changed = raw.replace('title: Old', 'title: "New: \\"quoted\\" title"');
  const edited = EditorState.create({ schema: doc.type.schema, doc }).tr.setNodeMarkup(0, undefined, { ...metadata.attrs, yaml: changed }).doc;
  const saved = manager.serialize(edited.toJSON());
  assert.ok(saved.includes('# Kept comment'));
  assert.ok(saved.includes('title: "New: \\"quoted\\" title"'));
  assert.ok(saved.includes('custom: [one, two]'));
  assert.ok(saved.includes('unsafe: !!js/function'));
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
