import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Node } from '@tiptap/pm/model';
import { EditablePublishing } from '../src/editable-publishing.js';
import { emptyEditorHints } from '../src/editor-hints.js';

const schema = getSchema([StarterKit, EditablePublishing]);
const paragraph = (text?: string) => schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined);
const doc = (...nodes: Node[]) => schema.nodes.doc.create(null, nodes);

test('a blank document hints at slash commands without adding document content', () => {
  const blank = doc(paragraph());
  const hints = emptyEditorHints(blank).find();
  assert.equal(hints.length, 1);
  assert.match(hints[0].spec.placeholder, /press \/ for commands/);
  assert.equal(blank.textContent, '');
  assert.equal(hints[0].from, 0);
  assert.equal(hints[0].to, 2);
});

test('hints disappear for text, whitespace and documents containing other blocks', () => {
  for (const content of [doc(paragraph('Hello')), doc(paragraph(' ')), doc(paragraph(), paragraph()),
    doc(schema.nodes.horizontalRule.create(), paragraph())]) {
    assert.equal(emptyEditorHints(content).find().length, 0);
  }
});

test('empty example and variant bodies have context-specific hints, not slash commands', () => {
  const content = doc(
    schema.nodes.lekhTabs.create(null, schema.nodes.lekhTab.create(null, paragraph())),
    schema.nodes.lekhZone.create(null, paragraph()),
  );
  const hints = emptyEditorHints(content).find();
  assert.equal(hints.length, 2);
  assert.match(hints[0].spec.placeholder, /example/);
  assert.match(hints[1].spec.placeholder, /selected options/);
  assert.equal(content.textContent, '');
});

test('focus hides only the active empty hint without changing content; blur restores it', () => {
  const blank = doc(paragraph());
  assert.equal(emptyEditorHints(blank, 1).find().length, 0);
  assert.equal(emptyEditorHints(blank).find().length, 1);
  const content = doc(
    schema.nodes.lekhTabs.create(null, schema.nodes.lekhTab.create(null, paragraph())),
    schema.nodes.lekhZone.create(null, paragraph()),
  );
  const hints = emptyEditorHints(content).find();
  for (const active of hints) {
    const remaining = emptyEditorHints(content, active.from + 1).find();
    assert.equal(remaining.length, 1);
    assert.notEqual(remaining[0].from, active.from);
    assert.equal(content.textContent, '');
  }
  assert.equal(emptyEditorHints(content).find().length, 2);
});
