import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { learnChecks, learnPathIssues, MAX_LEARN_PATHS } from '../lib/learn-checks.js';
import { learnPathStatuses } from '../lib/learn-paths.js';

test('Learn checks report missing alt text for Markdown images and image directives', () => {
  const { issues, references } = learnChecks([
    '---', 'title: T', 'description: D', '---', '',
    '![](media/a.png)',
    '![Diagram](media/b.png "Title")',
    ':::image type="content" source="media/c.png" alt-text="":::',
    ':::image type="icon" source="media/d.svg" alt-text="":::',
    'Inline `![](media/e.png)` is code.',
  ].join('\n'));
  assert.deepEqual(issues.map(issue => [issue.line, issue.rule]), [[6, 'alt-text'], [8, 'alt-text']]);
  assert.deepEqual(references.map(reference => [reference.kind, reference.path, reference.line]), [
    ['image', 'media/a.png', 6], ['image', 'media/b.png', 7], ['image', 'media/c.png', 8], ['image', 'media/d.svg', 9],
  ]);
});

test('Learn checks collect includes and ignore fenced code, URLs, and anchors', () => {
  const { issues, references } = learnChecks([
    '---', 'title: T', 'description: D', '---',
    '[!INCLUDE [shared](../includes/shared.md)]',
    '```markdown', '![](media/in-code.png)', '[!INCLUDE [x](x.md)]', '```',
    '![Logo](https://example.com/logo.png)',
    '![Inline](data:image/png;base64,AAAA)',
    '![Anchor](#top)',
    '> [!NOTE]', '> [!INCLUDE [quoted](includes/quoted.md)]',
  ].join('\n'));
  assert.deepEqual(issues, []);
  assert.deepEqual(references.map(reference => [reference.kind, reference.path, reference.line]), [
    ['include', '../includes/shared.md', 5], ['include', 'includes/quoted.md', 14],
  ]);
});

test('Learn checks report missing metadata fields', () => {
  assert.deepEqual(learnChecks('---\ntitle: "Only title"\n---\n\nBody').issues.map(issue => issue.message),
    ['Metadata is missing a description. Learn articles require description.']);
  assert.deepEqual(learnChecks('No metadata here.').issues, []);
});

test('Learn checks ignore comments and indented code, not nearby article content', () => {
  const source = '---\ntitle: T\ndescription: D\n---\n![](real.png)\n\n<!--\n![](comment.png)\n:::future\n-->\n\n    ![](code.png)\n\nText <!-- ![](inline.png) -->\n';
  const result = learnChecks(source);
  assert.deepEqual(result.references.map(reference => reference.path), ['real.png']);
  assert.deepEqual(result.issues.map(issue => [issue.line, issue.rule]), [[5, 'alt-text']]);
});

test('Learn checks find nested image directives in list items', () => {
  const { issues, references } = learnChecks([
    '1. Step one', '', '   :::image type="content" source="media/step.png" alt-text="":::', '',
    '1. Step two',
  ].join('\n'));
  assert.deepEqual(issues.map(issue => [issue.line, issue.rule]), [[3, 'alt-text']]);
  assert.deepEqual(references.map(reference => reference.path), ['media/step.png']);
});

test('Learn checks explain unsupported publishing blocks', () => {
  const { issues } = learnChecks(':::image type="complex" source="media/x.png" alt-text="X":::\nLong description without an end marker.');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].rule, 'publishing-block');
  assert.equal(issues[0].severity, 'error');
  assert.ok(issues[0].message.length > 0);
});

test('Learn path issues map statuses to suggestions and aggregate unsaved paths', () => {
  const references = [
    { kind: 'image' as const, path: 'a.png', line: 1 },
    { kind: 'include' as const, path: 'b.md', line: 2 },
    { kind: 'image' as const, path: 'c.png', line: 3 },
    { kind: 'image' as const, path: 'd.png', line: 4 },
    { kind: 'image' as const, path: 'e.png', line: 5 },
    { kind: 'image' as const, path: 'f.png', line: 6 },
  ];
  const issues = learnPathIssues(references, ['found', 'missing', 'needs-access', 'invalid', 'unsaved', 'unsaved']);
  assert.deepEqual(issues.map(issue => [issue.line, issue.severity, issue.rule]), [
    [2, 'error', 'include-path'], [3, 'info', 'image-path'], [4, 'error', 'image-path'], [5, 'info', 'image-path'],
  ]);
  assert.match(issues[1].message, /outside the allowed folders/);
  assert.match(issues[3].message, /2 relative paths/);
});

test('Learn path statuses stay within the document folder and allowed roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'lekh-learn-'));
  try {
    const article = path.join(root, 'articles', 'topic');
    const shared = path.join(root, 'includes');
    await mkdir(path.join(article, 'media'), { recursive: true });
    await mkdir(shared, { recursive: true });
    await writeFile(path.join(article, 'media', 'found.png'), '');
    await writeFile(path.join(shared, 'shared.md'), '');
    const documentPath = path.join(article, 'doc.md');
    const sources = ['media/found.png', 'media/missing.png', 'media', '../../includes/shared.md', 'https://example.com/x.png', '/azure/x.png', '%E0%A4%A', 'media/found.png?raw=1#x'];
    assert.deepEqual(await learnPathStatuses(sources, documentPath, []),
      ['found', 'missing', 'missing', 'needs-access', 'external', 'external', 'invalid', 'found']);
    assert.deepEqual(await learnPathStatuses(['../../includes/shared.md'], documentPath, [root]), ['found']);
    assert.deepEqual(await learnPathStatuses(['media/found.png', 'https://x'], null, []), ['unsaved', 'external']);
    await assert.rejects(learnPathStatuses(Array(MAX_LEARN_PATHS + 1).fill('a'), documentPath, []));
    await assert.rejects(learnPathStatuses([42], documentPath, []));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
