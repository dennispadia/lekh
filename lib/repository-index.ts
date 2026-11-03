import { open, opendir, realpath, stat } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import path from 'node:path';
import { decodeMarkdown } from './files.js';
import { includeReferences, type IncludeReference, type RelationshipConsumer, type RelationshipInclude, type RelationshipReport } from './include-relationships.js';

const markdownFile = /\.(?:md|markdown|mdown)$/i;
const excludedDirectories = new Set(['.git', '.hg', '.svn', 'node_modules']);
const defaults = { files: 50000, entries: 150000, bytes: 400 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, references: 200000, milliseconds: 300000 };
type Limits = typeof defaults;
interface Edge extends IncludeReference { target: string | null; status: RelationshipInclude['status'] }
type Resolution = Pick<Edge, 'target' | 'status'>;
interface IndexedFile { file: string; edges: Edge[] }
export interface RepositoryIndex {
  root: string;
  files: Map<string, IndexedFile>;
  scannedAt: string;
  warnings: string[];
  incomplete: boolean;
}
const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
export function withinWorkspace(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const display = (root: string, file: string) => path.relative(root, file).split(path.sep).join('/');
const missing = (error: unknown) => error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));

export async function validateWorkspace(root: string, document: string): Promise<string> {
  const resolved = await realpath(root);
  if (resolved === path.parse(resolved).root || !(await stat(resolved)).isDirectory()) throw new Error('Choose a documentation folder, not an entire drive.');
  if (!withinWorkspace(resolved, await realpath(document))) throw new Error('Choose a workspace folder containing the saved document.');
  return resolved;
}

async function edgesFor(markdown: string, file: string, root: string, check: () => void, cache?: Map<string, Promise<Resolution>>): Promise<Edge[]> {
  const edges: Edge[] = [];
  for (const reference of includeReferences(markdown)) {
    check();
    let source: string;
    try { source = decodeURIComponent(reference.source); }
    catch { edges.push({ ...reference, target: null, status: 'unsupported' }); continue; }
    if (!source || /[\0?#]/.test(source) || path.isAbsolute(source) || /^[a-z][a-z\d+.-]*:|^[/\\]/i.test(source) || !markdownFile.test(source)) {
      edges.push({ ...reference, target: null, status: 'unsupported' }); continue;
    }
    const candidate = path.resolve(path.dirname(file), source);
    if (!withinWorkspace(root, candidate)) { edges.push({ ...reference, target: null, status: 'outside' }); continue; }
    let resolution = cache?.get(key(candidate));
    if (!resolution) {
      resolution = (async (): Promise<Resolution> => {
        try {
          const target = await realpath(candidate);
          if (!withinWorkspace(root, target)) return { target: null, status: 'outside' };
          return { target, status: (await stat(target)).isFile() ? 'found' : 'missing' };
        } catch (error) {
          if (!missing(error)) throw new Error(`Could not resolve include in ${display(root, file)} at line ${reference.line}: ${String(error)}`);
          return { target: candidate, status: 'missing' };
        }
      })();
      cache?.set(key(candidate), resolution);
    }
    edges.push({ ...reference, ...await resolution });
  }
  return edges;
}

/** Reads only an explicitly approved local tree; never follows directory symlinks. */
export async function scanRepository(root: string, options: { limits?: Partial<Limits>; assertAccess?: () => void } = {}): Promise<RepositoryIndex> {
  root = await realpath(root);
  const limits = { ...defaults, ...options.limits };
  const index: RepositoryIndex = { root, files: new Map(), scannedAt: '', warnings: [], incomplete: false };
  const start = Date.now();
  const resolutions = new Map<string, Promise<Resolution>>();
  let bytes = 0, entries = 0, references = 0, scheduled = 0;
  const warn = (message: string) => {
    index.incomplete = true;
    if (index.warnings.length < 20) index.warnings.push(message);
    else if (index.warnings.length === 20) index.warnings.push('Additional scan warnings were omitted.');
  };
  const check = () => { options.assertAccess?.(); };
  let stopped = false;
  async function indexFile(file: string): Promise<void> {
    check();
    if (stopped) return;
    try {
      const resolvedFile = await realpath(file);
      if (!withinWorkspace(root, resolvedFile) || key(resolvedFile) !== key(file)) { warn(`Skipped changed or linked file: ${display(root, file)}`); return; }
      const input = await open(file, 'r');
      let markdown: string;
      try {
        const info = await input.stat();
        if (!info.isFile() || info.size > limits.fileBytes || bytes + info.size > limits.bytes) { warn(`Skipped oversized file: ${display(root, file)}`); return; }
        // Reserve the byte budget before concurrent reads can claim the same space.
        bytes += info.size;
        const confirmed = await realpath(file);
        const current = await stat(confirmed);
        if (!withinWorkspace(root, confirmed) || key(confirmed) !== key(file) || info.ino !== current.ino || info.dev !== current.dev) throw new Error('File changed during scan.');
        check();
        const buffer = Buffer.alloc(info.size + 1);
        let size = 0;
        while (size < buffer.length) {
          const { bytesRead } = await input.read(buffer, size, buffer.length - size, null);
          if (!bytesRead) break;
          size += bytesRead;
        }
        const after = await input.stat();
        const finalPath = await realpath(file);
        if (key(finalPath) !== key(file) || size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('File changed during scan. Refresh to try again.');
        markdown = decodeMarkdown(buffer.subarray(0, size));
      } finally { await input.close(); }
      const edges = await edgesFor(markdown, file, root, check, resolutions);
      if (references + edges.length > limits.references) { warn('Include reference limit reached. Choose a smaller workspace.'); stopped = true; return; }
      references += edges.length;
      index.files.set(key(file), { file, edges });
    } catch (error) {
      check();
      warn(`Could not index ${display(root, file)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  async function visit(directory: string, depth: number): Promise<void> {
    check();
    if (depth > 64) { warn(`Directory nesting limit reached: ${display(root, directory)}`); return; }
    try {
      const resolved = await realpath(directory);
      if (!withinWorkspace(root, resolved) || key(resolved) !== key(directory)) { warn(`Skipped changed or linked directory: ${display(root, directory)}`); return; }
      const handle = await opendir(directory);
      const batch: string[] = [];
      const flush = async () => {
        const files = batch.splice(0);
        await Promise.all(files.map(indexFile));
        await setImmediate();
      };
      for await (const entry of handle) {
        check();
        if (++entries > limits.entries || scheduled >= limits.files || bytes >= limits.bytes || references >= limits.references || Date.now() - start > limits.milliseconds) {
          await flush();
          warn('Scan limit reached. Choose a smaller workspace folder or refresh to try again.'); stopped = true; break;
        }
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { warn(`Skipped symbolic link: ${display(root, file)}`); continue; }
        if (entry.isDirectory()) {
          await flush();
          if (!excludedDirectories.has(entry.name.toLowerCase())) await visit(file, depth + 1);
          if (stopped) break;
          continue;
        }
        if (!entry.isFile() || !markdownFile.test(entry.name)) continue;
        batch.push(file); scheduled++;
        if (batch.length >= 8) await flush();
        if (stopped) break;
      }
      await flush();
    } catch (error) {
      check();
      if (directory === root) throw error;
      warn(`Could not scan ${display(root, directory)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await visit(root, 0);
  check();
  index.scannedAt = new Date().toISOString();
  return index;
}

export async function relationshipReport(
  index: RepositoryIndex, document: string, markdown: string, source: string | null,
  assertAccess: () => void = () => {},
): Promise<RelationshipReport> {
  assertAccess();
  document = await realpath(document);
  if (!withinWorkspace(index.root, document)) throw new Error('This document is outside the approved workspace.');
  const currentEdges = await edgesFor(markdown, document, index.root, assertAccess);
  const selected = source === null ? null : currentEdges.find(edge => edge.source === source);
  if (source !== null && !selected) throw new Error('That include is no longer in this document.');
  if (selected && !selected.target) throw new Error(selected.status === 'outside'
    ? 'This include is outside the approved workspace. Choose a containing folder.'
    : 'This include path is unsupported. Only local relative Markdown include paths are indexed.');
  const target = selected?.target ?? document;
  const report: RelationshipReport = {
    root: index.root, document: display(index.root, document), target: display(index.root, target), includes: [],
    direct: [], indirect: [], files: index.files.size, scannedAt: index.scannedAt, warnings: [...index.warnings], incomplete: index.incomplete,
  };
  const includes = new Map<string, RelationshipInclude>();
  for (const edge of currentEdges) {
    const identity = edge.target ? key(edge.target) : edge.source;
    const previous = includes.get(identity);
    if (previous) previous.lines.push(edge.line);
    else includes.set(identity, { source: edge.source, label: edge.label, line: edge.line, lines: [edge.line], file: edge.target ? display(index.root, edge.target) : null, status: edge.status });
  }
  report.includes = [...includes.values()].slice(0, 500);
  if (includes.size > 500) { report.incomplete = true; report.warnings.push('Only the first 500 includes are shown.'); }
  const reverse = new Map<string, Map<string, { file: string; lines: number[] }>>();
  for (const entry of [...index.files.values()].filter(entry => key(entry.file) !== key(document)).concat({ file: document, edges: currentEdges })) {
    for (const edge of entry.edges) {
      if (!edge.target) continue;
      const consumers = reverse.get(key(edge.target)) ?? new Map();
      const previous = consumers.get(key(entry.file));
      if (previous) previous.lines.push(edge.line);
      else consumers.set(key(entry.file), { file: entry.file, lines: [edge.line] });
      reverse.set(key(edge.target), consumers);
    }
  }
  const visited = new Set([key(target)]);
  const queue = [{ file: target, chain: [display(index.root, target)] }];
  let lineButtons = 0;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const next = queue[cursor];
    for (const consumer of reverse.get(key(next.file))?.values() ?? []) {
      if (visited.has(key(consumer.file))) continue;
      visited.add(key(consumer.file));
      const chain = [display(index.root, consumer.file), ...next.chain];
      const allLines = [...new Set(consumer.lines)].sort((a, b) => a - b);
      const result: RelationshipConsumer = { file: chain[0], lines: allLines.slice(0, Math.min(50, Math.max(0, 1000 - lineButtons))), referenceCount: allLines.length, chain };
      if (report.direct.length + report.indirect.length >= 500 || chain.length > 16) {
        report.incomplete = true;
        if (!report.warnings.includes('Relationship results are limited to 500 articles and 16 include levels.')) report.warnings.push('Relationship results are limited to 500 articles and 16 include levels.');
        continue;
      }
      lineButtons += result.lines.length;
      if (result.lines.length < allLines.length) {
        report.incomplete = true;
        if (!report.warnings.includes('Source line links are limited to 50 per file and 1,000 per result. Reference counts include all matches.')) report.warnings.push('Source line links are limited to 50 per file and 1,000 per result. Reference counts include all matches.');
      }
      (cursor === 0 ? report.direct : report.indirect).push(result);
      queue.push({ file: consumer.file, chain });
    }
  }
  for (const collection of [report.direct, report.indirect]) collection.sort((a, b) => a.file.localeCompare(b.file));
  const unsupported = [...index.files.values()].filter(entry => key(entry.file) !== key(document))
    .reduce((count, file) => count + file.edges.filter(edge => edge.status !== 'found').length, currentEdges.filter(edge => edge.status !== 'found').length);
  if (unsupported) { report.incomplete = true; report.warnings.push(`${unsupported} include references were missing, outside this workspace, or unsupported. Results may be incomplete.`); }
  assertAccess();
  return report;
}
