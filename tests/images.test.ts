import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { embeddedImage, imageMime, MAX_IMAGE_BYTES, readImage, storeImage } from '../lib/images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGL5z8AAAAAA//+FDQv1AAAABklEQVQDAAMRAQSnRfifAAAAAElFTkSuQmCC', 'base64');
const source = `data:image/png;base64,${png.toString('base64')}`;
const validate = (data: Buffer) => { assert.ok(data.length > 0); };
async function fixture(run: (root: string, document: string) => Promise<void>) {
  const root = await mkdtemp(path.join(process.cwd(), '.image-tests-'));
  try {
    const directory = path.join(root, 'docs');
    await mkdir(directory);
    const document = path.join(directory, 'document.md');
    await writeFile(document, '# Images');
    await run(root, document);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('embedded storage preserves validated data URLs without requiring a saved document or writing files', async () => {
  assert.equal(await storeImage(source, null, 'embedded', validate), source);
  assert.deepEqual(embeddedImage(source), { data: png, mime: 'image/png' });
  let decoded = false;
  assert.equal(await storeImage(source, null, 'embedded', data => {
    decoded = true;
    assert.deepEqual(data, png);
  }), source);
  assert.equal(decoded, true);
});

test('assets storage requires a saved document and explicit valid storage choice', async () => {
  await assert.rejects(storeImage(source, null, 'assets', validate), /Save the Markdown file/);
  for (const storage of [null, undefined, 'relative', '../assets']) {
    await assert.rejects(storeImage(source, null, storage, validate), /Choose embedded or assets/);
  }
});

test('project image access requires an explicit grant and cannot escape its real directory boundary', async () => {
  await fixture(async (root, document) => {
    const shared = path.join(root, 'shared');
    await mkdir(shared);
    const image = path.join(shared, 'diagram.png');
    await writeFile(image, png);
    await assert.rejects(readImage('../shared/diagram.png', document), /inside the Markdown/);
    assert.deepEqual((await readImage('../shared/diagram.png', document, root)).data, png);
    await assert.rejects(readImage('../shared/diagram.png', document, path.dirname(document)), /authorized project/);
    await assert.rejects(readImage('diagram.png', document, shared), /document is outside/);
    await assert.rejects(readImage(encodeURIComponent(image), document, root), /relative/);
    await assert.rejects(readImage(encodeURIComponent('https://example.com/image.png'), document, root), /relative/);
    await assert.rejects(readImage('../shared/diagram.png', document), /inside the Markdown/, 'Revoking the grant restores the original boundary');
  });
});

test('assets are relative safe URLs with unique names, exact bytes and no overwritten files', async () => {
  await fixture(async (_root, document) => {
    const directory = path.join(path.dirname(document), 'assets');
    await mkdir(directory);
    const previous = path.join(directory, 'image-existing.png');
    await writeFile(previous, 'keep');
    const urls = await Promise.all(Array.from({ length: 12 }, () => storeImage(source, document, 'assets', validate)));
    assert.equal(new Set(urls).size, urls.length);
    for (const url of urls) {
      assert.match(url, /^assets\/image-[a-f0-9-]+\.png$/);
      assert.deepEqual(await readFile(path.resolve(path.dirname(document), url)), png);
      assert.deepEqual((await readImage(url, document)).data, png);
    }
    assert.equal(await readFile(previous, 'utf8'), 'keep');
    assert.equal((await readdir(directory)).length, 13);
    assert.equal(await readFile(document, 'utf8'), '# Images');
  });
});

test('raster validation rejects malformed, mismatched, non-raster, oversized and external sources', async () => {
  for (const input of [
    null, {}, 42, '', 'assets/image.png', '../image.png', 'C:\\private.png',
    'https://example.com/image.png', 'file:///C:/image.png',
    'data:image/svg+xml;base64,PHN2Zy8+', 'data:text/html;base64,AAAA',
    'data:image/png;base64,AAAA', 'data:image/png;base64,not base64!',
    'data:image/png;base64,a===', 'data:image/png;base64,AAAA=',
    source.replace('image/png', 'image/jpeg'),
    `data:image/png;base64,${Buffer.from('<svg></svg>').toString('base64')}`,
    `data:image/png;base64,${png.toString('base64').slice(0, -1)}`,
  ]) {
    await assert.rejects(storeImage(input, null, 'embedded', validate), /image|PNG|data/i);
  }
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  png.copy(oversized);
  await assert.rejects(storeImage(`data:image/png;base64,${oversized.toString('base64')}`, null, 'embedded', validate), /20 MB/);
});

test('native decoder rejection happens before any filesystem mutation', async () => {
  await fixture(async (_root, document) => {
    await assert.rejects(storeImage(source, document, 'assets', () => { throw new Error('Invalid raster'); }), /Invalid raster/);
    await assert.rejects(storeImage(source, document, 'assets', async () => { throw new Error('Invalid async raster'); }), /Invalid async raster/);
    assert.deepEqual(await readdir(path.dirname(document)), ['document.md']);
  });
});

test('raster signatures select only supported formats and matching safe extensions', async () => {
  await fixture(async (_root, document) => {
    for (const [mime, bytes, extension] of [
      ['image/jpeg', Buffer.from('ffd8ffe000', 'hex'), 'jpg'],
      ['image/gif', Buffer.from('GIF89a'), 'gif'],
      ['image/webp', Buffer.from('RIFF0000WEBP'), 'webp'],
    ] as const) {
      const url = await storeImage(`data:${mime};base64,${bytes.toString('base64')}`, document, 'assets', validate);
      assert.ok(url.endsWith(`.${extension}`));
      assert.deepEqual(await readFile(path.resolve(path.dirname(document), url)), bytes);
    }
  });
});

test('assets directory refuses files and directory symlinks/junctions, even inside the root', async () => {
  await fixture(async (root, document) => {
    const directory = path.join(path.dirname(document), 'assets');
    await writeFile(directory, 'not a directory');
    await assert.rejects(storeImage(source, document, 'assets', validate), /unsafe/);
    assert.equal(await readFile(directory, 'utf8'), 'not a directory');
    await rm(directory);
    for (const target of [path.join(root, 'outside'), path.join(path.dirname(document), 'inside')]) {
      await mkdir(target);
      await symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
      try {
        await assert.rejects(storeImage(source, document, 'assets', validate), /unsafe/);
        assert.deepEqual(await readdir(target), []);
      } finally { await rm(directory); }
    }
  });
});

test('existing image reads keep embedded and bounded relative paths, including symlink escape protection', async () => {
  await fixture(async (root, document) => {
    assert.deepEqual(await readImage(source, null), { data: png, mime: 'image/png' });
    const local = path.join(path.dirname(document), 'local image.png');
    await writeFile(local, png);
    assert.deepEqual((await readImage('local%20image.png', document)).data, png);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.png'), png);
    const linked = path.join(path.dirname(document), 'linked');
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    for (const url of ['../outside/secret.png', '%2e%2e%2foutside%2fsecret.png', 'linked/secret.png']) {
      await assert.rejects(readImage(url, document), /inside/);
    }
    await assert.rejects(readImage('local%20image.png', null), /Save the Markdown/);
    for (const url of ['https://example.com/image.png', 'file:///C:/private.png', local]) {
      await assert.rejects(readImage(url, document), /Only embedded/);
    }
    assert.equal(imageMime('photo.JPEG'), 'image/jpeg');
    assert.throws(() => imageMime('image.svg'), /Supported image formats/);
  });
});

test('file symlinks cannot expose non-Markdown or HTML image files', async t => {
  await fixture(async (_root, document) => {
    const directory = path.dirname(document);
    const html = path.join(directory, 'private.html');
    await writeFile(html, '<html>private</html>');
    try {
      await symlink(html, path.join(directory, 'fake.png'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        t.skip('The filesystem does not permit file symlinks.');
        return;
      }
      throw error;
    }
    await assert.rejects(readImage('fake.png', document), /Supported image formats/);
  });
});
