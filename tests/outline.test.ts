import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headings, parser, topLevelBlocks } from '../lib/markdown.js';
import { canMoveSection, moveSection, moveSectionTo, relocateSection, sectionEndIndex, sectionRange, siblingSection } from '../lib/outline.js';

const doc = '# A\n\nAlpha.\n\n## A1\n\nOne.\n\n## A2\n\nTwo.\n\n# B\n\nBeta.\n';
const list = headings(doc);

test('section ranges include subsections and stop at the next equal or higher heading', () => {
  assert.deepEqual(sectionRange(list, 0, doc.split('\n').length), [0, 12]);
  assert.deepEqual(sectionRange(list, 1, doc.split('\n').length), [4, 8]);
  assert.equal(sectionEndIndex(list, 0), 3);
  assert.equal(sectionEndIndex(list, 3), 4);
  assert.equal(siblingSection(list, 1, 1), 2);
  assert.equal(siblingSection(list, 1, -1), undefined, 'a parent heading bounds sibling search');
  assert.equal(siblingSection(list, 3, -1), 0);
});

test('moving a top-level section carries its subsections and keeps a trailing newline', () => {
  assert.equal(moveSection(doc, list, 3, -1), '# B\n\nBeta.\n\n# A\n\nAlpha.\n\n## A1\n\nOne.\n\n## A2\n\nTwo.\n');
  assert.equal(moveSection(doc, list, 0, 1), '# B\n\nBeta.\n\n# A\n\nAlpha.\n\n## A1\n\nOne.\n\n## A2\n\nTwo.\n');
});

test('subsections swap only within their parent', () => {
  assert.equal(moveSection(doc, list, 2, -1), '# A\n\nAlpha.\n\n## A2\n\nTwo.\n\n## A1\n\nOne.\n\n# B\n\nBeta.\n');
  assert.equal(moveSection(doc, list, 1, 1), '# A\n\nAlpha.\n\n## A2\n\nTwo.\n\n## A1\n\nOne.\n\n# B\n\nBeta.\n');
  assert.equal(moveSection(doc, list, 2, 1), undefined, 'the last child cannot leave its parent with Alt+Down');
  assert.equal(moveSection(doc, list, 1, -1), undefined);
});

test('drag moves place sections before a target or at the end and reject moves into themselves', () => {
  assert.equal(moveSectionTo(doc, list, 1, 4), '# A\n\nAlpha.\n\n## A2\n\nTwo.\n\n# B\n\nBeta.\n\n## A1\n\nOne.\n');
  assert.equal(moveSectionTo(doc, list, 0, 2), undefined);
  assert.equal(moveSectionTo(doc, list, 0, 0), undefined);
});

test('documents without a trailing newline and with preamble text stay well formed', () => {
  const text = 'Intro.\n\n# One\nFirst.\n# Two\nSecond.';
  assert.equal(moveSection(text, headings(text), 1, -1), 'Intro.\n\n# Two\nSecond.\n\n# One\nFirst.');
});

test('headings inside quotes are never moved', () => {
  const text = '# One\n\n> # Quoted\n\n# Two\n';
  const quoted = headings(text);
  assert.equal(moveSectionTo(text, quoted, 1, 0), undefined);
  assert.equal(moveSectionTo(text, quoted, 2, 1), undefined, 'a section cannot be dropped into a quote');
});

test('headings inside zones, tabbed examples and lists are not movable and containers are never split', () => {
  const zone = '# A\n:::zone pivot="x"\n## B\nb\n:::zone-end\n## C\nc\n';
  const zoneTokens = parser.parse(zone, {});
  const zoneList = headings(zone, zoneTokens);
  assert.deepEqual(zoneList.map(item => item.root), [true, false, true]);
  assert.equal(canMoveSection(zoneList, 1), false);
  assert.equal(moveSection(zone, zoneList, 1, 1, topLevelBlocks(zoneTokens)), undefined);
  assert.equal(moveSectionTo(zone, zoneList, 2, 1, topLevelBlocks(zoneTokens)), undefined, 'a section cannot be dropped inside a zone');

  const tabs = '# [Linux](#tab/linux)\n## L\n# [Win](#tab/win)\n## W\n---\n## D\nd\n## E\ne\n';
  const tabTokens = parser.parse(tabs, {});
  const tabList = headings(tabs, tabTokens);
  assert.ok(tabList.filter(item => !item.root).every(item => !canMoveSection(tabList, tabList.indexOf(item))));
  const rootD = tabList.findIndex(item => item.root && item.line === 5);
  assert.equal(moveSection(tabs, tabList, rootD, -1, topLevelBlocks(tabTokens)), undefined, 'moving up must not enter the tab group');
  assert.equal(moveSection(tabs, tabList, rootD, 1, topLevelBlocks(tabTokens)), '# [Linux](#tab/linux)\n## L\n# [Win](#tab/win)\n## W\n---\n## E\ne\n\n## D\nd\n');

  const list = '# A\n- item\n- # B\n  more\n- tail\n# C\n';
  const listTokens = parser.parse(list, {});
  const listHeadings = headings(list, listTokens);
  assert.equal(canMoveSection(listHeadings, 1), false);
  assert.equal(moveSection(list, listHeadings, 1, 1, topLevelBlocks(listTokens)), undefined);
});

test('a root section that contains a whole zone moves with it', () => {
  const text = '## A\n:::zone pivot="x"\n## Inner\n:::zone-end\n## B\nb\n';
  const tokens = parser.parse(text, {});
  const list = headings(text, tokens);
  const result = relocateSection(text, list, 0, 3, topLevelBlocks(tokens));
  assert.equal(result?.markdown, '## B\nb\n\n## A\n:::zone pivot="x"\n## Inner\n:::zone-end\n');
  assert.equal(result?.line, 3);
});
