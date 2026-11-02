import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const mimeTypes: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};
export type ImageStorage = 'embedded' | 'assets';
export type AuthorizedImageRoots = string | readonly string[] | null;

export function embeddedImage(source: unknown): { data: Buffer; mime: string } {
  if (typeof source !== 'string') throw new Error('Choose a supported embedded image.');
  if (source.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128) throw new Error('Image exceeds the 20 MB limit.');
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(source);
  if (!match) throw new Error('Choose an embedded PNG, JPEG, GIF, or WebP image.');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.toString('base64') !== match[2]) throw new Error('The image data is malformed.');
  if (data.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MB limit.');
  const mime = match[1].toLowerCase();
  const valid = mime === 'image/png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : mime === 'image/jpeg' ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    : mime === 'image/gif' ? /^(GIF87a|GIF89a)$/.test(data.subarray(0, 6).toString('ascii'))
    : data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!valid) throw new Error('The image data does not match its PNG, JPEG, GIF, or WebP format.');
  return { data, mime };
}

export async function storeImage(
  source: unknown, documentPath: string | null, storage: unknown,
  validateRaster: (data: Buffer, mime: string) => void | Promise<void>,
): Promise<string> {
  if (storage !== 'embedded' && storage !== 'assets') throw new Error('Choose embedded or assets image storage.');
  if (storage === 'assets' && !documentPath) throw new Error('Save the Markdown file before storing images in its assets folder.');
  const { data, mime } = embeddedImage(source);
  await validateRaster(data, mime);
  if (storage === 'embedded') return source as string;
  const root = await realpath(path.dirname(documentPath!));
  const directory = path.join(root, 'assets');
  try { await mkdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const assertDirectory = async () => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new Error('The assets folder is unsafe. Choose a regular assets folder inside the Markdown file’s folder.');
    }
  };
  await assertDirectory();
  const extension = mime === 'image/jpeg' ? 'jpg' : mime.slice('image/'.length);
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = `image-${randomUUID()}.${extension}`;
    await assertDirectory();
    let file;
    try { file = await open(path.join(directory, name), 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      // Recheck after opening, before writing image bytes, in case the folder changed.
      await assertDirectory();
      await file.writeFile(data);
    } finally { await file.close(); }
    return `assets/${name}`;
  }
  throw new Error('Could not create a unique image asset. Try again.');
}

export async function readImage(source: string, documentPath: string | null, authorizedRoot?: AuthorizedImageRoots): Promise<{ data: Buffer; mime: string }> {
  const embedded = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(source);
  if (embedded) {
    if (embedded[2].length > MAX_IMAGE_BYTES * 1.4) throw new Error('Image exceeds the 20 MB limit.');
    return { data: Buffer.from(embedded[2], 'base64'), mime: embedded[1].toLowerCase() };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(source) || path.isAbsolute(source)) {
    throw new Error('Only embedded images and relative local images are supported. Insert an image from the toolbar to embed it.');
  }
  if (!documentPath) throw new Error('Save the Markdown file before using relative image paths.');
  const directory = await realpath(path.dirname(documentPath));
  const projectRoots = typeof authorizedRoot === 'string' ? [authorizedRoot] : authorizedRoot ?? [];
  const roots = [directory, ...await Promise.all(projectRoots.map(root => realpath(root)))];
  const outside = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  };
  if (projectRoots.length) {
    const document = await realpath(documentPath);
    if (roots.slice(1).some(root => outside(root, document))) throw new Error('The saved document is outside the authorized project folder.');
  }
  const decoded = decodeURIComponent(source);
  if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || path.isAbsolute(decoded)) throw new Error('Image paths must be relative to the document.');
  const file = await realpath(path.resolve(directory, decoded));
  if (roots.every(root => outside(root, file))) {
    throw new Error(projectRoots.length ? 'Images must be inside an authorized project folder.' : 'Images must be inside the Markdown file\'s folder. Use Insert image to embed an image from another folder.');
  }
  const mime = mimeTypes[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('Supported image formats are PNG, JPEG, GIF, and WebP.');
  if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MB limit.');
  const data = await readFile(file);
  if (data.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds the 20 MB limit.');
  return { data, mime };
}

export function imageMime(file: string): string {
  const mime = mimeTypes[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('Supported image formats are PNG, JPEG, GIF, and WebP.');
  return mime;
}
