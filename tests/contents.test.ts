import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMarkedTableOfContents, tableOfContents, TOC_END, TOC_START, updateTableOfContents } from '../lib/contents.js';
import { parser } from '../lib/markdown.js';

test('marked contents use stable duplicate heading anchors and ignore fenced headings', () => {
  const toc = tableOfContents('# Same\n## Same\n```md\n# Hidden\n```\n# 你好');
  assert.match(toc, /#same\)/);
  assert.match(toc, /#same-1\)/);
  assert.match(toc, /#你好\)/);
  assert.doesNotMatch(toc, /Hidden/);
});
test('contents show linked heading descriptions without their destinations', () => {
  const toc = tableOfContents('# [Scenario 1: Availability sets](https://example.com/one)\n\n## Scenario 2: [Zones](https://example.com/two)');
  assert.match(toc, /\[Scenario 1: Availability sets\]\(#scenario-1-availability-sets\)/);
  assert.match(toc, /\[Scenario 2: Zones\]\(#scenario-2-zones\)/);
  assert.doesNotMatch(toc, /https:\/\/example\.com/);
});
test('updating contents preserves surrounding bytes, newline style and heading changes', () => {
  const before = '# Title\r\n\r\nKeep   spaces\r\n';
  const after = '\r\n\r\n## New section\r\n';
  const text = before + `${TOC_START}\r\nold\r\n${TOC_END}` + after;
  const result = updateTableOfContents(text);
  assert.ok(result.startsWith(before));
  assert.ok(result.endsWith(after));
  assert.match(result, /New section/);
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(updateTableOfContents(result), result);
  assert.doesNotMatch(parser.render(result), /lekh:toc/);
  assert.match(parser.render('```html\n' + TOC_START + '\n```'), /lekh:toc/);
  assert.throws(() => updateTableOfContents('# No marked TOC'), /exactly one/);
  assert.throws(() => updateTableOfContents(`${text}\n${text}`), /exactly one/);
  const sample = '```html\n' + TOC_START + '\nexample\n' + TOC_END + '\n```\n';
  assert.ok(updateTableOfContents(sample + text).startsWith(sample));
});
test('contents detection ignores markers inside code and distinguishes absent from malformed blocks', () => {
  assert.equal(hasMarkedTableOfContents('# No contents'), false);
  assert.equal(hasMarkedTableOfContents(`\`\`\`html\n${TOC_START}\n${TOC_END}\n\`\`\``), false);
  assert.equal(hasMarkedTableOfContents(`${TOC_START}\nlist\n${TOC_END}`), true);
  assert.equal(hasMarkedTableOfContents(TOC_START), true);
});
