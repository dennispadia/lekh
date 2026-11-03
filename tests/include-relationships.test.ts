import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { includeReferences } from '../lib/include-relationships.js';
import { relationshipReport, scanRepository, validateWorkspace, withinWorkspace } from '../lib/repository-index.js';

const include = (source: string) => `[!INCLUDE [Shared content](${source})]`;
async function fixture(run: (root: string, file: (name: string, content: string) => Promise<string>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-relationships-'));
  const file = async (name: string, content: string) => {
    const target = path.join(root, ...name.split('/')); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return target;
  };
  try { await run(root, file); } finally { await rm(root, { recursive: true, force: true }); }
}

test('relationship extraction excludes code, comments, and metadata and keeps nested source lines', () => {
  const source = ['---', 'title: Sample', include('metadata.md'), '---', '# Example',
    '```md', include('fenced.md'), '```', '<!--', include('comment.md'), '-->', '',
    '    '+include('code.md'), '', '`'+include('inline.md')+'`', '', '> '+include('quoted.md'),
    '', '1. Step', '', '   '+include('nested.md'), '', include('space%20name.md')].join('\r\n');
  assert.deepEqual(includeReferences(source), [
    { source: 'quoted.md', label: 'Shared content', line: 17 },
    { source: 'nested.md', label: 'Shared content', line: 21 },
    { source: 'space%20name.md', label: 'Shared content', line: 23 },
  ]);
});

test('arbitrary repository layouts group direct references, follow indirect consumers, and stop cycles', async () => {
  await fixture(async (root, file) => {
    const target = await file('shared bits/common.md', '# Shared');
    const aContent = '# Article\n\n'+include('../shared%20bits/common.md')+'\n\n'+include('../shared%20bits/common.md');
    const a = await file('guides/a.markdown', aContent);
    await file('elsewhere/b.mdown', include('../guides/a.markdown'));
    await file('notes/c.md', include('../elsewhere/b.mdown'));
    await file('loop.md', include('loop.md'));
    await file('node_modules/ignored.md', include('../shared%20bits/common.md'));
    await file('.git/ignored.md', include('../shared%20bits/common.md'));
    assert.equal(await validateWorkspace(root, a), root);
    const before = await readFile(a);
    const index = await scanRepository(root);
    const report = await relationshipReport(index, target, '# Shared', null);
    assert.deepEqual(report.direct.map(entry => [entry.file, entry.lines]), [['guides/a.markdown', [3, 5]]]);
    assert.deepEqual(report.indirect.map(entry => entry.file), ['elsewhere/b.mdown', 'notes/c.md']);
    assert.deepEqual(report.indirect[1].chain, ['notes/c.md', 'elsewhere/b.mdown', 'guides/a.markdown', 'shared bits/common.md']);
    assert.equal(index.files.size, 5);
    assert.equal(report.incomplete, false);
    assert.equal(report.includes.length, 0);
    const articleReport = await relationshipReport(index, a, aContent, '../shared%20bits/common.md');
    assert.equal(articleReport.includes.length, 1);
    assert.deepEqual(articleReport.includes[0].lines, [3, 5]);
    assert.equal(articleReport.target, 'shared bits/common.md');
    assert.deepEqual(await readFile(a), before);
  });
});

test('current unsaved content overlays the disk index without writing to files', async () => {
  await fixture(async (root, file) => {
    await file('shared.md', 'Shared');
    const article = await file('article.md', '# Original');
    const index = await scanRepository(root);
    const report = await relationshipReport(index, article, include('shared.md'), 'shared.md');
    assert.equal(report.direct[0].file, 'article.md');
    assert.equal((await readFile(article, 'utf8')), '# Original');
    await assert.rejects(relationshipReport(index, article, '# Removed', 'shared.md'), /no longer/);
  });
});

test('unsupported, missing and out-of-scope paths are explicit and cannot be selected as local targets', async () => {
  await fixture(async (root, file) => {
    const content = [include('missing.md'), include('https://example.test/remote.md'), include('../outside.md'), include('bad%ZZ.md'), include('/site/root.md')].join('\n\n');
    const article = await file('article.md', content);
    const index = await scanRepository(root);
    const report = await relationshipReport(index, article, content, null);
    assert.deepEqual(report.includes.map(entry => entry.status), ['missing', 'unsupported', 'outside', 'unsupported', 'unsupported']);
    assert.equal(report.incomplete, true);
    await assert.rejects(relationshipReport(index, article, content, '../outside.md'), /outside/);
    await assert.rejects(relationshipReport(index, article, content, 'https://example.test/remote.md'), /unsupported/);
    const missing = await relationshipReport(index, article, content, 'missing.md');
    assert.equal(missing.direct[0].file, 'article.md');
    assert.equal(withinWorkspace(root, root+'-sibling'), false);
    await assert.rejects(validateWorkspace(path.parse(root).root, article), /entire drive/);
  });
});

test('scan and result bounds report incomplete results rather than success-shaped empty results', async () => {
  await fixture(async (root, file) => {
    const article = await file('article.md', include('shared.md'));
    await file('shared.md', 'Shared');
    const index = await scanRepository(root, { limits: { files: 1 } });
    assert.equal(index.incomplete, true);
    assert.match(index.warnings.join(' '), /limit/);
    const oversized = await scanRepository(root, { limits: { fileBytes: 2 } });
    assert.equal(oversized.incomplete, true);
    assert.match(oversized.warnings.join(' '), /oversized/);
    const report = await relationshipReport(oversized, article, include('shared.md'), null);
    assert.equal(report.incomplete, true);
    let checks = 0;
    await assert.rejects(scanRepository(root, { assertAccess: () => { if (++checks > 2) throw new Error('Access revoked'); } }), /Access revoked/);
  });
});

test('symlink escapes are not scanned or resolved to consumers', async t => {
  await fixture(async (root, file) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'lekh-relationship-outside-'));
    try {
      await writeFile(path.join(outside, 'private.md'), 'Outside');
      try { await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
      catch (error) {
        if (error instanceof Error && 'code' in error && ['EPERM', 'EACCES'].includes(String(error.code))) { t.skip('Symlink privilege unavailable'); return; }
        throw error;
      }
      const content = include('linked/private.md'), article = await file('article.md', content);
      const index = await scanRepository(root);
      assert.equal(index.files.size, 1);
      const report = await relationshipReport(index, article, content, null);
      assert.equal(report.includes[0].status, 'outside');
      assert.equal(report.incomplete, true);
      await assert.rejects(validateWorkspace(outside, article), /containing/);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

});

test('cyclic consumers appear once and line links are bounded without losing reference counts', async () => {
  await fixture(async (root, file) => {
    const target = await file('shared.md', include('article.md'));
    await file('article.md', Array.from({ length: 65 }, () => include('shared.md')).join('\n\n'));
    await file('indirect.md', include('article.md'));
    const report = await relationshipReport(await scanRepository(root), target, include('article.md'), null);
    assert.equal(report.direct.length, 1);
    assert.equal(report.indirect.length, 1);
    assert.equal(report.direct[0].referenceCount, 65);
    assert.equal(report.direct[0].lines.length, 50);
    assert.equal(report.incomplete, true);
    assert.match(report.warnings.join(' '), /line links are limited/);
  });
});

test('concurrent file reads share the byte budget instead of each consuming it independently', async () => {
  await fixture(async (root, file) => {
    for (let index = 0; index < 8; index++) await file(`${index}.md`, '1234567890');
    const index = await scanRepository(root, { limits: { bytes: 15 } });
    assert.equal(index.files.size, 1);
    assert.equal(index.incomplete, true);
    assert.match(index.warnings.join(' '), /oversized|limit/);
  });
});
