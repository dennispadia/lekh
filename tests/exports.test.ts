import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDocx, toPrintHTML, imageDimensions } from '../lib/export.js';
import { unzipEntries } from './zip.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('DOCX contains headings, formatting, tables, links, lists, quotes, code, and images', async () => {
  const markdown = `# Export test

**Bold** and *italic* with ~~strike~~ and \`inline code\`.

[Example](https://example.com)

- First
  - Nested

3. Ordered
4. Next

> Quoted words

| Name | Value |
| --- | --- |
| A | B |

\`\`\`js
const answer = 42;
\`\`\`

![Pixel](pixel.png)
`;
  const zip = unzipEntries(await toDocx(markdown, async () => ({ data: png, mime: 'image/png' })));
  const xml = zip.get('word/document.xml')!.toString();
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /<w:i\/>/);
  assert.match(xml, /<w:strike\/>/);
  assert.match(xml, /<w:tbl>/);
  assert.match(xml, /<w:hyperlink/);
  assert.match(xml, /Quoted words/);
  assert.match(xml.replace(/<[^>]+>/g, ''), /const answer = 42;/);
  assert.match(xml, /<w:numPr>/);
  assert.match(xml, /w:ilvl w:val="1"/);
  assert.match(zip.get('word/numbering.xml')!.toString(), /w:start w:val="3"/);
  assert.match(zip.get('word/_rels/document.xml.rels')!.toString(), /https:\/\/example.com/);
  assert.ok([...zip.keys()].some(name => name.startsWith('word/media/') && name.endsWith('.png')));
  assert.match(xml, /cx="9525" cy="9525"/, 'Image aspect ratio and original dimensions preserved');
});

test('DOCX rejects missing or unsupported images rather than silently dropping them', async () => {
  await assert.rejects(() => toDocx('![Missing](missing.png)', async () => { throw new Error('Image not found'); }), /Image not found/);
  await assert.rejects(() => toDocx('![WebP](photo.webp)', async () => ({ data: png, mime: 'image/webp' })), /Word export supports/);
});

test('image size detection validates PNG and rejects malformed images', () => {
  assert.deepEqual(imageDimensions(png, 'png'), { width: 1, height: 1 });
  assert.throws(() => imageDimensions(Buffer.from('not an image'), 'png'), /invalid/);
});

test('PDF HTML preserves formatting and embeds images without executable HTML', async () => {
  const html = await toPrintHTML(`# PDF title\n\n**Bold**\n\n<script>alert(1)</script>\n\n![Pixel](data:image/png;base64,${png.toString('base64')})`, null);
  assert.match(html, /<h1 id="pdf-title">PDF title<\/h1>/);
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /@page/);
});

test('PDF export refuses remote images instead of fetching them', async () => {
  await assert.rejects(() => toPrintHTML('![Remote](https://example.com/private.png)', null), /Only embedded/);
});

test('empty Markdown still creates a valid Word document', async () => {
  assert.ok(unzipEntries(await toDocx('', async () => { throw new Error('Unexpected image'); })).has('word/document.xml'));
});

test('PDF and Word export syntax colors without editor controls or altered code', async () => {
  const code = 'const answer = 42;\n\n  console.log("Hello & <world>");';
  const markdown = `\`\`\`javascript\n${code}\n\`\`\`\n`;
  const html = await toPrintHTML(markdown, null);
  assert.match(html, /class="hljs-keyword">const<\/span>/);
  assert.match(html, /#CF222E/);
  assert.match(html, /&amp;/);
  assert.doesNotMatch(html, /code-language|copy-code|Search languages/);
  const zip = unzipEntries(await toDocx(markdown, async () => { throw new Error('Unexpected image'); }));
  const xml = zip.get('word/document.xml')!.toString();
  assert.match(xml, /<w:color w:val="CF222E"/);
  assert.match(xml, /<w:color w:val="0550AE"/);
  const lines = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map(([paragraph]) =>
    [...paragraph.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(([, text]) =>
      text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join(''));
  assert.deepEqual(lines, ['const answer = 42;', ' ', '  console.log("Hello & <world>");']);
});

test('Word defines rich typography instead of relying on the consumer default heading styles', async () => {
  const zip = unzipEntries(await toDocx('# Title\n\n## Section\n\n### Detail\n\n#### Four\n\n##### Five\n\n###### Six\n\nBody text.', async () => { throw new Error('Unexpected image'); }));
  const styles = zip.get('word/styles.xml')!.toString();
  const defaults = styles.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/)?.[0];
  assert.ok(defaults);
  assert.match(defaults, /w:ascii="Segoe UI"/);
  assert.match(defaults, /w:sz w:val="24"/);
  const paragraphSpacing = defaults.match(/<w:spacing\b[^>]*>/)?.[0];
  assert.ok(paragraphSpacing);
  assert.match(paragraphSpacing, /w:after="160"/);
  assert.match(paragraphSpacing, /w:line="420"/);
  assert.doesNotMatch(paragraphSpacing, /w:before="(?:[1-9]\d*)"/);
  for (const [index, size] of [51, 32, 26, 23, 22, 20].entries()) {
    const heading = styles.match(new RegExp(`<w:style[^>]*w:styleId="Heading${index + 1}"[\\s\\S]*?</w:style>`))?.[0];
    assert.ok(heading, `Heading ${index + 1} has an explicit style`);
    assert.match(heading, new RegExp(`<w:sz w:val="${size}"`));
    assert.match(heading, /<w:b\/>/);
    assert.match(heading, /<w:keepNext\/>/);
    assert.match(heading, /w:color w:val="263238"/);
  }
  const xml = zip.get('word/document.xml')!.toString();
  assert.doesNotMatch(xml, /<w:b w:val="false"/, 'Plain heading runs must not override their bold style');
  assert.match(xml, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(xml, /w:pgMar[^>]*w:top="1134"[^>]*w:right="1134"[^>]*w:bottom="1134"[^>]*w:left="1134"/);
  assert.match(xml, /<w:widowControl\/>/);
});

test('Word tables retain alignment, page-bounded grids, header shading and repeating unsplit rows', async () => {
  const markdown = '| Item | Centre | Amount |\n| :--- | :---: | ---: |\n| **A** | *B* | 12.50 |\n';
  const zip = unzipEntries(await toDocx(markdown, async () => { throw new Error('Unexpected image'); }));
  const xml = zip.get('word/document.xml')!.toString();
  assert.match(xml, /<w:tblLayout w:type="fixed"/);
  assert.match(xml, /<w:tblW w:type="dxa" w:w="9638"/);
  const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"/g)].map(match => Number(match[1]));
  assert.equal(widths.length, 3);
  assert.ok(widths.every(width => width > 3000 && width < 3300));
  assert.ok(Math.abs(widths.reduce((sum, width) => sum + width, 0) - 9638) < 3);
  assert.match(xml, /<w:tblHeader\/>/);
  assert.equal((xml.match(/<w:cantSplit\/>/g) ?? []).length, 2);
  assert.match(xml, /w:fill="F1F5F5"/);
  assert.match(xml, /<w:jc w:val="center"/);
  assert.match(xml, /<w:jc w:val="right"/);
  assert.match(xml, /<w:vAlign w:val="top"/);
  assert.match(xml, /<w:tblCellMar>/);
});

test('Word preserves nested emphasis and styled, navigable external and internal links', async () => {
  const markdown = '# A heading\n\n**Outer *inner* outer** and [**bold link**](https://example.com).\n\n[Jump](#a-heading)\n\n## A heading\n\n[Second](#a-heading-1)';
  const zip = unzipEntries(await toDocx(markdown, async () => { throw new Error('Unexpected image'); }));
  const xml = zip.get('word/document.xml')!.toString();
  assert.match(xml, /<w:r><w:rPr><w:b\/>[\s\S]*?<w:i\/>[\s\S]*?<w:t[^>]*>inner<\/w:t>/);
  const link = xml.match(/<w:hyperlink[^>]*r:id[^>]*>[\s\S]*?<\/w:hyperlink>/)?.[0];
  assert.ok(link);
  assert.match(link, /<w:b\/>/);
  assert.match(link, /w:color w:val="227C78"/);
  assert.match(link, /<w:u w:val="single"/);
  const bookmarks = [...xml.matchAll(/<w:bookmarkStart[^>]*w:name="([^"]+)"/g)].map(match => match[1]);
  assert.equal(bookmarks.length, 2);
  assert.notEqual(bookmarks[0], bookmarks[1]);
  for (const name of bookmarks) assert.ok(xml.includes(`w:anchor="${name}"`), 'Every internal link targets a real heading bookmark');
});

test('a malformed or missing heading fragment preserves readable text without aborting Word export', async () => {
  const markdown = '# Example\n\n[Malformed](#foo%bar) [Missing](#not-here)\n\nDocument text.\n\n## Caf\u00e9\n\n[Unicode](#caf%C3%A9)';
  const zip = unzipEntries(await toDocx(markdown, async () => { throw new Error('Unexpected image'); }));
  const xml = zip.get('word/document.xml')!.toString();
  for (const label of ['Malformed', 'Missing', 'Document text.', 'Unicode']) assert.ok(xml.includes(`>${label}</w:t>`));
  assert.equal((xml.match(/<w:hyperlink/g) ?? []).length, 1, 'Only the valid, existing Unicode heading is linked');
});

test('Word retains list continuations after nested children, independent numbering and task checkboxes', async () => {
  const markdown = '3. First\n\n   Before child.\n\n   - Child\n\n   After child.\n\n4. Second\n\nBetween lists.\n\n7. Restart\n\n- [ ] Pending\n- [x] Complete\n';
  const zip = unzipEntries(await toDocx(markdown, async () => { throw new Error('Unexpected image'); }));
  const xml = zip.get('word/document.xml')!.toString();
  const paragraphs = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/g)].map(match => match[0]);
  for (const text of ['Before child.', 'After child.']) {
    const continuation = paragraphs.find(paragraph => paragraph.includes(`>${text}</w:t>`));
    assert.ok(continuation);
    assert.match(continuation, /w:ind w:left="360"/);
    assert.doesNotMatch(continuation, /<w:numPr>/, 'Continuation paragraphs must not acquire another list marker');
  }
  const numbering = zip.get('word/numbering.xml')!.toString();
  assert.match(numbering, /w:start w:val="3"/);
  assert.match(numbering, /w:start w:val="7"/);
  assert.match(xml, /\u2610/);
  assert.match(xml, /\u2611/);
  assert.doesNotMatch(xml, /\[ \]|\[x\]/);
  assert.match(xml, /<w:tab\/>/);
});

test('Word scales images to the A4 content width without enlarging small images or changing aspect ratio', async () => {
  const dimensionsOnly = Buffer.from(png);
  dimensionsOnly.writeUInt32BE(2000, 16);
  dimensionsOnly.writeUInt32BE(1000, 20);
  const zip = unzipEntries(await toDocx('![Wide](wide.png)', async () => ({ data: dimensionsOnly, mime: 'image/png' })));
  const xml = zip.get('word/document.xml')!.toString();
  const extent = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  assert.ok(extent);
  const width = Number(extent[1]) / 9525;
  const height = Number(extent[2]) / 9525;
  assert.ok(width <= 9638 / 15 + 1);
  assert.ok(Math.abs(width / height - 2) < .01);
});

test('Word preserves code tabs, whitespace, blank lines and quote/list indentation', async () => {
  const markdown = '> 1. Code\n>\n>    ```text\n>    \tfirst\n>\n>      second\n>    ```\n';
  const zip = unzipEntries(await toDocx(markdown, async () => { throw new Error('Unexpected image'); }));
  const xml = zip.get('word/document.xml')!.toString();
  assert.match(xml, /<w:tab\/>/);
  assert.match(xml, /xml:space="preserve">  second<\/w:t>/);
  assert.match(xml, /w:ind w:left="720"/);
  assert.match(xml, /w:fill="F3F6F6"/);
  assert.match(xml, /w:spacing[^>]*w:line="300"/);
});

test('PDF uses visual-style hierarchy, bounded tables, task state and a clean printable page', async () => {
  const html = await toPrintHTML('# Title\n\n## Section\n\n#### Small heading\n\n- [ ] Pending\n- [X] Complete\n\n| A | B |\n| :---: | ---: |\n| C | D |\n\n> Quote\n', null);
  assert.match(html, /body \{ margin: 0;/);
  assert.match(html, /body > :first-child \{ margin-top: 0;/);
  assert.match(html, /h1 \{ font-size: 25.5pt/);
  assert.match(html, /h4 \{ font-size: 11.5pt/);
  assert.match(html, /table-layout: fixed/);
  assert.match(html, /thead \{ display: table-header-group/);
  assert.match(html, /class="task-item"/);
  assert.match(html, /aria-label="Incomplete task">&#x2610;/);
  assert.match(html, /aria-label="Completed task">&#x2611;/);
  assert.match(html, /style="text-align:center"/);
  assert.match(html, /style="text-align:right"/);
  assert.doesNotMatch(html, /\[ \] Pending|\[X\] Complete/);
  assert.match(html, /<blockquote>/);
});
