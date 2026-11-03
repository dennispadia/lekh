import MarkdownIt from 'markdown-it';
import { parseIncludeDirective } from './publishing.js';

export interface IncludeReference { source: string; label: string; line: number }
export interface RelationshipInclude extends IncludeReference {
  file: string | null;
  status: 'found' | 'missing' | 'outside' | 'unsupported';
  lines: number[];
}
export interface RelationshipConsumer {
  file: string;
  lines: number[];
  referenceCount: number;
  /** Workspace-relative paths from the consumer through to the selected file. */
  chain: string[];
}
export interface RelationshipReport {
  root: string;
  document: string;
  target: string;
  includes: RelationshipInclude[];
  direct: RelationshipConsumer[];
  indirect: RelationshipConsumer[];
  files: number;
  scannedAt: string;
  warnings: string[];
  incomplete: boolean;
}

const syntax = new MarkdownIt({ html: true });

/** Source line numbers without treating fenced examples, HTML, or metadata as includes. */
export function includeReferences(markdown: string): IncludeReference[] {
  if (!/\[!INCLUDE\b/i.test(markdown)) return [];
  const lines = markdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const excluded = new Set<number>();
  for (const token of syntax.parse(markdown, {})) {
    if (token.map && ['fence', 'code_block', 'html_block'].includes(token.type)) {
      for (let index = token.map[0]; index < token.map[1]; index++) excluded.add(index);
    }
  }
  if (lines[0] === '---') {
    const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
    if (end > 0) for (let index = 0; index <= end; index++) excluded.add(index);
  }
  const references: IncludeReference[] = [];
  for (const [index, raw] of lines.entries()) {
    if (excluded.has(index)) continue;
    const content = raw.replace(/<!--.*?-->/g, '').replace(/^[ \t]*(?:>[ \t]?)*/, '');
    const directive = parseIncludeDirective(content);
    if (directive) references.push({ source: directive.source, label: directive.label, line: index + 1 });
  }
  return references;
}
