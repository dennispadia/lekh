import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, atomicWriteIfUnchanged, exportWriteError, readMarkdown } from '../lib/files.js';
import { readImage } from '../lib/images.js';

test('atomic writes replace content and leave no temporary files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-unit-'));
  try {
    const file = path.join(root, 'test.md');
    await atomicWrite(file, '# First');
    await atomicWrite(file, '# Second\n\nUnicode: \u4f60\u597d');
    assert.equal(await readMarkdown(file), '# Second\n\nUnicode: \u4f60\u597d');
    await atomicWrite(file, '\uFEFF# UTF-8 with BOM\r\n');
    assert.equal(await readMarkdown(file), '\uFEFF# UTF-8 with BOM\r\n');
    assert.deepEqual(await readdir(root), ['test.md']);
    await assert.rejects(() => atomicWrite(path.join(root, 'missing', 'test.md'), 'data'), /ENOENT/);
    assert.deepEqual(await readdir(root), ['test.md']);
  } finally { await rm(root, { recursive: true }); }
});

test('conditional atomic writes preserve concurrent changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-unit-'));
  try {
    const file = path.join(root, 'shared.yml');
    await writeFile(file, 'version: one\n');
    await assert.rejects(() => atomicWriteIfUnchanged(file, 'version: original\n', 'version: replaced\n'), /file changed/);
    assert.equal(await readFile(file, 'utf8'), 'version: one\n');
    assert.deepEqual(await readdir(root), ['shared.yml']);
    await atomicWriteIfUnchanged(file, 'version: one\n', 'version: two\n');
    assert.equal(await readFile(file, 'utf8'), 'version: two\n');
    assert.deepEqual(await readdir(root), ['shared.yml']);
  } finally { await rm(root, { recursive: true }); }
});

test('blocked export replacements explain possible locks and how to recover without claiming certainty', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EROFS']) {
    for (const extension of ['docx', 'pdf', 'html']) {
      const file = path.join(os.tmpdir(), `report.${extension}`);
      const original = Object.assign(new Error('raw rename error exposing a temporary path'), { code, syscall: 'rename' });
      const error = exportWriteError(file, original);
      assert.match(error.message, new RegExp(`Could not replace "report\\.${extension}"`));
      assert.match(error.message, /may be open or locked/);
      assert.match(error.message, /Close the file and export again/);
      assert.match(error.message, /different filename/);
      assert.match(error.message, /write permissions and file-sync restrictions/);
      assert.doesNotMatch(error.message, /raw rename error|temporary path/);
      if (extension === 'docx') assert.match(error.message, /Word/);
      assert.equal(error.cause, original);
    }
  }
});

test('export folder failures give folder guidance and unrelated errors keep their identity', () => {
  const denied = Object.assign(new Error('access denied'), { code: 'EACCES', syscall: 'open' });
  const error = exportWriteError('report.docx', denied);
  assert.match(error.message, /selected folder allows writing/);
  assert.doesNotMatch(error.message, /open or locked|Close the file/);
  assert.equal(error.cause, denied);
  for (const code of ['ENOSPC', 'ENOENT', 'EIO']) {
    const original = Object.assign(new Error(code), { code, syscall: 'rename' });
    assert.equal(exportWriteError('report.docx', original), original);
  }
  assert.equal(exportWriteError('report.docx', 'Unexpected failure').message, 'Unexpected failure');
});

test('reading refuses binary files and invalid UTF-8 rather than corrupting them', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-unit-'));
  try {
    const file = path.join(root, 'bad.md');
    await writeFile(file, Buffer.from([0, 1, 2]));
    await assert.rejects(() => readMarkdown(file), /UTF-8 text file/);
    await writeFile(file, Buffer.from([0xff, 0xfe, 0x61]));
    await assert.rejects(() => readMarkdown(file), /not valid UTF-8/);
    await writeFile(file, Buffer.alloc(10 * 1024 * 1024 + 1, 65));
    await assert.rejects(() => readMarkdown(file), /10 MB/);
  } finally { await rm(root, { recursive: true }); }
});

test('relative images stay within the document folder, including resolved paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lekh-unit-'));
  try {
    const documentFolder = path.join(root, 'docs');
    await mkdir(documentFolder);
    await writeFile(path.join(documentFolder, 'image.png'), Buffer.from('test image'));
    await writeFile(path.join(root, 'private.png'), Buffer.from('outside'));
    const doc = path.join(documentFolder, 'test.md');
    assert.equal((await readImage('image.png', doc)).mime, 'image/png');
    assert.equal((await readImage('image.png', doc)).data.toString(), 'test image');
    await assert.rejects(() => readImage('..\\private.png', doc), /inside/);
    await assert.rejects(() => readImage('%2e%2e%2fprivate.png', doc), /inside/);
    await assert.rejects(() => readImage('image.png', null), /Save the Markdown/);
    await assert.rejects(() => readImage('https://example.com/image.png', doc), /Only embedded/);
    await assert.rejects(() => readImage('file:///C:/private.png', doc), /Only embedded/);
  } finally { await rm(root, { recursive: true }); }
});
