import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentPreviewHTML, headings, parser, requiresInteractiveExport } from '../lib/markdown.js';
import { firstPublishingBlock, publishingBlockAtStart, publishingBlockRanges, publishingCalloutPalette, publishingCSS, type PublishingMeta } from '../lib/publishing.js';
import { toDocx, toOfflineHTML, toPrintHTML } from '../lib/export.js';
import { publishingTemplateMarkdown } from '../lib/publishing-templates.js';
import { unzipEntries } from './zip.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const image = `data:image/png;base64,${png.toString('base64')}`;
const noImage = async (): Promise<never> => { throw new Error('Unexpected image'); };
const wordXML = async (source: string) => unzipEntries(await toDocx(source, noImage)).get('word/document.xml')!.toString();

test('block tokenizer preserves exact consumed source, newline style, and following ordinary Markdown', () => {
  const blocks = [
    { kind: 'callout', raw: '> [!NOTE] A title\r\n> **Body**\r\n' },
    { kind: 'callout', raw: '>[!div class="checklist"]\n> - One\n> - Two\n' },
    { kind: 'tabs', raw: '# [One](#tab/one)\nA\n# [Two](#tab/two)\nB\n---\n' },
    { kind: 'tabs', raw: ':::tabs\n:::tab One\nA\n:::tab-end\n:::tabs-end\n' },
    { kind: 'steps', raw: ':::steps\n1. First\n2. Second\n:::steps-end\n' },
    { kind: 'image', raw: ':::image type="content" source="a.png" alt-text="A" :::\n' },
    { kind: 'image', raw: ':::image type="complex" source="a.png" alt-text="A" :::\nLong **description**.\n:::image-end\n' },
    { kind: 'metadata', raw: '---\r\ntitle: Test\r\ntags:\r\n  - one\r\n---\r\n' },
    { kind: 'unsupported', raw: ':::unknown\nOriginal <script>code</script>\n:::unknown-end\n' },
    { kind: 'include', raw: '[!INCLUDE [Details](details.md)]\n' },
  ];
  for (const { kind, raw } of blocks) {
    assert.deepEqual(publishingBlockAtStart(`${raw}\nFollowing *ordinary* Markdown.\n`), { kind, raw });
    const token = parser.parse(raw, {}).find(token => token.type.startsWith('publishing_'));
    assert.ok(token);
    assert.equal((token.meta as PublishingMeta).raw, raw);
  }
  for (const source of ['', '# Heading\n', 'Normal paragraph.\n', '---\n\nHorizontal rule.\n', '    :::steps\n']) {
    assert.equal(publishingBlockAtStart(source), null);
  }
  assert.equal(firstPublishingBlock('Before\n\n> [!TIP]\n> Body\n'), 8);
  assert.equal(firstPublishingBlock('Before\n\n:::steps\n'), 8);
  assert.equal(firstPublishingBlock('Plain Markdown'), -1);
});

test('all common alerts and known safe divisions retain formatted content and escaped optional titles', () => {
  for (const variant of ['NOTE', 'TIP', 'IMPORTANT', 'CAUTION', 'WARNING']) {
    const html = documentPreviewHTML(`>[!${variant}] <img onerror=alert(1)>\n> Body **strong**, *emphasis* and [link](https://example.com).\n`, 'tab');
    assert.match(html, new RegExp(`publishing-callout-${variant.toLowerCase()}`));
    assert.match(html, /<strong>strong<\/strong>/);
    assert.match(html, /<em>emphasis<\/em>/);
    assert.match(html, /href="https:\/\/example.com"/);
    assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(html, /<img/);
  }
  for (const variant of ['checklist', 'nextstepaction']) {
    const html = documentPreviewHTML(`> [!div class="${variant}"]\n> - First\n> - Second\n`, '');
    assert.match(html, new RegExp(`publishing-callout-${variant}`));
    assert.match(html, /<ul>/);
    assert.match(html, /First/);
  }
  assert.doesNotMatch(documentPreviewHTML('> [!div class="arbitrary" onclick="bad"]\n> Content', ''), /class="arbitrary"|onclick="bad"/);
});

test('nested publishing structures share standard tokens, source maps, links and image scoping', () => {
  const source = '# Article\n\n> [!NOTE]\n> ## Inside\n> :::steps\n> 1. First\n> 2. ![Pixel](pixel.png)\n> :::steps-end\n> > [!TIP]\n> > Nested tip\n\n## After\n';
  const tokens = parser.parse(source, {});
  assert.equal(tokens.filter(token => token.type === 'publishing_callout_open').length, 2);
  assert.equal(tokens.filter(token => token.type === 'publishing_steps_open').length, 1);
  assert.equal(tokens.filter(token => token.type === 'ordered_list_open').length, 1);
  assert.deepEqual(headings(source).map(heading => [heading.displayText, heading.line]), [['Article', 0], ['Inside', 3], ['After', 11]]);
  const html = documentPreviewHTML(source, 'nested-tab');
  assert.match(html, /source=pixel.png&amp;document=nested-tab/);
  assert.match(html, /Nested tip/);
  const nativeContainers = '> > [!NOTE]\n> > Nested native quote\n\n- > [!TIP]\n  > In a list\n\n> :::zone pivot=one\n> Zone body\n> :::zone-end\n';
  const nested = documentPreviewHTML(nativeContainers, '');
  assert.match(nested, /<blockquote>\n<aside[^>]+><p[^>]+><svg[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg><span>Note<\/span><\/p>\n<p>Nested native quote<\/p>/);
  assert.match(nested, /publishing-callout-tip/);
  assert.match(nested, /data-publishing-zone="one"/);
  assert.doesNotMatch(nested, /publishing-unsupported/);
  const quotedCode = '> ```text\n> <!--\n> ```\n\n> [!NOTE]\n> Real callout after quoted code\n';
  assert.match(documentPreviewHTML(quotedCode, ''), /publishing-callout-note/);
});

const tabExamples = [
  '# [Windows](#tab/windows)\n\n**Windows body**\n\n## A section\n\n# [Linux](#tab/linux)\n\nLinux body\n\n---\n',
  ':::tabs\n:::tab Windows\n\n**Windows body**\n\n## A section\n:::tab-end\n:::tab Linux\nLinux body\n:::tab-end\n:::tabs-end\n',
];

test('both tab syntaxes produce accessible matching controls, no article H1s, and stable unique IDs', () => {
  for (const source of tabExamples) {
    const html = documentPreviewHTML(source + '\n# Article after\n', 'tab');
    assert.match(html, /data-publishing-tabs="publishing-tabs-0"/);
    assert.match(html, /role="tablist"/);
    for (const index of [0, 1]) {
      assert.match(html, new RegExp(`role="tab"[^>]+aria-controls="publishing-tabs-0-panel-${index}"[^>]+data-publishing-tab="${index}"`));
      assert.match(html, new RegExp(`role="tabpanel"[^>]+id="publishing-tabs-0-panel-${index}"[^>]+data-publishing-panel="${index}"`));
    }
    assert.match(html, /data-publishing-panel="1" hidden/);
    assert.match(html, /<strong>Windows body<\/strong>/);
    assert.deepEqual(headings(source).map(heading => [heading.level, heading.displayText]), [[2, 'A section']]);
    assert.equal((html.match(/<h1>/g) ?? []).length, 1);
    const double = documentPreviewHTML(source + '\n' + source, 'tab');
    assert.match(double, /data-publishing-tabs="publishing-tabs-1"/);
    assert.equal(double, documentPreviewHTML(source + '\n' + source, 'tab'));
  }
  const html = documentPreviewHTML(':::tabs\n:::tab <script>alert("x")</script>\nBody\n:::tab-end\n:::tabs-end\n', '');
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
});

test('fenced syntax stays literal, including fake tab headers and terminators', () => {
  const source = '# [First](#tab/first)\n\n```md\n# [Not a tab](#tab/fake)\n---\n:::steps-end\n```\n\nFirst body\n# [Second](#tab/second)\nSecond body\n---\n';
  const tokens = parser.parse(source, {});
  assert.equal(tokens.filter(token => token.type === 'publishing_tab_open').length, 2);
  assert.equal(tokens.find(token => token.type === 'fence')?.content, '# [Not a tab](#tab/fake)\n---\n:::steps-end\n');
  assert.equal(publishingBlockAtStart(source + '\nAfter')?.raw, source);
  const simple = '```md\n> [!NOTE]\n> Not an alert\n:::steps\n1. Not steps\n:::steps-end\n```\n';
  assert.equal(parser.render(simple), new MarkdownIt({ html: false, linkify: true }).render(simple));
});

test('image directives expose ordinary image tokens with safe alt, caption, border and complex description', () => {
  const source = ':::image type="complex" source="photos/my%20photo.png" alt-text="A &quot;quoted&quot; &lt;image&gt;" border="true" caption="A **caption**" :::\nA detailed *description*.\n:::image-end\n';
  const tokens = parser.parse(source, {});
  const token = tokens.flatMap(token => token.children ?? []).find(token => token.type === 'image');
  assert.ok(token);
  assert.equal(token.attrGet('src'), 'photos/my%20photo.png');
  assert.equal(token.content, 'A "quoted" <image>');
  const html = documentPreviewHTML(source, 'image-tab');
  assert.match(html, /publishing-image-complex publishing-image-bordered/);
  assert.match(html, /alt="A &quot;quoted&quot; &lt;image&gt;"/);
  assert.match(html, /source=photos%2Fmy%2520photo.png&amp;document=image-tab/);
  assert.match(html, /<figcaption>A <strong>caption<\/strong><\/figcaption>/);
  assert.match(html, /A detailed <em>description<\/em>/);
  assert.match(documentPreviewHTML(':::image type=icon source=icon.png alt-text=Icon :::', ''), /publishing-image-icon/);
  const escaped = ':::image type=content source="pixel.png" alt-text="A \\"quoted\\" image" caption="It\'s \\"quoted\\"" :::\n';
  const escapedHTML = documentPreviewHTML(escaped, '');
  assert.match(escapedHTML, /alt="A &quot;quoted&quot; image"/);
  assert.match(escapedHTML, /data-lekh-source="pixel.png"/);
  assert.match(escapedHTML, /<figcaption>It's &quot;quoted&quot;<\/figcaption>/);
  assert.equal(publishingBlockAtStart(escaped)?.raw, escaped);
});

test('directive end markers accept trailing colons without consuming following content', () => {
  const blocks = [
    { kind: 'image', raw: ':::image type="complex" source="../../articles/diagram.png" alt-text="A diagram.":::\nLong **description**.\n:::image-end:::\n' },
    { kind: 'zone', raw: ':::zone pivot="first"\nVariant body.\n:::zone-end:::\n' },
    { kind: 'selector', raw: ':::selector title="Choose"\n- [First](#variant/first)\n:::selector-end:::\n' },
    { kind: 'tabs', raw: ':::tabs\n:::tab First\nPanel body.\n:::tab-end:::\n:::tabs-end:::\n' },
    { kind: 'steps', raw: ':::steps\n1. First step.\n:::steps-end:::\n' },
  ];
  for (const { kind, raw } of blocks) {
    for (const ending of [':::', ' :::', ':::  ']) {
      const source = raw.replace(/:::$/gm, ending);
      assert.deepEqual(publishingBlockAtStart(`${source}\nFollowing paragraph.\n`), { kind, raw: source });
      const html = documentPreviewHTML(`${source}\nFollowing paragraph.\n`, '');
      assert.doesNotMatch(html, /not rendered|Source retained/);
      assert.match(html, /<p>Following paragraph\.<\/p>/);
    }
  }
});

test('frontmatter is collapsed, escaped, retained in tokens and excluded from article headings and exports', async () => {
  const source = '---\r\ntitle: "<script>Bad</script>"\r\ndescription: hidden metadata\r\n---\r\n\r\n# Actual article\r\n';
  const html = documentPreviewHTML(source, '');
  assert.match(html, /<pre class="publishing-metadata">/);
  assert.doesNotMatch(html, /Document metadata<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]+open|<script/);
  assert.match(html, /&lt;script&gt;Bad&lt;\/script&gt;/);
  assert.deepEqual(headings(source).map(heading => [heading.displayText, heading.line]), [['Actual article', 5]]);
  const print = await toPrintHTML(source, null);
  assert.doesNotMatch(print.slice(print.indexOf('<body>')), /metadata|hidden metadata|Bad/);
  const xml = await wordXML(source);
  assert.match(xml, /Actual article/);
  assert.doesNotMatch(xml, /hidden metadata|Bad/);
});

test('unknown, invalid, unclosed, and unresolved blocks never disappear or execute', async () => {
  const cases = [
    ':::future\nUnrendered <script>body</script>\n:::future-end\n',
    '[!INCLUDE [Private details](../private.md)]\n',
    ':::image type=content source="javascript:alert(1)" alt-text=Bad :::\n',
    ':::image type=content source=a.png alt-text=A onclick="bad" :::\n',
    ':::image type=complex source=a.png alt-text=A :::\nDescription without an end\n',
    ':::tabs\n:::tab Missing-end\nBody\n:::tabs-end\n',
    ':::steps\n1. Without end\n',
    '# [Missing terminator](#tab/one)\nTab body\n',
    '---\ntitle: Missing terminator\n',
    ':::unknown-end\n',
  ];
  for (const source of cases) {
    const block = publishingBlockAtStart(source);
    assert.ok(block);
    assert.equal(block.raw, source);
    const html = documentPreviewHTML(source, '');
    assert.match(html, /publishing-unsupported/);
    assert.match(html, /not rendered|not loaded|Unclosed|unclosed|Invalid|Invalid or unclosed|source retained/i);
    assert.doesNotMatch(html, /<script|src="javascript:|onclick="bad"/);
    const xml = await wordXML(source);
    assert.match(xml, /source retained|Source retained|not rendered|not loaded/i);
    assert.match(xml, /Consolas/);
  }
});

test('nesting and large malformed inputs have bounded parsing and preserve all text', () => {
  const source = `${':::steps\n'.repeat(20)}1. Innermost text\n${':::steps-end\n'.repeat(20)}`;
  const html = documentPreviewHTML(source, '');
  assert.match(html, /12-level limit/);
  assert.match(html, /Innermost text/);
  const unsupported = ':::future\n'.repeat(5000) + 'Final text\n';
  const tokens = parser.parse(unsupported, {});
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].content, unsupported);
  assert.equal(publishingBlockAtStart(unsupported)?.raw, unsupported);
});

test('only attribute-free br, sub and sup are accepted and exported as safe formatting', async () => {
  const source = 'H<sub>2</sub>O<br/>x<sup>2</sup> <script>alert(1)</script> <sub onclick="bad">bad</sub>';
  const html = documentPreviewHTML(source, '');
  assert.match(html, /H<sub>2<\/sub>O<br>\nx<sup>2<\/sup>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;sub onclick=&quot;bad&quot;&gt;/);
  const xml = await wordXML(source);
  assert.match(xml, /w:vertAlign w:val="subscript"/);
  assert.match(xml, /w:vertAlign w:val="superscript"/);
  assert.match(xml, /<w:br\/>/);
});

test('standard Markdown remains byte-identical to the configured stock renderer', () => {
  const source = '# Heading\n\nParagraph **bold** *em* ~~strike~~ `code` &amp; text.\n\n> Quote\n>\n> Second paragraph.\n\n- One\n  - Nested\n\n1. Ordered\n2. Two\n\n| A | B |\n| --- | ---: |\n| C | D |\n\n---\n\n    :::image is code\n\n[link][ref]\n\n[ref]: https://example.com\n\n![alt](picture.png)\n';
  const baseline = new MarkdownIt({ html: false, linkify: true, breaks: false });
  assert.equal(parser.render(source), baseline.render(source));
  assert.equal(publishingBlockAtStart(source), null);
});

test('offline HTML retains every panel and image, omits metadata, and preserves unsupported source', async () => {
  for (const tabs of tabExamples) {
    const source = `---\ntitle: Metadata secret\n---\n\n# Article\n\n${tabs}\n:::image type=content source="${image}" alt-text=Pixel caption="Pixel caption" :::\n\n:::future\nFallback raw\n:::future-end\n`;
    const html = await toOfflineHTML(source, null);
    const body = html.split('<body>')[1].split('<script>')[0];
    assert.match(body, /<h1 id="article">Article<\/h1>/);
    assert.match(body, /<h2 id="a-section">A section<\/h2>/);
    assert.match(body, /data-publishing-panel="1">/);
    assert.match(body, /publishing-tab-label">Windows/);
    assert.match(body, /publishing-tab-label">Linux/);
    assert.match(body, /Windows body/);
    assert.match(body, /Linux body/);
    assert.match(body, /src="data:image\/png;base64,/);
    assert.match(body, /Pixel caption/);
    assert.match(body, /Fallback raw/);
    assert.doesNotMatch(body, /Metadata secret| hidden/);
    await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*tabbed examples or variants.*HTML/);
    await assert.rejects(() => wordXML(source), /Word and PDF export.*tabbed examples or variants.*HTML/);
  }
  assert.match(publishingCSS, /@media print/);
  assert.match(publishingCSS, /\.publishing-tab-panel\[hidden\],\.publishing-tab-label \{ display: block !important/);
});

test('DOCX uses shared tokens for styled alerts, steps, images, captions, and descriptions', async () => {
  const source = '# Article\n\n> [!WARNING] Careful\n> **Read this** before continuing.\n\n:::steps\n1. First step\n2. Second step\n:::steps-end\n\n' +
    ':::image type=complex source=pixel.png alt-text="Pixel alt" caption="Pixel caption" :::\nComplex **description**.\n:::image-end\n';
  const loaded: string[] = [];
  const zip = unzipEntries(await toDocx(source, async source => {
    loaded.push(source);
    return { data: png, mime: 'image/png' };
  }));
  const xml = zip.get('word/document.xml')!.toString();
  for (const text of ['Article', 'Careful', 'Read this', 'First step', 'Second step', 'Pixel caption', 'description']) {
    assert.ok(xml.includes(text), text);
  }
  assert.match(xml, /w:fill="FFF9F5"/);
  assert.match(xml, /w:color="8A3707"/);
  assert.match(xml, /<w:numPr>/);
  assert.match(xml, /descr="Pixel alt"/);
  assert.equal((xml.match(/w:pStyle w:val="Heading1"/g) ?? []).length, 1);
  assert.equal((xml.match(/<w:bookmarkStart/g) ?? []).length, 1, 'Only article headings receive navigation bookmarks');
  assert.ok([...zip.keys()].some(path => path.startsWith('word/media/')));
  assert.deepEqual(loaded, ['pixel.png']);
});

test('indented heading-level tab headers inside variant zones never become article outline headings', async () => {
  const tabs = '   #### [Managed identity](#tab/msi)\n\n   Managed **body**\n\n   #### [Service principal](#tab/spn)\n\n   Principal body\n\n   ---\n';
  const source = '# Article\n\n:::zone pivot="sbd-shared-disk, sbd-iscsi"\n' + tabs + ':::zone-end\n\n## After\n';
  const html = documentPreviewHTML(source, '');
  assert.match(html, /data-publishing-zone="sbd-shared-disk,sbd-iscsi"/);
  assert.match(html, /publishing-zone-label">Sbd Shared Disk \/ Sbd Iscsi/);
  assert.match(html, /data-publishing-tab="0">Managed identity/);
  assert.match(html, /data-publishing-tab="1">Service principal/);
  assert.deepEqual(headings(source).map(heading => heading.displayText), ['Article', 'After']);
  const exported = await toOfflineHTML(source, null);
  assert.match(exported, /Managed identity/);
  assert.match(exported, /Service principal/);
  assert.match(exported, /Principal body/);
  assert.match(exported, /data-publishing-panel="1">/);
  await assert.rejects(() => wordXML(source), /Word and PDF export.*HTML/);
  await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*HTML/);
});

test('implicit DocFX tabs end with their list item or zone and retain following numbered content', async () => {
  const tabs = '   #### [Managed identity](#tab/msi)\n   ```sh\n   echo first\n   ```\n' +
    '   #### [Service principal](#tab/spn)\n   ```sh\n   echo second\n   ```\n';
  const following = '1. Following numbered instruction.\n   ```sh\n   echo outside\n   ```\n';
  const source = ':::zone pivot=example\n1. Configure identity.\n' + tabs + following + ':::zone-end\n';
  const tokens = parser.parse(source, {});
  assert.equal(tokens.filter(token => token.type === 'publishing_tabs_open').length, 1);
  assert.equal(tokens.filter(token => token.type === 'publishing_tab_open').length, 2);
  assert.equal(tokens.filter(token => token.type === 'publishing_unsupported').length, 0);
  const close = tokens.findIndex(token => token.type === 'publishing_tabs_close');
  const next = tokens.findIndex(token => token.type === 'inline' && token.content === 'Following numbered instruction.');
  assert.ok(close >= 0 && next > close, 'The next list item remains outside the tab panels');
  assert.equal((tokens.find(token => token.type === 'publishing_tabs_open')!.meta as PublishingMeta).raw, tabs);
  assert.deepEqual(publishingBlockAtStart(tabs + following), { raw: tabs, kind: 'tabs' });
  assert.deepEqual(publishingBlockRanges(tabs + following), [{ from: 0, to: tabs.length, raw: tabs, kind: 'tabs' }]);
  const crlf = tabs.replace(/\n/g, '\r\n');
  assert.deepEqual(publishingBlockAtStart(crlf + following), { raw: crlf, kind: 'tabs' });
  const html = documentPreviewHTML(source, '');
  assert.match(html, /data-publishing-tab="0">Managed identity/);
  assert.match(html, /data-publishing-tab="1">Service principal/);
  assert.match(html, /Following numbered instruction/);
  assert.doesNotMatch(html, /publishing-unsupported/);
  const zoneOnly = ':::zone pivot=example\n' + tabs + ':::zone-end\n\n## After zone\n';
  assert.equal(parser.parse(zoneOnly, {}).filter(token => token.type === 'publishing_tab_open').length, 2);
  assert.doesNotMatch(documentPreviewHTML(zoneOnly, ''), /publishing-unsupported/);
  const exported = await toOfflineHTML(source, null);
  assert.match(exported, /data-publishing-panel="1">/);
  assert.match(exported, /Following numbered instruction/);
  assert.match(exported.split('<body>')[1].split('<script>')[0].replace(/<[^>]+>/g, ''), /echo outside/);
  await assert.rejects(() => wordXML(source), /Word and PDF export.*HTML/);
  await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*HTML/);
});

test('implicit DocFX tabs inside a numbered list retain both peers and following list items', () => {
  const source = '1. Configure ENSA specific properties and constraints.\n' +
    '   #### [ENSA2](#tab/ensa2)\n   ```bash\n   sudo crm configure property priority-fencing-delay=30\n   ```\n' +
    '   #### [ENSA1](#tab/ensa1)\n   ```bash\n   sudo crm_attribute --delete --name priority-fencing-delay\n   ```\n\n' +
    '1. Enable the nodes and take the cluster out of maintenance mode.\n   ```bash\n   sudo crm node online sap-cl1\n   ```\n';
  const html = documentPreviewHTML(source, '');
  assert.match(html, /data-publishing-tab="0">ENSA2/);
  assert.match(html, /data-publishing-tab="1">ENSA1/);
  assert.match(html, /Enable the nodes and take the cluster out of maintenance mode/);
  assert.doesNotMatch(html, /Unclosed tabs|publishing-unsupported/);
});

test('implicit tabs require multiple peers and stop before same or higher non-tab headings or EOF', () => {
  const tabs = '#### [One](#tab/one)\nFirst body\n\n##### Nested detail\nDetails\n\n#### [Two](#tab/two)\nSecond body\n';
  for (const following of ['', '#### Next same-level section\nArticle content\n', '### Next parent section\nArticle content\n']) {
    const source = tabs + following;
    assert.deepEqual(publishingBlockAtStart(source), { raw: tabs, kind: 'tabs' });
    const tokens = parser.parse(source, {});
    assert.equal(tokens.filter(token => token.type === 'publishing_tab_open').length, 2);
    assert.equal(tokens.filter(token => token.type === 'publishing_unsupported').length, 0);
    assert.equal(headings(source).length, following ? 2 : 1, 'Only real article headings appear in the outline');
  }
  const malformed = '#### [Only panel](#tab/one)\nBody\n';
  assert.deepEqual(publishingBlockAtStart(malformed + '### Following section\nKept.\n'), { raw: malformed, kind: 'unsupported' });
  assert.match(documentPreviewHTML(malformed + '### Following section\nKept.\n', ''), /<h3>Following section<\/h3>/);
  assert.deepEqual(publishingBlockAtStart(malformed + '---\n'), { raw: malformed + '---\n', kind: 'tabs' }, 'Explicit groups can still contain one panel');
});

test('explicit toolbar tabs retain selected H1 content and take priority over implicit heading boundaries', async () => {
  const template = publishingTemplateMarkdown('publishing-tabs', '# Selected heading\n\nSelected body.')!;
  for (const source of [template, template.replace('Content for the second example.', '# Second heading\n\nSecond body.')]) {
    const tokens = parser.parse(source, {});
    assert.equal(tokens.filter(token => token.type === 'publishing_tabs_open').length, 1);
    assert.equal(tokens.filter(token => token.type === 'publishing_tab_open').length, 2);
    assert.equal(tokens.filter(token => token.type === 'publishing_unsupported').length, 0);
    assert.deepEqual(publishingBlockAtStart(source + '\n\nFollowing article text.'), { raw: source + '\n', kind: 'tabs' });
    assert.deepEqual(publishingBlockRanges(source), [{ from: 0, to: source.length, raw: source, kind: 'tabs' }]);
    assert.equal((tokens.find(token => token.type === 'publishing_tabs_open')!.meta as PublishingMeta).raw, source);
    assert.equal(headings(source)[0].displayText, 'Selected heading');
    const html = documentPreviewHTML(source, '');
    assert.match(html, /data-publishing-tab="0">Example 1/);
    assert.match(html, /data-publishing-tab="1">Example 2/);
    assert.match(html, /<h1>Selected heading<\/h1>/);
    assert.match(html, /Selected body\./);
    assert.doesNotMatch(html, /publishing-unsupported/);
    const exported = await toOfflineHTML(source, null);
    assert.match(exported, /<h1 id="selected-heading">Selected heading<\/h1>/);
    assert.match(exported, /data-publishing-panel="1">/);
    assert.match(exported, /Selected body\./);
    assert.match(exported, /Example 2/);
    await assert.rejects(() => wordXML(source), /Word and PDF export.*HTML/);
    await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*HTML/);
  }
  const implicit = '   #### [One](#tab/one)\n   First body\n   #### [Two](#tab/two)\n   Second body\n';
  const following = '1. Next list item\n\n   ---\n';
  assert.deepEqual(publishingBlockAtStart(implicit + following), { raw: implicit, kind: 'tabs' });
  const zone = ':::zone pivot=example\n' + implicit + ':::zone-end\n\n---\n';
  assert.equal(parser.parse(zone, {}).filter(token => token.type === 'publishing_tab_open').length, 2);
  assert.doesNotMatch(documentPreviewHTML(zone, ''), /publishing-unsupported/);
});

test('generic document selectors decode safe local labels and export interactive variants', async () => {
  const selector = ':::selector title="Choose &quot;path&quot; &amp; method"\n- [Shared \\[disk\\]](#variant/shared)\n- [Network](#variant/network)\n:::selector-end\n';
  const first = ':::zone pivot="shared,network"\nCommon **instructions**.\n:::zone-end\n';
  const second = ':::zone pivot="network"\nNetwork-only instructions.\n:::zone-end\n';
  const source = selector + '\n' + first + '\n' + second;
  assert.equal(publishingBlockAtStart(selector + '\n' + first)?.raw, selector);
  const tokens = parser.parse(source, {});
  const meta = tokens.find(token => token.type === 'publishing_selector')!.meta as PublishingMeta;
  assert.equal(meta.title, 'Choose "path" & method');
  assert.deepEqual(meta.options, [{ label: 'Shared [disk]', id: 'shared' }, { label: 'Network', id: 'network' }]);
  const html = documentPreviewHTML(source, '');
  assert.match(html, /data-publishing-selector="primary" aria-label="Choose &quot;path&quot; &amp; method"/);
  assert.match(html, /data-publishing-variant="shared" aria-pressed="true">Shared \[disk\]/);
  assert.match(html, /publishing-zone-label">Shared \[disk\] \/ Network/);
  assert.match(html, /data-publishing-zone="network"/);
  assert.equal(headings(source).length, 0);
  const exported = await toOfflineHTML(source, null);
  assert.match(exported, /Choose &quot;path&quot; &amp; method/);
  assert.match(exported, /Shared \[disk\] \/ Network/);
  assert.match(exported, /Common <strong>instructions<\/strong>/);
  assert.match(exported, /Network-only instructions/);
  assert.match(exported, /data-publishing-variant="network"/);
  await assert.rejects(() => wordXML(source), /Word and PDF export.*HTML/);
  await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*HTML/);
  for (const invalid of [
    ':::zone pivot="bad onclick=evil"\nBody\n:::zone-end\n',
    ':::selector title="T"\n- [One](#variant/same)\n- [Two](#variant/same)\n:::selector-end\n',
  ]) {
    assert.match(documentPreviewHTML(invalid, ''), /publishing-unsupported/);
    assert.equal(publishingBlockAtStart(invalid)?.raw, invalid);
  }
});

test('interactive export retains every alternative and static exports clearly reject them', async () => {
  const source = '---\ntitle: Private metadata\n---\n\n## Article heading\n\n' +
    '# [First example](#tab/first)\nFirst body.\n# [Second example](#tab/second)\nSecond body.\n---\n\n' +
    ':::selector title="Choose a deployment"\n- [Availability Zones](#variant/zones)\n- [Scale Set](#variant/scale)\n:::selector-end\n\n' +
    ':::zone pivot="zones"\nZone instructions.\n:::zone-end\n\n' +
    ':::zone pivot="scale"\nScale instructions.\n:::zone-end\n';
  const html = await toOfflineHTML(source, null);
  const body = html.split('<body>')[1].split('<script>')[0];
  assert.doesNotMatch(body, /Private metadata/);
  assert.match(body, /role="tab"/);
  assert.match(body, /aria-labelledby=/);
  assert.match(body, /aria-pressed=/);
  for (const text of ['First example', 'First body.', 'Second example', 'Second body.', 'Availability Zones', 'Zone instructions.', 'Scale Set', 'Scale instructions.']) {
    assert.ok(body.includes(text), `HTML retains ${text}`);
  }
  assert.ok(body.indexOf('First body.') < body.indexOf('Second body.'));
  assert.ok(body.indexOf('Zone instructions.') < body.indexOf('Scale instructions.'));
  assert.match(html, /<noscript>/);
  await assert.rejects(() => wordXML(source), /Word and PDF export.*HTML/);
  await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*HTML/);
});

test('interactive export detection uses parsed blocks, including nested blocks but not literal lookalikes', async () => {
  const tabs = '# [One](#tab/one)\nFirst.\n# [Two](#tab/two)\nSecond.\n---\n';
  const zone = ':::zone pivot=first\nFirst.\n:::zone-end\n';
  const selector = ':::selector title="Choose"\n- [One](#variant/one)\n:::selector-end\n';
  for (const source of [tabs, zone, selector, `:::steps\n1. Step\n\n${tabs}:::steps-end\n`]) {
    assert.equal(requiresInteractiveExport(source), true, source);
    await assert.rejects(() => wordXML(source), /Word and PDF export.*HTML/);
    await assert.rejects(() => toPrintHTML(source, null), /Word and PDF export.*HTML/);
  }
  for (const source of [
    `\`\`\`md\n${tabs}${zone}${selector}\`\`\`\n`,
    `    :::zone pivot=first\n    Text\n    :::zone-end\n`,
    '---\ntitle: Metadata only\n---\n\nText.\n',
    ':::zone pivot="bad onclick=evil"\nText\n:::zone-end\n',
  ]) {
    assert.equal(requiresInteractiveExport(source), false, source);
    await wordXML(source);
    await toPrintHTML(source, null);
  }
});

test('source selection ranges exclude fenced, indented-code and comment lookalikes and preserve CRLF offsets', () => {
  const block = '> [!NOTE]\r\n> Real callout\r\n';
  const unknown = ':::future\r\nReal raw\r\n:::future-end\r\n';
  const before = '```md\r\n> [!NOTE]\r\n> In code\r\n:::future\r\n:::future-end\r\n```\r\n\r\n' +
    '<!--\r\n:::steps\r\n1. Comment only\r\n:::steps-end\r\n-->\r\n\r\n    :::image type=icon source=x alt-text=x :::\r\n\r\n';
  const source = before + block + '\r\n' + unknown;
  assert.deepEqual(publishingBlockRanges(source), [
    { from: before.length, to: before.length + block.length, raw: block, kind: 'callout' },
    { from: before.length + block.length + 2, to: source.length, raw: unknown, kind: 'unsupported', reason: 'Directive not rendered; original source retained.' },
  ]);
  const nested = ':::zone pivot="one"\n> [!TIP]\n> Nested\n:::zone-end\n';
  assert.deepEqual(publishingBlockRanges(nested), [{ from: 0, to: nested.length, raw: nested, kind: 'zone' }]);
  const prefix = 'Inline `<!--` is not a comment.\n\n<!--\n```md\n:::steps\n:::steps-end\n-->\n\n';
  assert.deepEqual(publishingBlockRanges(prefix + block).map(range => range.raw), [block]);
  const commented = ':::steps\n<!--\n:::steps-end\n-->\n1. Actual step\n:::steps-end\n';
  assert.equal(publishingBlockAtStart(commented + '\nAfter')?.raw, commented);
});

test('all five measured light/dark palettes use matching label colors and light export colors', async () => {
  assert.deepEqual(Object.values(publishingCalloutPalette).map(value => [value.background, value.border, value.darkBackground, value.darkBorder]), [
    ['#efd9fd', '#3b2e58', '#3b2e58', '#efd9fd'],
    ['#f1faf1', '#0e700e', '#054b16', '#dff6dd'],
    ['#ebf3fc', '#115ea3', '#004173', '#9ccbee'],
    ['#fdf3f4', '#b10e1c', '#630001', '#fde7e9'],
    ['#fff9f5', '#8a3707', '#4a1e04', '#fdcfb4'],
  ]);
  const source = Object.keys(publishingCalloutPalette).map(variant => `> [!${variant.toUpperCase()}]\n> Body\n`).join('\n');
  const xml = await wordXML(source);
  for (const palette of Object.values(publishingCalloutPalette)) {
    assert.ok(xml.includes(`w:fill="${palette.background.slice(1).toUpperCase()}"`));
    assert.ok(xml.includes(`w:color="${palette.border.slice(1).toUpperCase()}"`));
  }
  assert.match(publishingCSS, /:root\[data-theme="dark"\] \.publishing-callout-note/);
  assert.match(publishingCSS, /\.publishing-callout \.publishing-callout-title \{[^}]*color: var\(--publishing-border\)/);
});

test('local images remain scoped to the Markdown folder unless embedded or project access is granted', async () => {
  const root = path.join(process.cwd(), `.publishing-export-${randomUUID()}`);
  const document = path.join(root, 'docs', 'article.md');
  try {
    await mkdir(path.dirname(document), { recursive: true });
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(path.dirname(document), 'pixel.png'), png);
    await writeFile(document, '# Article');
    await writeFile(path.join(root, 'assets', 'pixel.png'), png);
    const source = ':::image type=content source="pixel.png" alt-text="Local pixel" :::\n';
    const html = await toPrintHTML(source, document);
    assert.match(html, /src="data:image\/png;base64,/);
    assert.match(html, /alt="Local pixel"/);
    const externalImage = ':::image type=content source="../assets/pixel.png" alt-text="Outside pixel" :::\n';
    await assert.rejects(() => toPrintHTML(externalImage, document), /inside the Markdown file's folder/);
    const granted = await toPrintHTML(externalImage, document, undefined, root);
    assert.match(granted, /alt="Outside pixel"/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
