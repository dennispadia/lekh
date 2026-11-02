import MarkdownIt from 'markdown-it';
import { hasInteractivePublishing, registerPublishing } from './publishing.js';

function markdownParser(): MarkdownIt {
  const parser = new MarkdownIt({ html: false, linkify: true, breaks: false });
  registerPublishing(parser);
  parser.block.ruler.before('paragraph', 'lekh_toc_marker', (state, startLine, _endLine, silent) => {
    const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
    if (!/^<!-- \/?lekh:toc -->$/.test(line)) return false;
    if (!silent) state.line = startLine + 1;
    return true;
  }, { alt: ['paragraph', 'list', 'blockquote'] });
  return parser;
}

export const parser = markdownParser();
export const previewParser = markdownParser();
previewParser.block.ruler.before('publishing', 'preview_comment', (state, start, end, silent) => {
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const first = state.bMarks[start] + state.tShift[start];
  if (!state.src.startsWith('<!--', first)) return false;
  if (silent) return true;
  let line = start;
  let tail = '';
  for (; line < end; line++) {
    if (line > start && state.sCount[line] < state.blkIndent && !state.isEmpty(line)) break;
    const text = state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
    const close = text.indexOf('-->', line === start ? 4 : 0);
    if (close < 0) continue;
    tail = text.slice(close + 3).trimStart();
    line++;
    break;
  }
  state.line = line;
  if (tail) {
    state.push('paragraph_open', 'p', 1).map = [line - 1, line];
    const inline = state.push('inline', '', 0);
    inline.content = tail;
    inline.children = [];
    inline.map = [line - 1, line];
    state.push('paragraph_close', 'p', -1);
  }
  return true;
}, { alt: ['paragraph', 'list', 'blockquote'] });
previewParser.inline.ruler.before('html_inline', 'preview_comment', (state) => {
  if (!state.src.startsWith('<!--', state.pos)) return false;
  const close = state.src.indexOf('-->', state.pos + 4);
  if (close < 0 || close + 3 > state.posMax) return false;
  state.pos = close + 3;
  return true;
});

export function requiresInteractiveExport(markdown: string): boolean {
  return hasInteractivePublishing(parser.parse(markdown, {}));
}

export function headings(markdown: string, tokens = parser.parse(markdown, {})): { level: number; text: string; displayText: string; line: number; root: boolean }[] {
  const inlineText = (children: typeof tokens): string => children.map(token => {
    if (token.children) return inlineText(token.children);
    if (token.type === 'text' || token.type === 'code_inline') return token.content;
    return token.type === 'softbreak' || token.type === 'hardbreak' ? ' ' : '';
  }).join('');
  return tokens.flatMap((token, index) => token.type === 'heading_open'
    ? [{
      level: Number(token.tag.slice(1)),
      text: tokens[index + 1].content,
      displayText: inlineText(tokens[index + 1].children ?? []).trim(),
      line: token.map?.[0] ?? 0,
      root: token.level === 0,
    }]
    : []);
}

/** Line ranges [start, end) of top-level blocks such as zones, tab groups, lists, quotes, tables and code fences. */
export function topLevelBlocks(tokens: ReturnType<typeof parser.parse>): [number, number][] {
  return tokens.filter(token => token.level === 0 && token.nesting >= 0 && token.map && !/^(heading|paragraph)_open$/.test(token.type) && token.type !== 'inline').map(token => [token.map![0], token.map![1]] as [number, number]);
}

export function wordCount(markdown: string): number {
  return markdown.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

export function replaceAllLiteral(text: string, search: string, replacement: string): { text: string; count: number } {
  if (!search) throw new Error('Enter some text to find.');
  const parts = text.split(search);
  return { text: parts.join(replacement), count: parts.length - 1 };
}

export function isSafeLink(url: string): boolean {
  try { return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol); }
  catch { return false; }
}

export function imageDisplayURL(source: string, documentId = ''): string {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(source)) return source;
  return `lekh-image://local/image?source=${encodeURIComponent(source)}&document=${encodeURIComponent(documentId)}`;
}

export function documentPreviewHTML(markdown: string, documentId: string): string {
  return documentPreviewTokensHTML(previewParser.parse(markdown, {}), documentId);
}

export function documentPreviewTokensHTML(tokens: ReturnType<typeof parser.parse>, documentId: string): string {
  const scopeImages = (items: typeof tokens): void => {
    for (const token of items) {
      if (token.type === 'image') {
        const source = token.attrGet('src') ?? '';
        token.attrSet('data-lekh-source', source);
        token.attrSet('src', imageDisplayURL(source, documentId));
      }
      if (token.children) scopeImages(token.children);
    }
  };
  scopeImages(tokens);
  return parser.renderer.render(tokens, parser.options, {});
}

export function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function headingAnchor(text: string, used: Map<string, number>): string {
  const plain = parser.parseInline(text, {})[0]?.children?.filter(token => !['html_inline', 'image'].includes(token.type)).map(token => token.content).join('') ?? text;
  const base = plain.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') || 'section';
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return `${base}${count ? `-${count}` : ''}`;
}
