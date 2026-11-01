import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { blockCommands, commandEntries, filterCommands, slashEntries } from '../lib/commands.js';

test('command palette entries are unique and every one routes to the renderer dispatcher', async () => {
  const renderer = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
  const entries = commandEntries();
  assert.equal(new Set(entries.map(entry => entry.id)).size, entries.length);
  for (const entry of entries) {
    assert.ok(entry.label.trim() && entry.group.trim(), entry.id);
    const prefix = entry.id.includes(':') ? entry.id.slice(0, entry.id.indexOf(':') + 1) : undefined;
    const routed = prefix ? renderer.includes(`startsWith('${prefix}')`) : renderer.includes(`case '${entry.id}'`);
    assert.ok(routed, `Unrouted command: ${entry.id}`);
  }
});

test('the palette excludes removed features and offers variant content only after a selector exists', () => {
  const ids = commandEntries().map(entry => entry.id);
  assert.ok(!ids.some(id => /include|steps/.test(id)));
  assert.equal(commandEntries(false).find(entry => entry.id === 'insert:publishing-selector')!.label, 'Variant selector');
  assert.match(commandEntries(true).find(entry => entry.id === 'insert:publishing-selector')!.label, /variant content/i);
  assert.ok(!ids.includes('insert:publishing-zone'));
});

test('block commands are present in the palette with their shortcuts', () => {
  const ids = commandEntries().map(entry => entry.id);
  for (const command of blockCommands) assert.ok(ids.includes(command.id));
  assert.equal(blockCommands.find(entry => entry.id === 'block:up')!.shortcut, 'Alt+Shift+Up');
});

test('filtering matches every term and ranks label prefixes first', () => {
  const entries = commandEntries();
  assert.equal(filterCommands(entries, '').length, entries.length);
  assert.equal(filterCommands(entries, 'bold')[0].id, 'format:bold');
  assert.equal(filterCommands(entries, 'export html')[0].id, 'export-html');
  assert.equal(filterCommands(entries, 'TOC')[0].id, 'insert:toc');
  assert.ok(filterCommands(entries, 'grammar').some(entry => entry.id === 'writing-assistance'));
  assert.deepEqual(filterCommands(entries, 'zzzz nothing'), []);
});

test('slash entries contain only insertable blocks', () => {
  const ids = slashEntries().map(entry => entry.id);
  for (const id of ['heading:1', 'table', 'image', 'insert:toc', 'insert:callout-note', 'insert:publishing-tabs', 'insert:publishing-selector', 'insert:publishing-metadata'])
    assert.ok(ids.includes(id), id);
  for (const id of ['save', 'export-pdf', 'block:up', 'theme:dark', 'undo']) assert.ok(!ids.includes(id), id);
  assert.equal(filterCommands(slashEntries(), 'tabbed')[0].id, 'insert:publishing-tabs');
  assert.deepEqual(filterCommands(slashEntries(), 'tab').slice(0, 2).map(entry => entry.id).sort(), ['insert:publishing-tabs', 'table']);
});

test('slash entries have descriptions and labels without trailing ellipses', () => {
  for (const entry of slashEntries(true)) {
    assert.ok(entry.description?.trim(), `Missing description: ${entry.id}`);
    assert.doesNotMatch(entry.label, /(\.\.\.|\u2026)$/, entry.id);
  }
});
