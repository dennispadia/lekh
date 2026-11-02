import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IncludeAccessPrompts, resolveIncludes, suggestedIncludeFolder } from '../lib/includes.js';
import { documentPreviewTokensHTML, parser } from '../lib/markdown.js';
import { hasInteractivePublishing, includeMarkdown } from '../lib/publishing.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-includes-'));
  const article = path.join(root, 'articles', 'article.md');
  await mkdir(path.dirname(article));
  await mkdir(path.join(root, 'includes'));
  await writeFile(article, '# Parent');
  return { root, article, includes: path.join(root, 'includes') };
}

test('reader Preview hides parent and nested Include comments but retains code and source', async () => {
  const { root, article, includes } = await fixture();
  try {
    const shared = '<!-- Shared private note -->\n\nIncluded prose <!-- inline private note --> stays.\n\n[!INCLUDE [Child](child.md)]\n\n```html\n<!-- literal code -->\n```\n';
    await writeFile(path.join(includes, 'shared.md'), shared);
    await writeFile(path.join(includes, 'child.md'), '> [!NOTE]\n> <!-- Nested private note -->\n> Visible nested prose.\n');
    const markdown = '<!-- Parent private note -->\n\n[!INCLUDE [Shared](../includes/shared.md)]\n';
    const tokens = await resolveIncludes(markdown, article, root, { preview: true, displayErrors: true });
    const html = documentPreviewTokensHTML(tokens, 'tab');
    assert.doesNotMatch(html, /private note|\[!INCLUDE/);
    assert.match(html, /Included prose  stays/);
    assert.match(html, /Visible nested prose/);
    assert.match(html, /&lt;!-- literal code --&gt;/);
    const ordinary = await resolveIncludes(markdown, article, root);
    assert.match(parser.renderer.render(ordinary, parser.options, {}), /Shared private note/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('includes expand without changing source, omit only front matter, and resolve local references', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'shared.md'), [
      '---', 'title: Private metadata', 'description: Not article text', '---', '',
      '# Included heading', '', '[Guide][guide]', '', '![Diagram](images/diagram.png)', '',
      '---', '', 'After the rule.', '', '[guide]: https://example.com/guide', '',
    ].join('\n'));
    const markdown = `# Parent\n\n${includeMarkdown('Shared', '../includes/shared.md')}\n`;
    const tokens = await resolveIncludes(markdown, article, root);
    const html = parser.renderer.render(tokens, parser.options, {});
    assert.match(html, /Included heading/);
    assert.match(html, /href="https:\/\/example.com\/guide"/);
    assert.match(html, /src="\.\.\/includes\/images\/diagram\.png"/);
    assert.match(html, /<hr/);
    assert.doesNotMatch(html, /Private metadata|Not article text|\[!INCLUDE/);
    assert.match(markdown, /\[!INCLUDE \[Shared\]\(\.\.\/includes\/shared\.md\)\]/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('BOM and CRLF front matter are omitted while ordinary horizontal rules remain', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'bom.md'), '\uFEFF---\r\ntitle: Hidden title\r\n---\r\n\r\nBody.\r\n\r\n---\r\n\r\nMore body.\r\n');
    const tokens = await resolveIncludes('[!INCLUDE [BOM](../includes/bom.md)]\n', article, root);
    const html = parser.renderer.render(tokens, parser.options, {});
    assert.doesNotMatch(html, /Hidden title/);
    assert.match(html, /Body\./);
    assert.match(html, /<hr/);
    assert.match(html, /More body\./);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('included nested list variants remain interactive and retain fenced code', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'nested.md'), [
      '---', 'title: Hidden', 'zone_pivot_groups: example', '---', '',
      '1. Configure services', '   1. Mount storage',
      '      :::zone pivot="azurefiles"', '         ```bash', '         echo first', '         ```', '      :::zone-end',
      '      :::zone pivot="anf"', '         ```bash', '         echo second', '         ```', '      :::zone-end', '',
    ].join('\n'));
    const tokens = await resolveIncludes('[!INCLUDE [Nested](../includes/nested.md)]\n', article, root);
    assert.equal(tokens.filter(token => token.type === 'publishing_zone_open').length, 2);
    assert.equal(hasInteractivePublishing(tokens), true);
    const html = parser.renderer.render(tokens, parser.options, {});
    assert.match(html, /data-publishing-zone="azurefiles"/);
    assert.match(html, /data-publishing-zone="anf"/);
    assert.match(html, /echo first/);
    assert.match(html, /echo second/);
    assert.doesNotMatch(html, /zone_pivot_groups|:::zone/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('include directives inside deeply nested lists resolve relative to their containing file', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'nested.md'), '1. Outer\n   1. Inner\n      [!INCLUDE [Child](child.md)]\n');
    await writeFile(path.join(includes, 'child.md'), 'Nested child content.\n');
    const tokens = await resolveIncludes('[!INCLUDE [Nested](../includes/nested.md)]\n', article, root);
    const html = parser.renderer.render(tokens, parser.options, {});
    assert.match(html, /Nested child content/);
    assert.doesNotMatch(html, /\[!INCLUDE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested list fences and HTML comments do not expand include directives', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'literal.md'), [
      '1. Example', '   ```markdown', '   [!INCLUDE [Fence](missing.md)]', '   ```', '',
      '   <!--', '   [!INCLUDE [Comment](missing.md)]', '   -->', '',
      '   1. Nested', '      Text <!--', '      [!INCLUDE [Inline comment](missing.md)]', '      -->',
      '      :::zone pivot="visible"', '      Retained after the comment.', '      :::zone-end', '',
    ].join('\n'));
    const tokens = await resolveIncludes('[!INCLUDE [Literal](../includes/literal.md)]\n', article, root);
    const html = parser.renderer.render(tokens, parser.options, {});
    assert.match(html, /\[!INCLUDE \[Fence\]/);
    assert.match(html, /data-publishing-zone="visible"/);
    assert.match(html, /Retained after the comment/);
    assert.doesNotMatch(html, /Could not load include/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('comment-like text in a list code block does not hide a later nested variant', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'code.md'), [
      '1. Outer', '', '       <!--', '', '   1. Nested',
      '      :::zone pivot="visible"', '      Real variant.', '      :::zone-end', '',
    ].join('\n'));
    const tokens = await resolveIncludes('[!INCLUDE [Code](../includes/code.md)]\n', article, root);
    assert.equal(tokens.filter(token => token.type === 'publishing_zone_open').length, 1);
    assert.match(parser.renderer.render(tokens, parser.options, {}), /Real variant/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('nested includes work inside tabs, alerts and lists but not code fences', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'nested.md'), 'Nested content.\n');
    await writeFile(path.join(includes, 'shared.md'), 'Shared content.\n\n[!INCLUDE [Nested](nested.md)]\n');
    const source = [
      '# [Example 1](#tab/example1)', '', '[!INCLUDE [Shared](../includes/shared.md)]', '',
      '# [Example 2](#tab/example2)', '', '> [!NOTE]', '> [!INCLUDE [Shared](../includes/shared.md)]', '',
      '---', '', '- Item', '', '  [!INCLUDE [Shared](../includes/shared.md)]', '',
      '```md', '[!INCLUDE [No file](missing.md)]', '```', '',
    ].join('\n');
    const tokens = await resolveIncludes(source, article, root);
    const html = parser.renderer.render(tokens, parser.options, {});
    assert.equal((html.match(/Nested content/g) ?? []).length, 3);
    assert.match(html, /No file/);
    assert.ok(hasInteractivePublishing(tokens));
    assert.doesNotMatch(html, /Could not load include/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('repeated included tab groups get distinct, internally consistent IDs', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'tabs.md'), '# [One](#tab/one)\nOne body.\n\n# [Two](#tab/two)\nTwo body.\n\n---\n');
    const tokens = await resolveIncludes('[!INCLUDE [One](../includes/tabs.md)]\n\n[!INCLUDE [Two](../includes/tabs.md)]\n', article, root);
    const html = parser.renderer.render(tokens, parser.options, {});
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(ids).size, ids.length);
    for (const [, target] of html.matchAll(/aria-controls="([^"]+)"/g)) assert.ok(ids.includes(target), target);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('include access is independent of images and restricted to the document folder or explicit project root', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'shared.md'), 'Authorized body.');
    await writeFile(path.join(path.dirname(article), 'local.md'), 'Local body.');
    assert.match(parser.renderer.render(await resolveIncludes('[!INCLUDE [Local](local.md)]\n', article), parser.options, {}), /Local body/);
    const source = '[!INCLUDE [Shared](../includes/shared.md)]\n';
    await assert.rejects(resolveIncludes(source, article), /outside the allowed folder/);
    assert.match(parser.renderer.render(await resolveIncludes(source, article, root), parser.options, {}), /Authorized body/);
    await assert.rejects(resolveIncludes('[!INCLUDE [Escape](%2e%2e/%2e%2e/private.md)]\n', article, root), /outside the allowed folder/);
    await assert.rejects(resolveIncludes(source, null, root), /Save this document/);
    await assert.rejects(resolveIncludes('[!INCLUDE [Remote](https://example.com/file.md)]\n', article, root), /Only local/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('three-level relative includes suggest the project without reading their content before permission', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-project-'));
  try {
    const article = path.join(root, 'articles', 'sap', 'workloads', 'article.md');
    const includes = path.join(root, 'includes');
    await mkdir(path.dirname(article), { recursive: true });
    await mkdir(includes);
    await writeFile(article, '# Parent');
    await writeFile(path.join(includes, 'shared.md'), 'Private shared content.\n\n![Diagram](images/diagram.png)\n\n[!INCLUDE [Nested](nested.md)]\n');
    await writeFile(path.join(includes, 'nested.md'), 'Nested shared content.\n');
    const realArticle = await realpath(article);
    const realRoot = await realpath(root);
    const source = [
      '# Parent', '', '[!INCLUDE [Shared](../../../includes/shared.md)]', '',
      '# [Example one](#tab/one)', '', '[!INCLUDE [Shared](../../../includes/shared.md)]', '',
      '# [Example two](#tab/two)', '', 'Other content.', '', '---', '',
    ].join('\n');
    const candidates: { document: string; candidate: string }[] = [];
    const blocked = await resolveIncludes(source, article, null, {
      displayErrors: true,
      onAccessRequired: (document, candidate) => candidates.push({ document, candidate }),
    });
    const blockedHTML = parser.renderer.render(blocked, parser.options, {});
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every(item => item.document === realArticle && item.candidate === path.join(realRoot, 'includes', 'shared.md')));
    assert.equal(suggestedIncludeFolder(realArticle, candidates.map(item => item.candidate)), realRoot);
    assert.doesNotMatch(blockedHTML, /Private shared content|Nested shared content/);
    assert.equal((blockedHTML.match(/Choose project folder/g) ?? []).length, 2);
    assert.doesNotMatch(parser.renderer.render(blocked, parser.options, { publishingExport: true }), /Choose project folder/);

    const allowed = await resolveIncludes(source, article, root);
    const html = parser.renderer.render(allowed, parser.options, {});
    assert.equal((html.match(/Private shared content/g) ?? []).length, 2);
    assert.equal((html.match(/Nested shared content/g) ?? []).length, 2);
    assert.match(html, /src="\.\.\/\.\.\/\.\.\/includes\/images\/diagram\.png"/);
    assert.equal(hasInteractivePublishing(allowed), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('suggested include roots include existing grants and never suggest a filesystem root', () => {
  const root = path.join(os.tmpdir(), 'lekh-suggestion');
  const article = path.join(root, 'articles', 'sap', 'workloads', 'article.md');
  const shared = path.join(root, 'includes', 'shared.md');
  assert.equal(suggestedIncludeFolder(article, [shared]), root);
  assert.equal(suggestedIncludeFolder(article, [shared, path.join(root, 'another-folder')]), root);
  assert.equal(suggestedIncludeFolder(article, []), null);
  assert.equal(suggestedIncludeFolder(article, ['relative.md']), null);
  assert.equal(suggestedIncludeFolder(article, [path.join(path.parse(root).root, 'elsewhere', 'shared.md')]), null);
});

test('out-of-folder includes nested in an allowed file use the containing file path for the suggestion', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(path.dirname(article), 'local.md'), '[!INCLUDE [Nested](../includes/shared.md)]\n');
    await writeFile(path.join(includes, 'shared.md'), 'Nested content after consent.');
    const source = '[!INCLUDE [Local](local.md)]\n';
    const candidates: string[] = [];
    const blocked = await resolveIncludes(source, article, null, {
      displayErrors: true,
      onAccessRequired: (_document, candidate) => candidates.push(candidate),
    });
    assert.equal(candidates.length, 1);
    assert.equal(suggestedIncludeFolder(await realpath(article), candidates), await realpath(root));
    assert.doesNotMatch(parser.renderer.render(blocked, parser.options, {}), /Nested content after consent/);
    const allowed = await resolveIncludes(source, article, root);
    assert.match(parser.renderer.render(allowed, parser.options, {}), /Nested content after consent/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent include prompts are deduplicated and declined folders are not repeatedly requested', async () => {
  const prompts = new IncludeAccessPrompts();
  const root = path.join(os.tmpdir(), 'lekh-project');
  let answer!: (allowed: boolean) => void;
  const pending = new Promise<boolean>(resolve => { answer = resolve; });
  let questions = 0;
  const first = prompts.request('document', root, () => { questions++; return pending; });
  const second = prompts.request('document', root, async () => { questions++; return true; });
  assert.equal(questions, 1);
  answer(false);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(await prompts.request('document', path.join(root, 'nested'), async () => { questions++; return true; }), false);
  assert.equal(questions, 1);
  assert.equal(await prompts.request('other-document', root, async () => { questions++; return true; }), true);
  assert.equal(questions, 2);
  prompts.forget('document');
  assert.equal(await prompts.request('document', root, async () => { questions++; return true; }), true);
  assert.equal(questions, 3);
  prompts.deny('revoked', root);
  assert.equal(await prompts.request('revoked', root, async () => { questions++; return true; }), false);
  assert.equal(questions, 3);
});

test('closed documents and failed prompts do not poison a later permission request', async () => {
  const prompts = new IncludeAccessPrompts();
  const root = path.join(os.tmpdir(), 'lekh-project');
  let answer!: (allowed: boolean) => void;
  const pending = new Promise<boolean>(resolve => { answer = resolve; });
  const stale = prompts.request('document', root, () => pending);
  prompts.forget('document');
  assert.equal(await prompts.request('document', root, async () => true), true);
  answer(false);
  assert.equal(await stale, false);
  await assert.rejects(prompts.request('document', root, async () => { throw new Error('dialog failed'); }), /dialog failed/);
  assert.equal(await prompts.request('document', root, async () => true), true);
});

test('includes resolve relative to the real document when opened through a directory link', async t => {
  const { root, article, includes } = await fixture();
  const links = await mkdtemp(path.join(os.tmpdir(), 'lekh-includes-links-'));
  try {
    const linkedRoot = path.join(links, 'project');
    try { await symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('This account cannot create directory links.');
        return;
      }
      throw error;
    }

    await writeFile(path.join(path.dirname(article), 'local.md'), 'Local linked content.');
    await writeFile(path.join(includes, 'shared.md'), '[!INCLUDE [Nested](nested.md)]\n');
    await writeFile(path.join(includes, 'nested.md'), 'Nested linked content.');
    const linkedArticle = path.join(linkedRoot, 'articles', 'article.md');
    const local = await resolveIncludes('[!INCLUDE [Local](local.md)]\n', linkedArticle);
    assert.match(parser.renderer.render(local, parser.options, {}), /Local linked content/);
    const shared = await resolveIncludes('[!INCLUDE [Shared](../includes/shared.md)]\n', linkedArticle, linkedRoot);
    assert.match(parser.renderer.render(shared, parser.options, {}), /Nested linked content/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(links, { recursive: true, force: true });
  }
});

test('include decoding and file size errors are reported explicitly', async () => {
  const { root, article, includes } = await fixture();
  try {
    await writeFile(path.join(includes, 'invalid.md'), Buffer.from([0xff, 0xfe, 0xff]));
    await assert.rejects(resolveIncludes('[!INCLUDE [Invalid](../includes/invalid.md)]\n', article, root), /not valid UTF-8/);
    await writeFile(path.join(includes, 'large.md'), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61));
    await assert.rejects(resolveIncludes('[!INCLUDE [Large](../includes/large.md)]\n', article, root), /under 10 MB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('directory junctions cannot escape the allowed include folder', async t => {
  const { root, article, includes } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lekh-includes-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.md'), 'Private');
    try { await symlink(outside, path.join(includes, 'outside'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('This account cannot create directory links.');
        return;
      }
      throw error;
    }
    await assert.rejects(resolveIncludes('[!INCLUDE [Escape](../includes/outside/secret.md)]\n', article, root), /outside the allowed folder/);
    const suggestions: string[] = [];
    const blocked = await resolveIncludes('[!INCLUDE [Escape](../includes/outside/secret.md)]\n', article, root, {
      displayErrors: true,
      onAccessRequired: (_document, candidate) => suggestions.push(candidate),
    });
    const html = parser.renderer.render(blocked, parser.options, {});
    assert.deepEqual(suggestions, []);
    assert.match(html, /symlink or junction escape/);
    assert.match(html, /Choose project folder/);
    assert.doesNotMatch(html, /Private/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('missing files, invalid metadata, cycles and depth or count limits are explicit', async () => {
  const { root, article, includes } = await fixture();
  try {
    await assert.rejects(resolveIncludes('[!INCLUDE [Missing](missing.md)]\n', article, root), /not found/);
    const display = await resolveIncludes('[!INCLUDE [Missing](missing.md)]\n', article, root, { displayErrors: true });
    assert.match(parser.renderer.render(display, parser.options, {}), /Could not load include.*not found/);
    assert.doesNotMatch(parser.renderer.render(display, parser.options, {}), /Choose project folder/);
    await writeFile(path.join(includes, 'invalid.md'), '---\ntitle: Secret metadata\nNo closing delimiter\n');
    await assert.rejects(resolveIncludes('[!INCLUDE [Invalid](../includes/invalid.md)]\n', article, root), /Close the document metadata/);
    await writeFile(path.join(includes, 'cycle.md'), '[!INCLUDE [Again](cycle.md)]\n');
    await assert.rejects(resolveIncludes('[!INCLUDE [Cycle](../includes/cycle.md)]\n', article, root), /cycle detected/i);
    await writeFile(path.join(includes, 'empty.md'), 'Content');
    const many = Array.from({ length: 129 }, () => '[!INCLUDE [Repeat](../includes/empty.md)]').join('\n\n');
    await assert.rejects(resolveIncludes(many, article, root), /at most 128 includes/);
    for (let n = 0; n < 13; n++) await writeFile(path.join(includes, `${n}.md`), `[!INCLUDE [Next](${n + 1}.md)]\n`);
    await assert.rejects(resolveIncludes('[!INCLUDE [Deep](../includes/0.md)]\n', article, root), /nested more than 12/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('include symlinks cannot escape the allowed folder or disguise other file types', async t => {
  const { root, article, includes } = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lekh-includes-outside-'));
  try {
    await writeFile(path.join(outside, 'secret.md'), 'Private');
    await writeFile(path.join(includes, 'secret.txt'), 'Private');
    try {
      await symlink(path.join(outside, 'secret.md'), path.join(includes, 'outside.md'), 'file');
      await symlink(path.join(includes, 'secret.txt'), path.join(includes, 'disguised.md'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('This Windows account cannot create file symlinks.');
        return;
      }
      throw error;
    }
    await assert.rejects(resolveIncludes('[!INCLUDE [Escape](../includes/outside.md)]\n', article, root), /outside the allowed folder/);
    await assert.rejects(resolveIncludes('[!INCLUDE [Wrong type](../includes/disguised.md)]\n', article, root), /resolve to a Markdown file/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
