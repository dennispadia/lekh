import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    try { await unlink(temporary); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not remove temporary file:', cleanupError);
    }
    throw error;
  }
}

export function exportWriteError(file: string, error: unknown): Error {
  if (!(error instanceof Error)) return new Error(String(error));
  if (!('code' in error) || !['EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(String(error.code))) return error;
  const name = path.basename(file);
  if ('syscall' in error && error.syscall === 'rename') {
    const application = path.extname(file).toLowerCase() === '.docx' ? 'Word or another app' : 'another app';
    return new Error(
      `Could not replace "${name}". The destination may be open or locked by ${application}. ` +
      'Close the file and export again, or choose a different filename. ' +
      'If it is already closed, check write permissions and file-sync restrictions.',
      { cause: error },
    );
  }
  return new Error(
    `Could not export "${name}". Check that the selected folder allows writing, or choose another folder. ` +
    'File-sync restrictions or read-only access may also prevent saving.',
    { cause: error },
  );
}

export async function atomicWriteIfUnchanged(file: string, expected: string, data: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    if (await readFile(file, 'utf8') !== expected) throw new Error('The file changed before the update could be applied.');
    await rename(temporary, file);
  } catch (error) {
    try { await unlink(temporary); }
    catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Could not remove temporary file:', cleanupError);
    }
    throw error;
  }
}

export async function readMarkdown(file: string): Promise<string> {
  return decodeMarkdown(await readFile(file));
}

export function decodeMarkdown(data: Uint8Array): string {
  if (data.length > 10 * 1024 * 1024) throw new Error('This file exceeds the 10 MB editing limit.');
  if (data.includes(0)) throw new Error('This does not appear to be a UTF-8 text file. Please convert it to UTF-8 first.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
  catch { throw new Error('This file is not valid UTF-8. Please convert it to UTF-8 before opening it.'); }
}
