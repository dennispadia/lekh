import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { publishingBlockRanges } from './publishing.js';

const MAX_CONFIG_BYTES = 1024 * 1024;
type Range = { start: number; end: number };
type Line = Range & { text: string };

function linesOf(source: string): Line[] {
  const lines: Line[] = [];
  const endings = /\r\n|\r|\n/g;
  let start = 0;
  for (let match; (match = endings.exec(source));) {
    lines.push({ start, end: match.index, text: source.slice(start, match.index) });
    start = endings.lastIndex;
  }
  lines.push({ start, end: source.length, text: source.slice(start) });
  return lines;
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function key(file: string): string {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

async function authorizedDocument(documentPath: string | null, authorizedRoot: string): Promise<{ root: string; document: string; originalPath: string }> {
  if (!documentPath) throw new Error('Save the Markdown document before allowing local assets.');
  if (!path.isAbsolute(authorizedRoot) || !path.isAbsolute(documentPath)) throw new Error('The saved document and authorized asset root must have absolute local paths.');
  const root = await canonical(authorizedRoot, 'authorized asset root');
  if (!(await stat(root)).isDirectory()) throw new Error('The authorized asset root must be a directory.');
  const document = await canonical(documentPath, 'saved Markdown document');
  if (!inside(root, document)) throw new Error('The saved Markdown document resolves outside the authorized root (possible symlink escape).');
  if (!(await stat(document)).isFile()) throw new Error('The saved Markdown document must be a regular file.');
  return { root, document, originalPath: documentPath };
}

async function canonical(file: string, kind: string): Promise<string> {
  try { return await realpath(file); }
  catch { throw new Error(`Missing or inaccessible ${kind}: ${file}`); }
}

function yamlScalar(raw: string): string | undefined {
  const text = raw.trim();
  let result: string;
  if (text.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/.exec(text);
    if (!quoted) return;
    try { result = JSON.parse(quoted[1]) as string; }
    catch { return; }
  } else if (text.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'\s*(?:#.*)?$/.exec(text);
    if (!quoted) return;
    result = quoted[1].replace(/''/g, "'");
  } else {
    if (/^[!&*|>{[}\]]/.test(text)) return;
    result = text.replace(/\s+#.*$/, '').trim();
  }
  return result.length > 0 && result.length <= 512 && !/[\u0000-\u001f\u007f]/.test(result) ? result : undefined;
}

type Variant = { id: string; title: string };
type VariantGroup = { title: string; pivots: Variant[] };
const variantID = /^[a-z\d][a-z\d_-]*$/i;
export interface SharedVariantGroup {
  owner: string;
  id: string;
  title: string;
  prompt: string;
  pivots: Variant[];
}

function groupsSection(lines: string[]): { index: number; indent: number } {
  const sections = lines.flatMap((line, index) => /^groups:\s*(?:#.*)?$/.test(line) || /^groups:\s*\[\s*\]\s*(?:#.*)?$/.test(line) ? [index] : []);
  if (sections.length !== 1) throw new Error('Choose a shared configuration file with one top-level groups list.');
  return { index: sections[0], indent: /^ */.exec(lines[sections[0]])![0].length };
}

export function variantGroupIds(config: string): string[] {
  if (Buffer.byteLength(config, 'utf8') > MAX_CONFIG_BYTES) throw new Error('The shared configuration file exceeds the 1 MB limit.');
  const lines = config.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const { index, indent } = groupsSection(lines);
  const ids: string[] = [];
  const firstHeader = lines.slice(index + 1).map(line => /^( {0,2})- +id:\s*(.*)$/.exec(line)).find(Boolean);
  const groupIndent = firstHeader ? firstHeader[1].length : indent;
  for (let cursor = index + 1; cursor < lines.length; cursor++) {
    const line = lines[cursor];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const leading = /^ */.exec(line)![0].length;
    const header = /^( *)- +id:\s*(.*)$/.exec(line);
    if (header && header[1].length === groupIndent) {
      const id = yamlScalar(header[2]);
      if (!id || id.length > 64 || !variantID.test(id) || ids.includes(id)) throw new Error('The shared configuration contains an invalid or duplicate group ID.');
      ids.push(id);
      continue;
    }
    if (leading === groupIndent && /^\s*-/.test(line)) {
      throw new Error('The shared configuration uses an unsupported group entry format.');
    }
    if (leading < groupIndent || leading === groupIndent) break;
    if (!firstHeader && leading <= indent) break;
  }
  return ids;
}

function scalar(value: string): string {
  return JSON.stringify(value);
}

function validateSharedGroup(group: SharedVariantGroup): void {
  if (!/^[a-z\d-]{1,39}$/i.test(group.owner) || group.id.length > 64 || !variantID.test(group.id)) {
    throw new Error('Enter a valid owner and group ID using letters, numbers, hyphens, or underscores.');
  }
  for (const [label, value] of [['group name', group.title], ['selection title', group.prompt]] as const) {
    if (!value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(`Enter a valid ${label} (up to 512 characters).`);
    }
  }
  if (!Array.isArray(group.pivots) || group.pivots.length < 2 || group.pivots.length > 32) {
    throw new Error('A shared selector requires 2–32 choices.');
  }
  const ids = new Set<string>();
  for (const pivot of group.pivots) {
    if (pivot.id.length > 64 || !variantID.test(pivot.id) || ids.has(pivot.id) || !pivot.title.trim() ||
        pivot.title.length > 512 || /[\u0000-\u001f\u007f]/.test(pivot.title)) {
      throw new Error('Give every choice a unique ID and a title of 1–512 characters.');
    }
    ids.add(pivot.id);
  }
}

export function formatVariantGroupEntry(group: SharedVariantGroup, newline = '\n', groupIndent = 0): string {
  validateSharedGroup(group);
  const itemIndent = ' '.repeat(groupIndent);
  const fieldIndent = ' '.repeat(groupIndent + 2);
  const pivotIndent = ' '.repeat(groupIndent + 2);
  const pivotTitleIndent = ' '.repeat(groupIndent + 4);
  const entry = [
    `${itemIndent}# Owner: ${group.owner}`,
    `${itemIndent}- id: ${group.id}`,
    `${fieldIndent}title: ${scalar(group.title.trim())}`,
    `${fieldIndent}prompt: ${scalar(group.prompt.trim())}`,
    `${fieldIndent}pivots:`,
    ...group.pivots.flatMap(pivot => [
      `${pivotIndent}- id: ${pivot.id}`,
      `${pivotTitleIndent}title: ${scalar(pivot.title.trim())}`,
    ]),
  ].join(newline);
  return entry;
}

export function appendVariantGroupEntry(config: string, group: SharedVariantGroup): string {
  const ids = variantGroupIds(config);
  if (ids.includes(group.id)) throw new Error(`The shared configuration already contains the group “${group.id}”.`);
  const newline = /\r\n|\r|\n/.exec(config)?.[0] ?? '\n';
  const bom = config.startsWith('\uFEFF') ? '\uFEFF' : '';
  const sourceWithoutBom = config.slice(bom.length);
  const lines = sourceWithoutBom.split(/\r\n|\r|\n/);
  const { index, indent } = groupsSection(lines);
  const emptyList = /^groups:\s*\[\s*\]\s*(?:#.*)?$/.test(lines[index]);
  const existing = lines.slice(index + 1).find(line => /^( {0,2})- +id:/.test(line));
  const groupIndent = existing ? /^ */.exec(existing)![0].length : indent;
  const entry = formatVariantGroupEntry(group, newline, groupIndent);
  const source = emptyList ? lines.map((line, lineIndex) => lineIndex === index ? line.replace(/\[\s*\]/, '') : line).join(newline) : sourceWithoutBom;
  const prefix = source.endsWith('\n') || source.endsWith('\r') ? '' : newline;
  const updated = `${source}${prefix}${entry}${newline}`;
  if (Buffer.byteLength(`${bom}${updated}`, 'utf8') > MAX_CONFIG_BYTES) throw new Error('The updated shared configuration would exceed the 1 MB limit.');
  return `${bom}${updated}`;
}

function variantGroup(config: string, id: string): VariantGroup | undefined {
  // Deliberately not a YAML evaluator: aliases, tags, flow collections and multiline scalars
  // in the selected group fall back to the caller's visible ID-based labels.
  const lines = config.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const groups = lines.findIndex(line => /^groups:\s*(?:#.*)?$/.test(line));
  if (groups < 0) return;
  let groupIndent: number | undefined;
  for (let index = groups + 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const header = /^( {0,2})- +id:\s*(.*)$/.exec(line);
    if (!header) {
      if (/^\S/.test(line)) return;
      continue;
    }
    if (groupIndent === undefined) groupIndent = header[1].length;
    if (header[1].length !== groupIndent) continue;
    if (yamlScalar(header[2]) !== id) continue;
    const indent = header[1].length;
    let title: string | undefined;
    let prompt: string | undefined;
    let inPivots = false;
    let pivotIndent: number | undefined;
    const pivots: Variant[] = [];
    for (index++; index < lines.length; index++) {
      const current = lines[index];
      if (!current.trim() || /^\s*#/.test(current)) continue;
      if (/^\s*\t/.test(current)) return;
      const leading = /^ */.exec(current)![0].length;
      if (leading <= indent) break;
      const field = /^( *)(title|prompt|pivots):\s*(.*)$/.exec(current);
      if (field && field[1].length === indent + 2 && pivotIndent === undefined) {
        if (field[2] === 'pivots') {
          if (inPivots || !/^(?:#.*)?$/.test(field[3])) return;
          inPivots = true;
        } else {
          const value = yamlScalar(field[3]);
          if (value === undefined) return;
          if (field[2] === 'title') { if (title !== undefined) return; title = value; }
          else { if (prompt !== undefined) return; prompt = value; }
        }
        continue;
      }
      const pivot = /^( *)- +id:\s*(.*)$/.exec(current);
      if (inPivots && pivot && (pivot[1].length === indent + 2 || pivot[1].length === indent + 4)) {
        if (pivotIndent !== undefined && pivotIndent !== pivot[1].length) return;
        pivotIndent = pivot[1].length;
        const pivotID = yamlScalar(pivot[2]);
        if (!pivotID || !variantID.test(pivotID) || pivots.some(item => item.id === pivotID) ||
            pivots.some(item => !item.title) || pivots.length >= 32) return;
        pivots.push({ id: pivotID, title: '' });
        continue;
      }
      const pivotTitle = /^( *)title:\s*(.*)$/.exec(current);
      if (pivotTitle && pivotIndent !== undefined && pivotTitle[1].length === pivotIndent + 2 && pivots.length) {
        const value = yamlScalar(pivotTitle[2]);
        if (value === undefined || pivots.at(-1)!.title) return;
        pivots.at(-1)!.title = value;
        continue;
      }
      return;
    }
    if (pivots.length > 0 && pivots.every(item => item.title)) return { title: prompt ?? title ?? 'Content variants', pivots };
    return;
  }
}

function variantMetadata(markdown: string): { id: string; end: number; closeStart: number; closeEnd: number } | undefined {
  const lines = linesOf(markdown);
  if (lines[0].text.replace(/^\uFEFF/, '') !== '---') return;
  let id: string | undefined;
  for (let index = 1; index < lines.length && lines[index].end < 64 * 1024; index++) {
    if (lines[index].text === '---') {
      return { id: id ?? '', end: lines[index + 1]?.start ?? markdown.length, closeStart: lines[index].start, closeEnd: lines[index].end };
    }
    const field = /^zone_pivot_groups:\s*(.*)$/.exec(lines[index].text);
    if (field) {
      if (id !== undefined) { id = '\0'; continue; }
      id = yamlScalar(field[1]);
      if (!id || !variantID.test(id)) id = '\0';
    }
  }
}

export function addVariantMetadata(markdown: string, id: string): string {
  if (!variantID.test(id)) throw new Error('The group ID is invalid.');
  const metadata = variantMetadata(markdown);
  if (!metadata) {
    if (/^(?:\uFEFF)?---(?:\r?\n)/.test(markdown)) throw new Error('The article has an incomplete front-matter block.');
    const bom = markdown.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = markdown.slice(bom.length);
    return `${bom}---\nzone_pivot_groups: ${id}\n---\n\n${body}`;
  }
  if (metadata.id) {
    if (metadata.id === '\0') throw new Error('The article contains an invalid zone_pivot_groups metadata field.');
    if (metadata.id === id) return markdown;
    throw new Error(`This article already references the shared group “${metadata.id}”.`);
  }
  const before = markdown.slice(0, metadata.closeStart);
  const after = markdown.slice(metadata.closeStart);
  const newline = /\r\n|\r|\n/.exec(before)?.[0] ?? '\n';
  return `${before}${before.endsWith('\n') || before.endsWith('\r') ? '' : newline}zone_pivot_groups: ${id}${newline}${after}`;
}

function injectVariantSelectorFromConfig(markdown: string, config: string): string {
  const metadata = variantMetadata(markdown);
  if (!metadata?.id || publishingBlockRanges(markdown).some(block => block.kind === 'selector')) return markdown;
  const group = variantGroup(config, metadata.id);
  if (!group) return markdown;
  const attribute = group.title.replace(/\\/g, '\\\\').replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const label = (text: string) => text.replace(/[\\`*_[\]<>!|]/g, '\\$&');
  const selector = `:::selector title="${attribute}"\n${group.pivots.map(item => `- [${label(item.title)}](#variant/${item.id})`).join('\n')}\n:::selector-end`;
  return `${markdown.slice(0, metadata.end)}\n${selector}\n\n${markdown.slice(metadata.end)}`;
}

async function readVariantConfig(file: string): Promise<string | undefined> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return;
    const confirmed = await canonical(file, 'variant configuration');
    const current = await stat(confirmed);
    if (key(confirmed) !== key(file) || current.dev !== info.dev || current.ino !== info.ino) {
      throw new Error('The variant configuration changed or escaped its authorized root.');
    }
    const chunks: Buffer[] = [];
    let remaining = MAX_CONFIG_BYTES;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      remaining -= bytesRead;
      if (remaining < 0) return;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await handle.close(); }
}

async function injectVariantSelector(markdown: string, document: string, root: string): Promise<string> {
  const metadata = variantMetadata(markdown);
  if (!metadata?.id || publishingBlockRanges(markdown).some(block => block.kind === 'selector')) return markdown;
  let directory = path.dirname(document);
  let remaining = MAX_CONFIG_BYTES;
  for (let depth = 0; depth < 64 && inside(root, directory); depth++) {
    for (const name of ['zone_pivot_groups.yml', 'zone-pivot-groups.yml']) {
      const candidate = path.join(directory, name);
      let file: string | undefined;
      try { file = await realpath(candidate); }
      catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          throw new Error('The local variant configuration is inaccessible.');
        }
      }
      if (!file) continue;
      if (!inside(root, file)) throw new Error('The variant configuration resolves outside the authorized root (symlink or junction escape).');
      if (!/\.ya?ml$/i.test(file)) continue;
      const config = await readVariantConfig(file);
      if (!config) continue;
      remaining -= Buffer.byteLength(config, 'utf8');
      if (remaining < 0) return markdown;
      const prepared = injectVariantSelectorFromConfig(markdown, config);
      if (prepared !== markdown) return prepared;
    }
    if (key(directory) === key(root)) break;
    directory = path.dirname(directory);
  }
  return markdown;
}

export async function prepareVariantConfigurationFromFile(markdown: string, filePath: string): Promise<string> {
  if (!path.isAbsolute(filePath)) throw new Error('Choose an existing shared configuration file.');
  const file = await canonical(filePath, 'selected shared configuration');
  if (!/\.ya?ml$/i.test(file)) throw new Error('Choose an existing .yml or .yaml configuration file.');
  const config = await readVariantConfig(file);
  if (!config) throw new Error('The selected shared configuration could not be read or exceeds the 1 MB limit.');
  variantGroupIds(config);
  return injectVariantSelectorFromConfig(markdown, config);
}

/**
 * The per-document asset grant is used only to read local variant-label configuration.
 */
export async function prepareVariantConfiguration(
  markdown: string, documentPath: string | null, authorizedRoot: string | null,
): Promise<string> {
  if (!authorizedRoot) return markdown;
  const { root, document } = await authorizedDocument(documentPath, authorizedRoot);
  return injectVariantSelector(markdown, document, root);
}
