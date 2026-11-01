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

function variantMetadata(markdown: string): { id: string; end: number } | undefined {
  const lines = linesOf(markdown);
  if (lines[0].text.replace(/^\uFEFF/, '') !== '---') return;
  let id: string | undefined;
  for (let index = 1; index < lines.length && lines[index].end < 64 * 1024; index++) {
    if (lines[index].text === '---') {
      return id ? { id, end: lines[index + 1]?.start ?? markdown.length } : undefined;
    }
    const field = /^zone_pivot_groups:\s*(.*)$/.exec(lines[index].text);
    if (field) {
      if (id !== undefined) return;
      id = yamlScalar(field[1]);
      if (!id || !variantID.test(id)) return;
    }
  }
}

async function injectVariantSelector(markdown: string, document: string, root: string): Promise<string> {
  const metadata = variantMetadata(markdown);
  if (!metadata || publishingBlockRanges(markdown).some(block => block.kind === 'selector')) return markdown;
  let directory = path.dirname(document);
  let remaining = MAX_CONFIG_BYTES;
  for (let depth = 0; depth < 64 && inside(root, directory); depth++) {
    const candidate = path.join(directory, 'zone-pivot-groups.yml');
    let file: string | undefined;
    try { file = await realpath(candidate); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error('The local variant configuration is inaccessible.');
      }
    }
    if (file) {
      if (!inside(root, file)) throw new Error('The variant configuration resolves outside the authorized root (symlink or junction escape).');
      if (!/\.ya?ml$/i.test(file)) return markdown;
      const handle = await open(file, 'r');
      let config: string;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > remaining) return markdown;
        const confirmed = await canonical(file, 'variant configuration');
        const current = await stat(confirmed);
        if (!inside(root, confirmed) || current.dev !== info.dev || current.ino !== info.ino) {
          throw new Error('The variant configuration changed or escaped its authorized root.');
        }
        const chunks: Buffer[] = [];
        while (true) {
          const buffer = Buffer.alloc(Math.min(64 * 1024, remaining + 1));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          remaining -= bytesRead;
          if (remaining < 0) return markdown;
          chunks.push(buffer.subarray(0, bytesRead));
        }
        config = Buffer.concat(chunks).toString('utf8');
      } finally { await handle.close(); }
      const group = variantGroup(config, metadata.id);
      if (group) {
        const attribute = group.title.replace(/\\/g, '\\\\').replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const label = (text: string) => text.replace(/[\\`*_[\]<>!|]/g, '\\$&');
        const selector = `:::selector title="${attribute}"\n${group.pivots.map(item => `- [${label(item.title)}](#variant/${item.id})`).join('\n')}\n:::selector-end`;
        return `${markdown.slice(0, metadata.end)}\n${selector}\n\n${markdown.slice(metadata.end)}`;
      }
    }
    if (key(directory) === key(root)) break;
    directory = path.dirname(directory);
  }
  return markdown;
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
