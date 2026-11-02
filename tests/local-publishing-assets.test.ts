import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { addVariantMetadata, appendVariantGroupEntry, prepareVariantConfiguration, prepareVariantConfigurationFromFile, variantGroupIds } from '../lib/variant-config.js';

const include = '[!INCLUDE [Shared](shared.md)]';
const groups = `groups:
- id: operating-system
  title: Operating system
  pivots:
    - id: windows
      title: Windows
    - id: linux
      title: Linux
`;

test('variant preparation preserves include directives without a folder grant', async () => {
  const markdown = `# Article\r\n${include}\r\n`;
  assert.equal(await prepareVariantConfiguration(markdown, null, null), markdown);
  assert.equal(await prepareVariantConfiguration(markdown, 'Z:\\does-not-exist.md', null), markdown);
});

test('variant preparation does not consume includes when loading local labels', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-local-assets-'));
  try {
    const document = path.join(root, 'docs', 'article.md');
    await mkdir(path.dirname(document), { recursive: true });
    await writeFile(document, '# Article');
    await writeFile(path.join(root, 'shared.md'), 'Private shared content with tabs.');
    await writeFile(path.join(root, 'zone-pivot-groups.yml'), groups);

    const markdown = `---\nzone_pivot_groups: operating-system\n---\n\n# Article\n\n${include}\n`;
    const result = await prepareVariantConfiguration(markdown, document, root);
    assert.ok(result.includes(include));
    assert.ok(result.includes('title="Operating system"'));
    assert.ok(result.includes('Windows'));
    assert.ok(!result.includes('Private shared content'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared variant configuration appends an owned group and article metadata', () => {
  const config = `${groups}# Keep this trailing comment.\n`;
  const updated = appendVariantGroupEntry(config, {
    owner: 'sample-owner',
    id: 'database-mode',
    title: 'Database modes',
    prompt: 'Choose a database',
    pivots: [{ id: 'postgres', title: 'PostgreSQL' }, { id: 'mysql', title: 'MySQL' }],
  });
  assert.deepEqual(variantGroupIds(updated), ['operating-system', 'database-mode']);
  assert.match(updated, /# Owner: sample-owner\n- id: database-mode/);
  assert.match(updated, /prompt: "Choose a database"/);
  assert.match(updated, /- id: mysql\n\s+title: "MySQL"/);
  assert.match(addVariantMetadata('# Article\n', 'database-mode'), /^---\nzone_pivot_groups: database-mode\n---\n\n# Article/);
  assert.match(addVariantMetadata('---\ntitle: Article\n---\n\n# Article\n', 'database-mode'), /title: Article\nzone_pivot_groups: database-mode\n---/);
});

test('shared variant configuration rejects duplicate groups and unsupported files', () => {
  const group = {
    owner: 'sample-owner', id: 'operating-system', title: 'OS', prompt: 'Choose an OS',
    pivots: [{ id: 'windows', title: 'Windows' }, { id: 'linux', title: 'Linux' }],
  };
  assert.throws(() => appendVariantGroupEntry(groups, group), /already contains the group/);
  assert.throws(() => appendVariantGroupEntry('name: not a group file\n', { ...group, id: 'database-mode' }), /groups list/);
  assert.throws(() => appendVariantGroupEntry('groups:\n- { id: existing, title: Existing }\n', { ...group, id: 'database-mode' }), /unsupported group entry format/);
  assert.throws(() => addVariantMetadata('---\nzone_pivot_groups: other\n---\n', 'database-mode'), /already references/);
  assert.throws(() => addVariantMetadata('---\ntitle: Incomplete\n', 'database-mode'), /incomplete front-matter/);
});

test('shared configuration appends to empty lists without losing BOM or line endings', () => {
  const updated = appendVariantGroupEntry('\uFEFFgroups: []\r\n', {
    owner: 'sample-owner',
    id: 'database-mode',
    title: 'Database modes',
    prompt: 'Choose a database',
    pivots: [{ id: 'postgres', title: 'PostgreSQL' }, { id: 'mysql', title: 'MySQL' }],
  });
  assert.match(updated, /^\uFEFFgroups:\s*\r\n/);
  assert.ok(updated.includes('# Owner: sample-owner\r\n- id: database-mode\r\n'));
  assert.deepEqual(variantGroupIds(updated), ['database-mode']);
});

test('explicit shared files add configured choices to the prepared article', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-shared-variants-'));
  try {
    const file = path.join(root, 'shared-groups.yaml');
    await writeFile(file, groups);
    const markdown = `---\nzone_pivot_groups: operating-system\n---\n\n# Article\n`;
    const result = await prepareVariantConfigurationFromFile(markdown, file);
    assert.match(result, /:::selector title="Operating system"/);
    assert.match(result, /#variant\/windows/);
    await assert.rejects(prepareVariantConfigurationFromFile(markdown, path.join(root, 'missing.yml')), /Missing or inaccessible/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('variant preparation finds underscore-named files beside the article', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-local-assets-'));
  try {
    const articles = path.join(root, 'articles');
    const document = path.join(articles, 'guide.md');
    await mkdir(articles, { recursive: true });
    await writeFile(document, '# Article');
    await writeFile(path.join(articles, 'zone_pivot_groups.yml'), groups);
    const markdown = `---\nzone_pivot_groups: operating-system\n---\n\n# Article\n`;
    const result = await prepareVariantConfiguration(markdown, document, root);
    assert.match(result, /:::selector title="Operating system"/);
    assert.match(result, /#variant\/windows/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
