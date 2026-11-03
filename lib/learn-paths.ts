import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { MAX_LEARN_PATHS, type LearnPathStatus } from './learn-checks.js';

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Reports whether relative references exist without reading files or probing outside
 * the document folder and the folders the user already allowed for this document.
 */
export async function learnPathStatuses(sources: unknown, documentPath: string | null, authorizedRoots: readonly string[]): Promise<LearnPathStatus[]> {
  if (!Array.isArray(sources) || sources.length > MAX_LEARN_PATHS || sources.some(source => typeof source !== 'string' || source.length > 4096)) {
    throw new Error('Invalid path check request.');
  }
  const directory = documentPath ? await realpath(path.dirname(documentPath)) : null;
  const roots = directory ? [directory, ...await Promise.all(authorizedRoots.map(async root => {
    try { return await realpath(root); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }))]
    .filter((root): root is string => Boolean(root)) : [];
  return Promise.all((sources as string[]).map(async (source): Promise<LearnPathStatus> => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source) || path.isAbsolute(source)) return 'external';
    if (!directory) return 'unsaved';
    let decoded: string;
    try { decoded = decodeURIComponent(source.replace(/[?#].*$/, '')); }
    catch { return 'invalid'; }
    if (!decoded || decoded.includes('\0')) return 'invalid';
    if (/^[a-z][a-z\d+.-]*:/i.test(decoded) || path.isAbsolute(decoded)) return 'external';
    const target = path.resolve(directory, decoded);
    if (!roots.some(root => inside(root, target))) return 'needs-access';
    try {
      const resolved = await realpath(target);
      if (!roots.some(root => inside(root, resolved))) return 'needs-access';
      return (await stat(resolved)).isFile() ? 'found' : 'missing';
    } catch (error) {
      if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code))) return 'missing';
      throw new Error(`Could not check local path "${source}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}
