import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentPreviewHTML, headingAnchor, headings, imageDisplayURL, isSafeLink, replaceAllLiteral, wordCount } from '../lib/markdown.js';

test('outline handles ATX and Setext headings and excludes code blocks', () => {
  assert.deepEqual(headings('# Title\n\n```\n# not a heading\n```\n\nSubtitle\n---\n\n### Details'), [
    { level: 1, text: 'Title', displayText: 'Title', line: 0, root: true },
    { level: 2, text: 'Subtitle', displayText: 'Subtitle', line: 6, root: true },
    { level: 3, text: 'Details', displayText: 'Details', line: 9, root: true },
  ]);
});

test('outline labels show link descriptions without URLs or inline formatting syntax', () => {
  const cases = [
    ['Scenario 1: [Deployment **guide**](https://example.com/a_(b) "Guide")', 'Scenario 1: Deployment guide'],
    ['[A *readable* `label`](<https://example.com/a%20b>)', 'A readable label'],
    ['[First](https://example.com/first) and [second](https://example.com/second)', 'First and second'],
    ['[![Build **status**](badge.png)](https://example.com/build)', 'Build status'],
    ['Literal \\[brackets\\], \\*stars\\* &amp; `[code](not-a-link)`', 'Literal [brackets], *stars* & [code](not-a-link)'],
    ['<https://example.com/visible>', 'https://example.com/visible'],
    ['\u4f60\u597d [\u4e16\u754c](https://example.com)', '\u4f60\u597d \u4e16\u754c'],
    ['', ''],
  ];
  for (const [source, displayText] of cases) {
    assert.deepEqual(headings(`## ${source}`), [{ level: 2, text: source, displayText, line: 0, root: true }]);
  }
});

test('outline labels resolve reference links and preserve Setext heading locations', () => {
  assert.deepEqual(headings('## [**Full** reference][guide]\n\n[guide]: https://example.com/guide\n\nSetext [guide][]\n---\n\n[guide]\n===\n'), [
    { level: 2, text: '[**Full** reference][guide]', displayText: 'Full reference', line: 0, root: true },
    { level: 2, text: 'Setext [guide][]', displayText: 'Setext guide', line: 4, root: true },
    { level: 1, text: '[guide]', displayText: 'guide', line: 7, root: true },
  ]);
});

test('readable outline labels retain original heading markup for existing anchors', () => {
  const [heading] = headings('# Literal \\*stars\\* and [**Guide**](https://example.com)');
  assert.equal(heading.displayText, 'Literal *stars* and Guide');
  assert.equal(heading.text, 'Literal \\*stars\\* and [**Guide**](https://example.com)');
  assert.equal(headingAnchor(heading.text, new Map()), 'literal-stars-and-guide');
});

test('word count handles punctuation, empty text, and non-Latin words', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount("Hello, world! Don't stop. caf\u00e9 \u4f60\u597d"), 6);
});

test('replace treats both find and replacement as literals', () => {
  assert.deepEqual(replaceAllLiteral('a.* a.*', 'a.*', '$&'), { text: '$& $&', count: 2 });
  assert.deepEqual(replaceAllLiteral('aaa', 'a', ''), { text: '', count: 3 });
  assert.deepEqual(replaceAllLiteral('Hello', 'hello', 'x'), { text: 'Hello', count: 0 });
  assert.throws(() => replaceAllLiteral('text', '', 'x'), /Enter some text/);
});

test('only web and email links may open external applications', () => {
  for (const link of ['https://example.com', 'http://example.com', 'mailto:writer@example.com']) assert.equal(isSafeLink(link), true);
  for (const link of ['javascript:alert(1)', 'file:///C:/Windows', 'shell:AppsFolder', 'relative.md', 'data:text/html,test']) assert.equal(isSafeLink(link), false);
});

test('local image URLs encode reserved characters without changing Markdown source', () => {
  const url = new URL(imageDisplayURL('assets/my photo#1.png'));
  assert.equal(url.protocol, 'lekh-image:');
  assert.equal(url.searchParams.get('source'), 'assets/my photo#1.png');
  assert.equal(imageDisplayURL('data:image/png;base64,abc='), 'data:image/png;base64,abc=');
});

test('relative image URLs are scoped to a tab even when filenames are identical', () => {
  const first = new URL(imageDisplayURL('photo.png', 'first-tab'));
  const second = new URL(imageDisplayURL('photo.png', 'second-tab'));
  assert.notEqual(first.href, second.href);
  assert.equal(first.searchParams.get('document'), 'first-tab');
  assert.equal(second.searchParams.get('document'), 'second-tab');
  assert.equal(first.searchParams.get('source'), second.searchParams.get('source'));
});

test('heading anchors handle inline formatting, links, Unicode, and duplicates', () => {
  const used = new Map<string, number>();
  assert.equal(headingAnchor('**Hello** [world](https://example.com)!', used), 'hello-world');
  assert.equal(headingAnchor('Hello world', used), 'hello-world-1');
  assert.equal(headingAnchor('Hello world', used), 'hello-world-2');
  assert.equal(headingAnchor('\u4f60\u597d \u4e16\u754c', used), '\u4f60\u597d-\u4e16\u754c');
});

test('document previews render Markdown without allowing raw HTML or script links', () => {
  const preview = documentPreviewHTML('# Current edits\n\n**Bold**\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))', 'tab');
  assert.match(preview, /<h1>Current edits<\/h1>/);
  assert.match(preview, /<strong>Bold<\/strong>/);
  assert.match(preview, /&lt;script&gt;/);
  assert.doesNotMatch(preview, /<script|href="javascript:/);
  assert.equal(documentPreviewHTML('', 'tab'), '');
});

test('preview images use document-scoped local URLs, including nested and remote images', () => {
  const markdown = '> ![Local](asset.png)\n\n[![Nested](assets/photo.png)](https://example.com)\n\n![Remote](https://example.com/photo.png)';
  const first = documentPreviewHTML(markdown, 'first');
  const second = documentPreviewHTML(markdown, 'second');
  assert.notEqual(first, second);
  assert.equal((first.match(/src="lekh-image:\/\/local\/image\?/g) ?? []).length, 3);
  assert.equal((first.match(/document=first/g) ?? []).length, 3);
  assert.match(first, /source=https%3A%2F%2Fexample.com%2Fphoto.png/);
  assert.doesNotMatch(first, /src="https:/);
  assert.equal(documentPreviewHTML(markdown, 'first'), first, 'Preview rendering never mutates the shared parser');
});

test('preview rendering preserves embedded images even when their data exceeds a thumbnail text budget', () => {
  const image = `data:image/png;base64,${'a'.repeat(16000)}`;
  assert.ok(documentPreviewHTML(`![Embedded](${image})`, 'tab').includes(`src="${image}"`));
});
