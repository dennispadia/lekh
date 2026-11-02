import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type Token from 'markdown-it/lib/token.mjs';
import { decodeMarkdown } from './files.js';
import { parser } from './markdown.js';
import { parseIncludeDirective, type PublishingMeta } from './publishing.js';

const maxFileBytes = 10 * 1024 * 1024;
const maxTotalBytes = 20 * 1024 * 1024;
const maxDepth = 12;
const maxIncludes = 128;
const markdownExtension = /\.(?:md|markdown|mdown)$/i;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameFile(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function rebaseDestination(source: string, from: string, document: string): string {
  if (!source || source.startsWith('#') || source.startsWith('?') || /^[a-z][a-z\d+.-]*:/i.test(source) || path.isAbsolute(source)) return source;
  const match = /^([^?#]*)(.*)$/.exec(source)!;
  try {
    const target = path.resolve(path.dirname(from), decodeURIComponent(match[1]));
    const relative = path.relative(path.dirname(document), target).split(path.sep).join('/');
    return `${encodeURI(relative).replace(/#/g, '%23').replace(/\?/g, '%3F')}${match[2]}`;
  } catch {
    throw new Error(`Invalid relative link or image path in ${path.basename(from)}.`);
  }
}

function rebaseTokens(tokens: Token[], from: string, document: string): void {
  for (const token of tokens) {
    if (token.type === 'image' || token.type === 'link_open') {
      const attribute = token.type === 'image' ? 'src' : 'href';
      const source = token.attrGet(attribute);
      if (source !== null) token.attrSet(attribute, rebaseDestination(source, from, document));
    }
    if (token.children) rebaseTokens(token.children, from, document);
  }
}

type ResolveOptions = { displayErrors?: boolean };

/**
 * Expands parsed include tokens without modifying the parent Markdown or interpreting
 * directives inside code fences. A grant authorizes only a folder containing the document.
 */
export async function resolveIncludes(
  markdown: string, documentPath: string | null, authorizedRoot?: string | null, options: ResolveOptions = {},
): Promise<Token[]> {
  const initial = parser.parse(markdown, {});
  if (!initial.some(token => token.type === 'publishing_unsupported' && (token.meta as PublishingMeta).kind === 'include')) return initial;

  let document: string | undefined;
  let root: string | undefined;
  let totalBytes = 0;
  let includeCount = 0;
  let sequence = 0;

  async function access(): Promise<{ document: string; root: string }> {
    if (!documentPath) throw new Error('Save this document before loading relative include files.');
    if (!document || !root) {
      document = await realpath(documentPath);
      root = await realpath(authorizedRoot ?? path.dirname(document));
      if (!(await stat(document)).isFile() || !(await stat(root)).isDirectory() || !inside(root, document)) {
        throw new Error('The saved document must be inside the allowed include folder.');
      }
    }
    return { document, root };
  }

  async function expand(tokens: Token[], currentPath: string | null, stack: string[], depth: number): Promise<Token[]> {
    const result: Token[] = [];
    for (const token of tokens) {
      if (token.type !== 'publishing_unsupported' || (token.meta as PublishingMeta).kind !== 'include') {
        result.push(token);
        continue;
      }
      try {
        const directive = parseIncludeDirective(token.content.replace(/^[ \t]+/, ''));
        if (!directive?.source.trim()) throw new Error('Use [!INCLUDE [title](filepath)] with a local Markdown file.');
        if (++includeCount > maxIncludes) throw new Error(`A document can load at most ${maxIncludes} includes.`);
        if (depth >= maxDepth) throw new Error(`Includes cannot be nested more than ${maxDepth} levels.`);
        const scope = await access();
        let source: string;
        try { source = decodeURIComponent(directive.source); }
        catch { throw new Error('The include path contains invalid percent encoding.'); }
        if (/^(?![a-z]:[\\/])[a-z][a-z\d+.-]*:/i.test(source) || source.includes('\0')) {
          throw new Error('Only local Markdown include files are supported.');
        }
        if (!markdownExtension.test(source)) throw new Error('Include files must have a .md, .markdown, or .mdown extension.');
        const candidate = path.resolve(path.dirname(currentPath ?? scope.document), source);
        if (!inside(scope.root, candidate)) {
          throw new Error('This include is outside the allowed folder. Choose Allow local include folder and select a folder containing the document and include.');
        }
        let file: string;
        try { file = await realpath(candidate); }
        catch (error) {
          if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            throw new Error(`Include file not found: ${directive.source}`);
          }
          throw new Error(`Include file is inaccessible: ${directive.source}`);
        }
        if (!inside(scope.root, file)) throw new Error('The include resolves outside the allowed folder (symlink or junction escape).');
        if (!markdownExtension.test(file)) throw new Error('The include must resolve to a Markdown file.');
        if (stack.some(item => sameFile(item, file)) || sameFile(scope.document, file)) throw new Error(`Include cycle detected: ${directive.source}`);
        const handle = await open(file, 'r');
        let content: string;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > maxFileBytes || totalBytes + info.size > maxTotalBytes) {
            throw new Error('Include files must be regular files under 10 MB, with at most 20 MB loaded per document.');
          }
          const confirmed = await realpath(file);
          const current = await stat(confirmed);
          if (!inside(scope.root, confirmed) || current.dev !== info.dev || current.ino !== info.ino) {
            throw new Error('The include changed or escaped its allowed folder.');
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          while (true) {
            const chunk = Buffer.alloc(Math.min(64 * 1024, maxFileBytes - bytes + 1));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            bytes += bytesRead;
            if (bytes > maxFileBytes || totalBytes + bytes > maxTotalBytes) throw new Error('The included content exceeds the 10 MB file or 20 MB document limit.');
            chunks.push(chunk.subarray(0, bytesRead));
          }
          totalBytes += bytes;
          content = decodeMarkdown(Buffer.concat(chunks));
        } finally { await handle.close(); }
        const included = parser.parse(content.replace(/^\uFEFF/, ''), {});
        if (included[0]?.type === 'publishing_metadata' && included[0].map?.[0] === 0) included.shift();
        else if (included[0]?.type === 'publishing_unsupported' && (included[0].meta as PublishingMeta).reason?.startsWith('Unclosed document metadata')) {
          throw new Error(`Close the document metadata in ${directive.source} before including it.`);
        }
        rebaseTokens(included, file, scope.document);
        const prefix = `included-${++sequence}-`;
        for (const item of included) {
          if (item.type.startsWith('publishing_tab') && (item.meta as PublishingMeta | null)?.id) {
            item.meta = { ...item.meta, id: prefix + (item.meta as PublishingMeta).id };
          }
          item.level += token.level;
        }
        result.push(...await expand(included, file, [...stack, file], depth + 1));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options.displayErrors) throw new Error(`Could not load include: ${message}`);
        token.meta = { ...token.meta, reason: `Could not load include: ${message}` };
        result.push(token);
      }
    }
    return result;
  }

  return expand(initial, documentPath, [], 0);
}
