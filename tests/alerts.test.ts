import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { Markdown, MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { TableKit } from '@tiptap/extension-table';
import { joinBackward, liftEmptyBlock, splitBlock } from '@tiptap/pm/commands';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import type { Schema } from '@tiptap/pm/model';
import { Marked } from 'marked';
import { AlertNode, MAX_ALERT_DEPTH, alertKinds, editableAlertAtStart } from '../src/alert-node.js';
import { PublishingNode } from '../src/publishing-node.js';
import { toDocx, toOfflineHTML, toPrintHTML } from '../lib/export.js';

function fixture() {
  let schema: Schema;
  const extensions = [
    StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }),
    Image, TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }),
    AlertNode.configure({ schema: () => schema }), PublishingNode,
  ];
  schema = getSchema(extensions);
  const manager = new MarkdownManager({ extensions, marked: new Marked() as unknown as typeof import('marked').marked });
  const parse = (source: string) => schema.nodeFromJSON(manager.parse(source));
  return { schema, manager, parse };
}

function headless(content: JSONContent) {
  return new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }),
      AlertNode,
      Markdown.configure({ marked: new Marked() as unknown as typeof import('marked').marked }),
    ],
    content,
  });
}

function allTypes(node: JSONContent): string[] {
  return [node.type ?? '', ...(node.content ?? []).flatMap(allTypes)];
}

function destinations(node: JSONContent): { type: string; href: string; title: string | null }[] {
  const result = (node.marks ?? []).filter(mark => mark.type === 'link').map(mark => ({
    type: 'link', href: String(mark.attrs?.href), title: mark.attrs?.title ?? null,
  }));
  if (node.type === 'image') result.push({ type: 'image', href: String(node.attrs?.src), title: node.attrs?.title ?? null });
  return [...result, ...(node.content ?? []).flatMap(destinations)];
}

test('only the five common alert types use an editable, non-isolating block container', () => {
  const { schema, parse } = fixture();
  assert.equal(schema.nodes.lekhAlert.spec.content, 'block+');
  assert.notEqual(schema.nodes.lekhAlert.spec.atom, true);
  assert.notEqual(schema.nodes.lekhAlert.spec.isolating, true);
  for (const kind of alertKinds) {
    const source = `> [!${kind.toUpperCase()}]\n> Editable ${kind}`;
    assert.equal(editableAlertAtStart(source)?.kind, kind);
    const alert = parse(source).firstChild!;
    assert.equal(alert.type.name, 'lekhAlert');
    assert.equal(alert.firstChild?.type.name, 'paragraph');
    assert.equal(alert.textContent, `Editable ${kind}`);
  }
  for (const source of [
    '> [!div class="checklist"]\n> A task',
    '> [!div class="nextstepaction"]\n> [Go](next.md)',
    '> [!CHECKLIST]\n> A task',
    '::: note\nNot a common alert\n:::',
    '> Ordinary quotation',
    '> [!NOTE]suffix\n> Not a valid header',
  ]) assert.equal(editableAlertAtStart(source), null);
});

test('exact unchanged raw Markdown survives PM schema defaults and unrelated edits', () => {
  const { schema, manager, parse } = fixture();
  const raw = '> [!nOtE]  Résumé 日本語 🚀  \n> _Keep_ **formatting** and [link](https://example.com "Title")  \n> next\n>\n> ![चित्र](images/pic.png "Photo")\n>\n> ```js\n> const x = "<tag>";\n> ```';
  const document = parse(`${raw}\n\nAfter`);
  document.check();
  const alert = document.firstChild!;
  const link = alert.firstChild!.firstChild;
  assert.ok(link);
  const linkMarks: Record<string, unknown>[] = [];
  alert.descendants(node => {
    for (const mark of node.marks) if (mark.type.name === 'link') linkMarks.push(mark.attrs);
  });
  assert.equal(linkMarks[0].target, '_blank');
  assert.ok(linkMarks[0].rel);
  assert.equal(alert.child(1).type.name, 'image');
  assert.equal(alert.child(1).attrs.width, null);
  assert.equal(manager.serialize(document.toJSON()), `${raw}\n\nAfter`);
  const position = document.content.size - 1;
  const changed = EditorState.create({ schema, doc: document }).tr.insertText(' edited', position).doc;
  assert.equal(manager.serialize(changed.toJSON()), `${raw}\n\nAfter edited`);
  assert.equal(manager.serialize(schema.nodeFromJSON(changed.toJSON()).toJSON()), `${raw}\n\nAfter edited`);
});

test('raw bodies round-trip lists, code, images, Unicode and nested quotes/alerts', () => {
  const { manager, parse } = fixture();
  const samples = [
    '> [!TIP] Custom title\n> - one\n>   - two **bold**\n>\n> 3. three\n> 4. four',
    '> [!IMPORTANT]\n> - [x] Ready\n> - [ ] Not yet\n>\n> ![alt](https://example.com/a.png)',
    '> [!CAUTION]\n> > Quoted text\n> >\n> > Second paragraph\n>\n> End',
    '> [!WARNING] Outer\n> Before\n>\n> > [!TIP] Nested\n> > Nested _body_\n>\n> After',
    '> [!NOTE]\n> ~~~text\n> > [!WARNING]\n> literal <script> and [link](javascript:alert)\n> ~~~',
    '  >[!NOTE] Unicode Ελληνικά العربية\n  > Körper, हिन्दी, 👨‍👩‍👧‍👦',
    '> [!NOTE]',
  ];
  for (const raw of samples) {
    const doc = parse(raw);
    doc.check();
    assert.equal(manager.serialize(doc.toJSON()), raw);
  }
  const nested = parse(samples[3]);
  assert.equal(allTypes(nested.toJSON()).filter(type => type === 'lekhAlert').length, 2);
  const fenced = parse(samples[4]);
  assert.equal(allTypes(fenced.toJSON()).filter(type => type === 'lekhAlert').length, 1);
});

test('edited alert bodies serialize current structure, keeping their type and custom title', () => {
  const { schema, manager, parse } = fixture();
  const raw = '> [!WARNING]  Keep this title\n> Hello **world** and [docs](https://example.com).\n>\n> - first\n> - second\n>\n> ```ts\n> let n = 1;\n> ```\n>\n> ![alt](image.png)';
  let state = EditorState.create({ schema, doc: parse(raw) });
  state = state.apply(state.tr.insertText('new ', 2));
  const markdown = manager.serialize(state.doc.toJSON());
  assert.notEqual(markdown, raw);
  assert.match(markdown, /^> \[!WARNING\] Keep this title\n> new Hello \*\*world\*\* and \[docs\]\(https:\/\/example.com\)\./);
  const reparsed = parse(markdown);
  assert.equal(reparsed.firstChild?.attrs.title, 'Keep this title');
  assert.deepEqual(allTypes(reparsed.toJSON()), allTypes(state.doc.toJSON()));
  assert.equal(reparsed.textContent, state.doc.textContent);
});

test('editing nested alerts preserves nesting and unchanged siblings', () => {
  const { schema, manager, parse } = fixture();
  const raw = '> [!NOTE] Outer\n> Leading\n>\n> > [!TIP] Inner\n> > _inner_ [link](https://example.com)\n>\n> trailing';
  let state = EditorState.create({ schema, doc: parse(raw) });
  let innerText = 0;
  state.doc.descendants((node, pos) => { if (node.isText && node.text === 'inner') innerText = pos; });
  assert.ok(innerText);
  state = state.apply(state.tr.insertText('edited ', innerText));
  const markdown = manager.serialize(state.doc.toJSON());
  assert.match(markdown, /> > \[!TIP\] Inner/);
  const reparsed = parse(markdown);
  assert.equal(allTypes(reparsed.toJSON()).filter(type => type === 'lekhAlert').length, 2);
  assert.equal(reparsed.textContent, state.doc.textContent);
  assert.match(markdown, /trailing$/);
});

test('adjacent alerts and alert-like inline/code text do not capture one another', () => {
  const { parse } = fixture();
  const doc = parse('Before\n\n> [!NOTE]\n> One\n> [!TIP]\n> Two\n\nAfter\n\n```\n> [!WARNING]\n> literal\n```');
  assert.deepEqual(doc.content.content.map(node => node.type.name), ['paragraph', 'lekhAlert', 'lekhAlert', 'paragraph', 'codeBlock']);
  assert.equal(doc.child(1).textContent, 'One');
  assert.equal(doc.child(2).textContent, 'Two');
});

test('setAlert wraps text/selection or an empty editable paragraph and changes active kind without nesting', () => {
  const editor = headless({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First', marks: [{ type: 'bold' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
  ] });
  try {
    editor.commands.setTextSelection({ from: 2, to: 11 });
    assert.equal(editor.can().setAlert('tip'), true);
    assert.equal(editor.state.doc.firstChild?.type.name, 'paragraph');
    assert.equal(editor.commands.setAlert('tip'), true);
    assert.equal(editor.state.doc.childCount, 1);
    assert.equal(editor.state.doc.firstChild?.type.name, 'lekhAlert');
    assert.equal(editor.state.doc.firstChild?.childCount, 2);
    assert.equal(editor.state.doc.firstChild?.firstChild?.firstChild?.marks[0].type.name, 'bold');
    const selection = editor.state.selection;
    assert.equal(editor.commands.setAlert('warning'), true);
    assert.equal(editor.state.doc.firstChild?.attrs.kind, 'warning');
    assert.equal(editor.state.doc.firstChild?.childCount, 2);
    assert.equal(editor.state.selection.eq(selection), true);
    assert.equal(editor.commands.unsetAlert(), true);
    assert.equal(editor.state.doc.firstChild?.type.name, 'paragraph');
    assert.equal(editor.commands.setAlert('invalid' as 'note'), false);
  } finally { editor.destroy(); }
  const empty = headless({ type: 'doc', content: [{ type: 'paragraph' }] });
  try {
    assert.equal(empty.commands.setAlert('note'), true);
    assert.equal(empty.state.selection.$from.parent.type.name, 'paragraph');
    assert.equal(empty.state.selection.$from.node(-1).type.name, 'lekhAlert');
    empty.commands.insertContent({ type: 'text', text: 'Type here' });
    assert.equal(empty.getMarkdown(), '> [!NOTE]\n> Type here');
  } finally { empty.destroy(); }
});

test('active and node-selected kind changes invalidate raw provenance while retaining the title', () => {
  const { manager, parse } = fixture();
  const editor = headless(parse('> [!NOTE] Custom\n> Body').toJSON());
  try {
    editor.commands.setTextSelection(3);
    assert.equal(editor.commands.setAlert('caution'), true);
    assert.equal(manager.serialize(editor.getJSON()), '> [!CAUTION] Custom\n> Body');
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    assert.equal(editor.can().setAlert('important'), true);
    assert.equal(editor.commands.setAlert('important'), true);
    assert.equal(manager.serialize(editor.getJSON()), '> [!IMPORTANT] Custom\n> Body');
  } finally { editor.destroy(); }
});

test('standard PM Enter and Backspace can split, exit and lift an alert without an isolating caret trap', () => {
  const { schema, parse } = fixture();
  let state = EditorState.create({ schema, doc: parse('> [!NOTE]\n> Text') });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 6)));
  assert.equal(splitBlock(state, tr => { state = state.apply(tr); }), true);
  assert.equal(state.doc.firstChild?.childCount, 2);
  assert.equal(state.selection.$from.parent.content.size, 0);
  assert.equal(liftEmptyBlock(state, tr => { state = state.apply(tr); }), true);
  assert.equal(state.doc.lastChild?.type.name, 'paragraph');
  assert.equal(state.selection.$from.depth, 1);
  let backspace = EditorState.create({ schema, doc: parse('> [!TIP]\n> Body') });
  backspace = backspace.apply(backspace.tr.setSelection(TextSelection.create(backspace.doc, 2)));
  assert.equal(joinBackward(backspace, tr => { backspace = backspace.apply(tr); }), true);
  assert.equal(backspace.doc.firstChild?.type.name, 'paragraph');
  assert.equal(backspace.doc.textContent, 'Body');
});

test('HTML clipboard schema exports inert header text and only imports its dedicated editable body', () => {
  const { schema } = fixture();
  const alert = schema.nodes.lekhAlert.create({
    kind: 'warning',
    title: '<img src=x onerror=alert(1)>',
    sourceMarkdown: 'DO NOT EXPORT',
    sourceBaseline: 'DO NOT EXPORT EITHER',
  }, schema.nodes.paragraph.create(null, schema.text('Safe body')));
  const spec = schema.nodes.lekhAlert.spec.toDOM!(alert);
  assert.ok(Array.isArray(spec));
  assert.equal(spec[0], 'aside');
  assert.equal((spec[1] as Record<string, unknown>)['data-lekh-alert'], 'warning');
  assert.deepEqual(spec[2], ['div', { class: 'publishing-callout-title', contenteditable: 'false' }, '<img src=x onerror=alert(1)>']);
  assert.deepEqual(spec[3], ['div', { class: 'publishing-callout-body' }, 0]);
  assert.doesNotMatch(JSON.stringify(spec), /DO NOT EXPORT|sourceMarkdown|sourceBaseline|innerHTML/);
  const rules = schema.nodes.lekhAlert.spec.parseDOM!;
  const rule = rules[0];
  assert.ok('tag' in rule);
  const body = { classList: { contains: (value: string) => value === 'publishing-callout-body' } };
  const element = {
    getAttribute: (name: string) => ({ 'data-lekh-alert': 'tip', 'data-lekh-alert-title': 'Title', sourceMarkdown: '> [!WARNING]\n> Attack' })[name],
    children: [{ classList: { contains: () => false } }, body],
  } as unknown as HTMLElement;
  assert.equal(typeof rule.contentElement, 'function');
  assert.equal((rule.contentElement as (element: HTMLElement) => HTMLElement)(element), body);
  const parsedAttrs = rule.getAttrs!(element) as Record<string, unknown>;
  const attrs = schema.nodes.lekhAlert.create(parsedAttrs, schema.nodes.paragraph.create()).attrs;
  assert.equal(attrs.sourceMarkdown, null);
  assert.equal(attrs.sourceBaseline, null);
  assert.deepEqual(attrs.sourceDefinitions, []);
  assert.equal(attrs.kind, 'tip');
  assert.equal(rule.getAttrs!({ ...element, getAttribute: () => 'javascript:alert(1)' } as unknown as HTMLElement), false);
  assert.equal(rule.getAttrs!({ ...element, children: [] } as unknown as HTMLElement), false);
  const { manager } = fixture();
  const imported = schema.nodes.lekhAlert.create(parsedAttrs, schema.nodes.paragraph.create(null, schema.text('Actual clipboard body')));
  assert.equal(manager.serialize(schema.nodes.doc.create(null, imported).toJSON()), '> [!TIP] Title\n> Actual clipboard body');
});

test('real Editor Markdown initialization canonicalizes provenance with its own schema', () => {
  const raw = '> [!tIp]  Custom 日本語\n> _emphasis_ and [link](https://example.com)\n>\n> ```\n> literal <tag>\n> ```';
  const editor: Editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      AlertNode.configure({ schema: () => editor.schema }),
      Markdown.configure({ marked: new Marked() as unknown as typeof import('marked').marked }),
    ],
    contentType: 'markdown',
    content: `${raw}\n\nOutside`,
  });
  try {
    assert.equal(editor.getMarkdown(), `${raw}\n\nOutside`);
    editor.view.dispatch(editor.state.tr.insertText(' edited', editor.state.doc.content.size - 1));
    assert.equal(editor.getMarkdown(), `${raw}\n\nOutside edited`);
  } finally { editor.destroy(); }
});

test('actual link defaults preserve safe clipboard URLs and reject script URLs', () => {
  const { schema } = fixture();
  for (const href of ['https://example.com/docs?q=a&b=c', 'mailto:writer@example.com', '../relative.md']) {
    const mark = schema.marks.link.create({ href });
    const spec = schema.marks.link.spec.toDOM!(mark, true);
    assert.ok(Array.isArray(spec));
    assert.equal((spec[1] as Record<string, unknown>).href, href);
  }
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java\nscript:alert(1)', 'vbscript:msgbox(1)']) {
    const mark = schema.marks.link.create({ href });
    const spec = schema.marks.link.spec.toDOM!(mark, true);
    assert.ok(Array.isArray(spec));
    assert.equal((spec[1] as Record<string, unknown>).href, '');
  }
});

test('changed link/image attributes and stale baselines cannot resurrect original body Markdown', () => {
  const { manager, parse } = fixture();
  const raw = '> [!NOTE]\n> [old](https://example.com/old)\n>\n> ![old](old.png)';
  const doc = parse(raw).toJSON();
  const alert = doc.content![0];
  alert.content![0].content![0].marks![0].attrs!.href = 'https://example.com/new';
  alert.content![1].attrs!.src = 'new.png';
  const markdown = manager.serialize(doc);
  assert.match(markdown, /\[old\]\(https:\/\/example.com\/new\)/);
  assert.match(markdown, /!\[old\]\(new.png\)/);
  assert.doesNotMatch(markdown, /old\.png|example\.com\/old/);
  alert.attrs!.sourceBaseline = 'not JSON';
  assert.equal(manager.serialize(doc), markdown);
});

test('an unchanged sibling nested alert keeps its raw formatting when its parent is edited', () => {
  const { schema, manager, parse } = fixture();
  const raw = '> [!NOTE]\n> Outer\n>\n> >[!tIp]  Keep  spacing\n> > _inner_  \n> > two\n>\n> Last';
  let state = EditorState.create({ schema, doc: parse(raw) });
  state = state.apply(state.tr.insertText('edited ', 2));
  const markdown = manager.serialize(state.doc.toJSON());
  assert.ok(markdown.includes('> >[!tIp]  Keep  spacing\n> > _inner_  \n> > two'));
  assert.equal(parse(markdown).textContent, state.doc.textContent);
});

test('nesting is bounded to twelve editable alerts and deeper content remains intact as inert source', () => {
  const { schema, manager, parse } = fixture();
  for (const levels of [12, 13, 64, 512]) {
    const raw = Array.from({ length: levels }, (_, index) => `${'> '.repeat(index + 1)}[!NOTE] Level ${index + 1}`).join('\n') +
      `\n${'> '.repeat(levels)}Deep Unicode 日本語 and \`<script>literal</script>\``;
    const doc = parse(raw);
    doc.check();
    const types = allTypes(doc.toJSON());
    assert.equal(types.filter(type => type === 'lekhAlert').length, Math.min(levels, MAX_ALERT_DEPTH));
    assert.equal(types.filter(type => type === 'lekhAlertSource').length, levels > MAX_ALERT_DEPTH ? 1 : 0);
    assert.equal(manager.serialize(doc.toJSON()), raw);
    if (levels > MAX_ALERT_DEPTH) {
      let fallback: JSONContent | undefined;
      doc.descendants(node => { if (node.type.name === 'lekhAlertSource') fallback = node.toJSON(); });
      assert.match(String(fallback?.attrs?.markdown), /> \[!NOTE\] Level 13/);
      assert.match(String(fallback?.attrs?.markdown), /Deep Unicode 日本語 and `<script>literal<\/script>`/);
      const source = schema.nodeFromJSON(fallback!);
      const spec = source.type.spec.toDOM!(source);
      assert.ok(Array.isArray(spec));
      assert.equal(spec[0], 'pre');
      assert.equal(spec[2], fallback?.attrs?.markdown);
      assert.equal((spec[1] as Record<string, unknown>).contenteditable, 'false');
    }
  }
});

test('changing only kind/title preserves exact unchanged body syntax instead of reformatting it', () => {
  const { schema, manager, parse } = fixture();
  const body = '> _Keep_ [this](https://example.com "Title")  \n> line\n>\n> * list\n>   * nested\n>\n> ~~~js\n> let x = 1;\n> ~~~';
  const doc = parse(`> [!NOTE] Original\n${body}`);
  const changed = EditorState.create({ schema, doc }).tr.setNodeMarkup(0, undefined, {
    ...doc.firstChild!.attrs, kind: 'important', title: 'Updated',
  }).doc;
  assert.equal(manager.serialize(changed.toJSON()), `> [!IMPORTANT] Updated\n${body}`);
});

test('editing or deleting an alert definition producer cannot break another alert’s resolved links/images', () => {
  const { schema, manager, parse } = fixture();
  const source = '>[!NOTE]\n>Context.\n>\n>[ref]: https://example.com/docs\n>[pic]: logo.png\n\n>[!TIP]\n>See [docs][ref].\n>\n>![logo][pic].';
  const doc = parse(source);
  const expected = destinations(doc.toJSON());
  assert.deepEqual(expected, [
    { type: 'link', href: 'https://example.com/docs', title: null },
    { type: 'image', href: 'logo.png', title: null },
  ]);
  assert.equal(doc.child(0).attrs.sourceHasReferences, false);
  assert.equal(doc.child(1).attrs.sourceHasReferences, true);
  const state = EditorState.create({ schema, doc });
  for (const changed of [
    state.tr.insertText('Edited ', 2).doc,
    state.tr.delete(0, doc.firstChild!.nodeSize).doc,
  ]) {
    const markdown = manager.serialize(changed.toJSON());
    assert.doesNotMatch(markdown, /\[docs\]\[ref\]|!\[logo\]\[pic\]/);
    assert.deepEqual(destinations(parse(markdown).toJSON()), expected);
  }
});

test('ancestor raw preservation cannot resurrect nested reference dependencies after producer edits/deletion', () => {
  const { schema, manager, parse } = fixture();
  const source = '> [!NOTE]\n> Definitions\n>\n> > [!IMPORTANT]\n> > [ref]: https://example.com/nested "Nested title"\n> > [pic]: nested.png\n\n> [!WARNING] Outer consumer\n> Context\n>\n> > [!TIP] Inner consumer\n> > See **[docs][ref]**.\n> >\n> > ![logo][pic]';
  const doc = parse(source);
  doc.check();
  const expected = destinations(doc.toJSON());
  assert.equal(expected.length, 2);
  assert.equal(doc.child(1).attrs.sourceHasReferences, true);
  assert.equal(doc.child(1).child(1).attrs.sourceHasReferences, true);
  const state = EditorState.create({ schema, doc });
  for (const changed of [
    state.tr.insertText('Edited ', 2).doc,
    state.tr.delete(0, doc.firstChild!.nodeSize).doc,
  ]) {
    const markdown = manager.serialize(changed.toJSON());
    const reparsed = parse(markdown);
    reparsed.check();
    assert.deepEqual(destinations(reparsed.toJSON()), expected);
    assert.equal(allTypes(reparsed.toJSON()).filter(type => type === 'lekhAlert').length,
      allTypes(changed.toJSON()).filter(type => type === 'lekhAlert').length);
  }
});

test('full, collapsed, shortcut and image references retain multiline titles after their definitions are deleted', () => {
  const { schema, manager, parse } = fixture();
  const source = '> [!NOTE]\n> Definitions\n>\n> [ref]: <https://example.com/docs>\n>   "A multiline\n>   title"\n> [pic]: logo.png\n>   "Picture title"\n\n> [!TIP]\n> [full][REF], [ref][], [ref].\n>\n> ![full][pic]\n>\n> ![pic][]\n>\n> ![pic]';
  const doc = parse(source);
  doc.check();
  const expected = destinations(doc.toJSON());
  assert.equal(expected.filter(item => item.type === 'link').length, 3);
  assert.equal(expected.filter(item => item.type === 'image').length, 3);
  assert.ok(expected[0].title?.includes('\n'));
  const remaining = EditorState.create({ schema, doc }).tr.delete(0, doc.firstChild!.nodeSize).doc;
  const markdown = manager.serialize(remaining.toJSON());
  const reparsed = parse(markdown);
  reparsed.check();
  assert.deepEqual(destinations(reparsed.toJSON()), expected);
});

test('Source definition changes do not reuse stale destinations or resolve removed definitions from previous parses', () => {
  const { schema, manager, parse } = fixture();
  const consumer = '> [!TIP]\n> [docs][ref]\n>\n> ![logo][pic]';
  const producer = (url: string, image: string) => `> [!NOTE]\n> Context\n>\n> [ref]: ${url} "Title"\n> [pic]: ${image}\n\n`;
  for (const [url, image] of [['https://example.com/first', 'first.png'], ['https://example.com/second', 'second.png']]) {
    const doc = parse(producer(url, image) + consumer);
    const remaining = EditorState.create({ schema, doc }).tr.delete(0, doc.firstChild!.nodeSize).doc;
    assert.deepEqual(destinations(parse(manager.serialize(remaining.toJSON())).toJSON()), [
      { type: 'link', href: url, title: 'Title' },
      { type: 'image', href: image, title: null },
    ]);
  }
  const withoutDefinitions = parse(consumer);
  assert.equal(withoutDefinitions.firstChild!.attrs.sourceHasReferences, false);
  assert.deepEqual(destinations(withoutDefinitions.toJSON()), []);
  assert.equal(manager.serialize(withoutDefinitions.toJSON()), consumer);
  const addedAgain = parse(producer('https://example.com/added', 'added.png') + consumer);
  assert.equal(addedAgain.child(1).attrs.sourceHasReferences, true);
  assert.deepEqual(destinations(parse(manager.serialize(addedAgain.toJSON())).toJSON()), destinations(addedAgain.toJSON()));
});

test('reference-looking code, comments, escaped text and inline URLs do not disable exact raw preservation', () => {
  const { manager, parse } = fixture();
  const source = '> [!nOtE]  Keep  spacing\n> `[ref]: https://code.example/` and `[ref]`.\n>\n> ```md\n> [ref]: https://fenced.example/\n> [docs][ref]\n> ```\n>\n> <!--\n> [ref]: https://comment.example/\n> [docs][ref]\n> -->\n>\n> \\[docs\\]\\[ref\\] and [inline](https://example.com/inline).\n>\n> [docs][ref]';
  const doc = parse(source);
  assert.equal(doc.firstChild!.attrs.sourceHasReferences, false);
  assert.deepEqual(destinations(doc.toJSON()), [{ type: 'link', href: 'https://example.com/inline', title: null }]);
  assert.equal(manager.serialize(doc.toJSON()), source);
});

test('reference consumers in lists, ordinary blockquotes and table cells are self-contained', () => {
  const { schema, manager, parse } = fixture();
  const source = '> [!NOTE]\n> Definitions\n>\n> [ref]: https://example.com/docs\n\n> [!TIP]\n> - [list][ref]\n>\n> > [quote][ref]\n>\n> | Ref |\n> | --- |\n> | [table][ref] |';
  const doc = parse(source);
  const expected = destinations(doc.toJSON());
  assert.equal(expected.length, 3);
  assert.equal(doc.child(1).attrs.sourceHasReferences, true);
  const remaining = EditorState.create({ schema, doc }).tr.delete(0, doc.firstChild!.nodeSize).doc;
  const reparsed = parse(manager.serialize(remaining.toJSON()));
  reparsed.check();
  assert.deepEqual(destinations(reparsed.toJSON()), expected);
});

test('resolved reference emission safely preserves spaced URLs and escaped quoted titles for links and images', () => {
  const { schema, manager, parse } = fixture();
  for (const definition of [
    String.raw`[ref]: https://example.com/docs "A \"quoted\" title"`,
    String.raw`[ref]: <docs/my file.md> "Spaced path"`,
    String.raw`[ref]: docs/a(b).md "Parentheses"`,
    String.raw`[ref]: <docs/a\>b.md> "Angle bracket and \\ backslash"`,
  ]) {
    const source = `> [!NOTE]\n> ${definition}\n\n> [!TIP]\n> [docs][ref]\n>\n> ![logo][ref]`;
    const doc = parse(source);
    doc.check();
    const expected = destinations(doc.toJSON());
    assert.equal(expected.length, 2, definition);
    const remaining = EditorState.create({ schema, doc }).tr.delete(0, doc.firstChild!.nodeSize).doc;
    const model = remaining.toJSON();
    const before = JSON.stringify(model);
    const reparsed = parse(manager.serialize(model));
    reparsed.check();
    assert.equal(JSON.stringify(model), before, 'emission must not mutate PM JSON');
    assert.deepEqual(destinations(reparsed.toJSON()), expected, definition);
  }
});

test('editing a definition producer preserves references used by opaque tabs/zones in HTML export', async () => {
  const { schema, manager, parse } = fixture();
  const containers = [
    '# [One](#tab/one)\n\nSee [docs][ref].\n\n# [Two](#tab/two)\n\nOther.\n\n---',
    ':::zone pivot=one\n\nSee [docs][ref].\n\n:::zone-end',
  ];
  for (const container of containers) {
    const source = `>[!NOTE]\n>Context.\n>\n>[ref]: https://example.com/docs\n\n${container}`;
    const doc = parse(source);
    doc.check();
    assert.equal(doc.child(0).type.name, 'lekhAlert');
    assert.equal(doc.child(1).type.name, 'lekhPublishing');
    assert.deepEqual(destinations(doc.toJSON()), [], 'the opaque reference is not represented by a PM link mark');
    const definitions = doc.firstChild!.attrs.sourceDefinitions as string[];
    assert.equal(definitions.length, 1);
    assert.match(definitions[0], /^\[ref\]: https:\/\/example.com\/docs/);
    const edited = EditorState.create({ schema, doc }).tr.insertText('Edited ', 2).doc;
    const markdown = manager.serialize(edited.toJSON());
    assert.match(markdown, /> \[ref\]: https:\/\/example.com\/docs/);
    assert.ok(markdown.includes(container));
    const reparsed = parse(markdown);
    reparsed.check();
    assert.equal(reparsed.child(1).attrs.markdown, doc.child(1).attrs.markdown);
    assert.match(await toOfflineHTML(markdown, null), /href="https:\/\/example.com\/docs"/);
    await assert.rejects(() => toPrintHTML(markdown, null), /Word and PDF export.*HTML/);
    await assert.rejects(() => toDocx(markdown, async () => { throw new Error('No image expected'); }), /Word and PDF export.*HTML/);
  }
});

test('only actual reference definitions survive producer edits, including multiline titles and nested alert ownership', () => {
  const { schema, manager, parse } = fixture();
  const source = '> [!NOTE]\n> Context.\n>\n> [real]: https://example.com/docs\n>   "A multiline\n>   title"\n>\n> ```md\n> [code]: https://code.example/\n> ```\n>\n> <!--\n> [comment]: https://comment.example/\n> -->\n>\n> > [!TIP]\n> > Inner.\n> >\n> > [nested]: https://example.com/nested';
  const doc = parse(source);
  const outer = doc.firstChild!;
  const definitions = outer.attrs.sourceDefinitions as string[];
  assert.equal(definitions.length, 1);
  assert.match(definitions[0], /^\[real\]:/);
  assert.match(definitions[0], /"A multiline\n {2}title"/);
  let innerDefinitions: string[] = [];
  outer.descendants(node => {
    if (node.type.name === 'lekhAlert') innerDefinitions = node.attrs.sourceDefinitions;
  });
  assert.equal(innerDefinitions.length, 1);
  assert.match(innerDefinitions[0], /^\[nested\]:/);
  assert.equal(manager.serialize(doc.toJSON()), source);
  const edited = EditorState.create({ schema, doc }).tr.insertText('Edited ', 2).doc;
  const markdown = manager.serialize(edited.toJSON());
  const links = new Marked().lexer(markdown).links;
  assert.equal(links.real.href, 'https://example.com/docs');
  assert.equal(links.nested.href, 'https://example.com/nested');
  assert.equal(links.code, undefined);
  assert.equal(links.comment, undefined);
  assert.equal((markdown.match(/\[nested\]:/g) ?? []).length, 1);
});

test('preserved definition priority remains first-wins across edited producers and nested alerts', async () => {
  const { schema, manager, parse } = fixture();
  const tabs = '# [One](#tab/one)\n\n[docs][ref]\n\n# [Two](#tab/two)\n\nOther.\n\n---';
  const outer = '> [ref]: https://example.com/outer';
  const inner = '> > [!TIP]\n> > Nested.\n> >\n> > [ref]: https://example.com/inner';
  for (const [parts, winner] of [
    [[outer, inner], 'outer'],
    [[inner, outer], 'inner'],
  ] as const) {
    const source = `> [!NOTE]\n> Context.\n>\n${parts.join('\n>\n')}\n\n${tabs}`;
    const doc = parse(source);
    doc.check();
    const edited = EditorState.create({ schema, doc }).tr.insertText('Edited ', 2).doc;
    const markdown = manager.serialize(edited.toJSON());
    const output = await toOfflineHTML(markdown, null);
    assert.match(output, new RegExp(`href="https://example.com/${winner}"`));
    assert.ok(markdown.includes(`[ref]: https://example.com/${winner}`));
  }
});
