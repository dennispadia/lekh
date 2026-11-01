import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { imageDimensions, toDocx, toOfflineHTML, toPrintHTML } from '../lib/export.js';
import { requiresInteractiveExport } from '../lib/markdown.js';
import { unzipEntries } from './zip.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = `data:image/png;base64,${png.toString('base64')}`;
const tabs = ':::tabs\n:::tab First\nFirst body.\n:::tab-end\n:::tab Second\nSecond body.\n:::tab-end\n:::tabs-end\n';
const jpeg = Buffer.from((JSON.parse(await readFile(new URL('./fixtures/jpeg-2x3.json', import.meta.url), 'utf8')) as string[]).join(''), 'base64');

test('HTML is self-contained, keeps Markdown inert and authorizes only its fixed interaction script', async () => {
  const markdown = `# Offline article\n\n<script>globalThis.compromised = true</script>\n\n![Pixel](${image})\n\n[External link](https://example.com)\n\n${tabs}`;
  const html = await toOfflineHTML(markdown, null);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  const hash = createHash('sha256').update(script).digest('base64');
  assert.ok(html.includes(`script-src 'sha256-${hash}'`));
  assert.match(html, /default-src 'none';/);
  assert.match(html, /img-src data:/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /&lt;script&gt;globalThis\.compromised/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link\b|<img[^>]+src="https?:/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.match(html, /<noscript>.*all tabbed examples and variant content are shown/s);
  assert.doesNotMatch(script, /compromised|Offline article/);
});

test('HTML embeds and validates images once, rejects missing, remote and malformed assets', async () => {
  const seen: string[] = [];
  const html = await toOfflineHTML(`![First](${image})\n\n![Second](${image})`, null, undefined, null, async (data, mime) => {
    assert.deepEqual(data, png);
    seen.push(mime);
  });
  assert.deepEqual(seen, ['image/png']);
  assert.equal((html.match(/<img[^>]+src="data:image\/png;base64,/g) ?? []).length, 2);
  await assert.rejects(() => toOfflineHTML('![Remote](https://example.com/private.png)', null), /Only embedded/);
  await assert.rejects(() => toOfflineHTML('![Missing](missing.png)', null), /Save the Markdown file/);
  await assert.rejects(() => toOfflineHTML('![Invalid](data:image/png;base64,dGVzdA==)', null), /does not match/);
  await assert.rejects(() => toOfflineHTML(`![Pixel](${image})`, null, undefined, null, async () => {
    throw new Error('Image decoder failed');
  }), /Image decoder failed/);
});

test('JPEG marker fill bytes remain valid for offline HTML and Word exports', async () => {
  const padded = Buffer.concat([jpeg.subarray(0, 3), Buffer.from([255, 255]), jpeg.subarray(3)]);
  assert.deepEqual(imageDimensions(jpeg, 'jpg'), { width: 2, height: 3 });
  assert.deepEqual(imageDimensions(padded, 'jpg'), { width: 2, height: 3 });
  const withStandaloneMarker = Buffer.concat([padded.subarray(0, 2), Buffer.from([255, 1]), padded.subarray(2)]);
  assert.deepEqual(imageDimensions(withStandaloneMarker, 'jpg'), { width: 2, height: 3 });
  const source = `data:image/jpeg;base64,${padded.toString('base64')}`;
  let validated = false;
  const html = await toOfflineHTML(`![Photo](${source})`, null, undefined, null, async (data, mime) => {
    assert.deepEqual(data, padded);
    assert.equal(mime, 'image/jpeg');
    validated = true;
  });
  assert.ok(validated);
  assert.ok(html.includes(source));
  const word = unzipEntries(await toDocx('![Photo](photo.jpg)', async () => ({ data: padded, mime: 'image/jpeg' })));
  assert.ok([...word.entries()].some(([name, data]) => name.startsWith('word/media/') && data.equals(padded)));
  for (const invalid of ['ffd8ffff', 'ffd8ffffd9', 'ffd8ffffe00001', 'ffd8ffffe00006aabb', 'ffd8ffffc0000808000100']) {
    assert.throws(() => imageDimensions(Buffer.from(invalid, 'hex'), 'jpg'), /invalid|dimensions/i, invalid);
  }
});

test('HTML embeds a locally rendered Mermaid image and propagates renderer failures', async () => {
  const source = 'flowchart TD\n  A[Start] --> B[Finish]\n';
  const markdown = `\`\`\`mermaid\n${source}\`\`\`\n`;
  let seen = '';
  const html = await toOfflineHTML(markdown, null, async value => {
    seen = value;
    return { data: png, mime: 'image/png' };
  });
  assert.equal(seen, source);
  assert.match(html, /alt="Mermaid diagram" src="data:image\/png;base64,/);
  await assert.rejects(() => toOfflineHTML(markdown, null), /rendered diagram image/);
  await assert.rejects(() => toOfflineHTML(markdown, null, async () => { throw new Error('Diagram failed'); }), /Diagram failed/);
});

test('tab IDs cannot collide with document heading anchors or another tab group', async () => {
  const html = await toOfflineHTML(`# Lekh export tabs 0 tab 0\n\n${tabs}\n${tabs}`, null);
  const body = html.split('<body>')[1].split('<script>')[0];
  const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('lekh-export-tabs-0-tab-0'));
  for (const [, target] of body.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(ids.includes(target), target);
});

test('metadata alone remains exportable to every format and is excluded from article content', async () => {
  const markdown = '---\ntitle: Private metadata\n---\n\n# Public article\n\nBody.\n';
  assert.equal(requiresInteractiveExport(markdown), false);
  const html = await toOfflineHTML(markdown, null);
  const print = await toPrintHTML(markdown, null);
  const word = unzipEntries(await toDocx(markdown, async () => { throw new Error('No image expected'); }));
  assert.doesNotMatch(html.split('<body>')[1], /Private metadata/);
  assert.doesNotMatch(print.split('<body>')[1], /Private metadata/);
  assert.doesNotMatch(word.get('word/document.xml')!.toString(), /Private metadata/);
  assert.match(word.get('word/document.xml')!.toString(), /Public article/);
});

test('local include directives stay inert and never affect export restrictions', async () => {
  const source = '# Article\n\n[!INCLUDE [Shared](shared.md)]\n';
  assert.equal(requiresInteractiveExport(source), false);
  const html = await toOfflineHTML(source, null);
  assert.match(html, /\[!INCLUDE/);
  assert.doesNotMatch(html, /Second body|Included variant/);
  await assert.doesNotReject(() => toPrintHTML(source, null));
  await assert.doesNotReject(() => toDocx(source, async () => { throw new Error('No image expected'); }));
});
