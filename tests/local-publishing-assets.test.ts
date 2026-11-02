import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareVariantConfiguration } from '../lib/variant-config.js';

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
