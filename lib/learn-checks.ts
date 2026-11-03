import { editablePublishingBlockAtStart, parseIncludeDirective, publishingBlockRanges } from './publishing.js';
import MarkdownIt from 'markdown-it';

export type LearnSeverity = 'error' | 'warning' | 'info';
export type LearnRule = 'alt-text' | 'image-path' | 'include-path' | 'publishing-block' | 'metadata';
export type LearnPathKind = 'image' | 'include';
export type LearnPathStatus = 'found' | 'missing' | 'needs-access' | 'unsaved' | 'external' | 'invalid';
export interface LearnPathReference { kind: LearnPathKind; path: string; line: number }
export interface LearnIssue {
  line: number;
  severity: LearnSeverity;
  rule: LearnRule;
  message: string;
  reference?: LearnPathReference;
}
export interface LearnCheckResult { issues: LearnIssue[]; references: LearnPathReference[] }

export const MAX_LEARN_PATHS = 500;
const maxReportedIssues = 500;
const externalPath = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;
const parser = new MarkdownIt({ html: true });

function lineAt(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function stripInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, match => ' '.repeat(match.length));
}

function localPath(source: string): string | null {
  const trimmed = source.trim().replace(/^<(.*)>$/, '$1');
  if (!trimmed || externalPath.test(trimmed) || /^data:/i.test(trimmed)) return null;
  return trimmed;
}

function dedent(lines: string[], from: number, indent: number): string {
  return lines.slice(from).map(line => line.replace(new RegExp(`^[ \\t]{0,${indent}}`), '')).join('\n');
}

/** Learn-oriented suggestions only. They never block editing, saving, or export. */
export function learnChecks(markdown: string): LearnCheckResult {
  const issues: LearnIssue[] = [];
  const references: LearnPathReference[] = [];
  const lines = markdown.split('\n').map(line => line.replace(/\r$/, ''));
  const starts: number[] = [];
  for (let offset = 0, index = 0; index < lines.length; index++) {
    starts.push(offset);
    offset += lines[index].length + (markdown[offset + lines[index].length] === '\r' ? 2 : 1);
  }
  const reported = new Set<number>();
  const excluded = new Set<number>();
  for (const token of parser.parse(markdown, {})) {
    if (token.map && ['fence', 'code_block', 'html_block'].includes(token.type)) {
      for (let index = token.map[0]; index < token.map[1]; index++) excluded.add(index + 1);
    }
  }
  let limitedPaths = false;
  const addReference = (kind: LearnPathKind, path: string, line: number) => {
    if (references.length < MAX_LEARN_PATHS) references.push({ kind, path, line });
    else limitedPaths = true;
  };

  for (const block of publishingBlockRanges(markdown)) {
    const line = lineAt(starts, block.from);
    if (block.kind === 'unsupported' && block.reason) {
      reported.add(line);
      issues.push({ line, severity: 'error', rule: 'publishing-block', message: block.reason });
    } else if (block.kind === 'metadata' && block.from === 0) {
      const metadataLines = block.raw.trimEnd().split(/\r?\n/).length;
      for (let index = 1; index <= metadataLines; index++) excluded.add(index);
      const body = block.raw.split(/\r?\n/).slice(1, -1);
      const value = (key: string) => body.find(entry => new RegExp(`^${key}[ \\t]*:`, 'i').test(entry))
        ?.replace(/^[^:]*:/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
      for (const key of ['title', 'description']) {
        if (!value(key)) issues.push({ line, severity: 'warning', rule: 'metadata', message: `Metadata is missing a ${key}. Learn articles require ${key}.` });
      }
    }
  }

  let fence: { character: string; length: number } | undefined;
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (excluded.has(line)) continue;
    const marker = /^[ \t]*(?:>[ \t]?)*(`{3,}|~{3,})(.*)$/.exec(raw);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const content = raw.replace(/<!--.*?-->/g, match => ' '.repeat(match.length)).replace(/^[ \t]*(?:>[ \t]?)*/, '');
    const indent = raw.length - raw.trimStart().length;
    const include = parseIncludeDirective(content);
    if (include) {
      const path = localPath(include.source);
      if (path) addReference('include', path, line);
      continue;
    }
    const directive = /^:::[ \t]*([a-z][\w-]*)/i.exec(content);
    if (directive) {
      if (directive[1].toLowerCase().endsWith('-end') || reported.has(line)) continue;
      const block = /^[ \t]*>/.test(raw) ? null : editablePublishingBlockAtStart(dedent(lines, index, indent));
      if (block?.kind === 'unsupported' && block.reason) {
        reported.add(line);
        issues.push({ line, severity: 'error', rule: 'publishing-block', message: block.reason });
      } else if (block?.kind === 'image' && block.attributes) {
        const type = block.attributes.type ?? 'content';
        if (type !== 'icon' && !block.attributes['alt-text']?.trim()) {
          issues.push({ line, severity: 'warning', rule: 'alt-text', message: 'Image directive has empty alt-text. Describe the image for screen readers.' });
        }
        const path = localPath(block.attributes.source ?? '');
        if (path) addReference('image', path, line);
      }
      continue;
    }
    const text = stripInlineCode(content);
    for (const match of text.matchAll(/!\[((?:\\.|[^\]\\])*)\](?:\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)|\[[^\]]*\])?/g)) {
      if (!match[1].trim()) {
        issues.push({ line, severity: 'warning', rule: 'alt-text', message: 'Image has no alt text. Describe the image for screen readers.' });
      }
      const path = match[2] ? localPath(match[2]) : null;
      if (path) addReference('image', path, line);
    }
  }
  if (limitedPaths) issues.push({ line: 1, severity: 'info', rule: 'image-path', message: `Only the first ${MAX_LEARN_PATHS} local paths were checked. Split the document to check the remaining paths.` });
  issues.sort((left, right) => left.line - right.line);
  if (issues.length > maxReportedIssues) {
    issues.splice(maxReportedIssues - 1);
    issues.push({ line: 1, severity: 'info', rule: 'publishing-block', message: `Results are limited to ${maxReportedIssues} suggestions. Resolve these and check again.` });
  }
  return { issues, references };
}

export function learnPathIssues(references: readonly LearnPathReference[], statuses: readonly LearnPathStatus[]): LearnIssue[] {
  const issues: LearnIssue[] = [];
  let unsaved = 0;
  for (const [index, reference] of references.entries()) {
    const status = statuses[index];
    const noun = reference.kind === 'image' ? 'Image' : 'Include';
    const rule: LearnRule = reference.kind === 'image' ? 'image-path' : 'include-path';
    if (status === 'missing') {
      issues.push({ line: reference.line, severity: 'error', rule, reference, message: `${noun} file not found: ${reference.path}` });
    } else if (status === 'invalid') {
      issues.push({ line: reference.line, severity: 'error', rule, reference, message: `${noun} path is not valid: ${reference.path}` });
    } else if (status === 'needs-access') {
      issues.push({ line: reference.line, severity: 'info', rule, reference, message: `${noun} is outside the allowed folders. Allow the project folder to check ${reference.path}.` });
    } else if (status === 'unsaved') unsaved++;
  }
  if (unsaved) {
    const first = references.find((_, index) => statuses[index] === 'unsaved')!;
    issues.push({ line: first.line, severity: 'info', rule: first.kind === 'image' ? 'image-path' : 'include-path',
      message: `Save the document to check ${unsaved} relative ${unsaved === 1 ? 'path' : 'paths'}.` });
  }
  return issues;
}
