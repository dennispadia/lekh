import { headingAnchor, headings, parser } from './markdown.js';

export const TOC_START = '<!-- lekh:toc -->';
export const TOC_END = '<!-- /lekh:toc -->';

function markedContents(markdown: string): { starts: RegExpMatchArray[]; ends: RegExpMatchArray[] } {
  const offsets = [0];
  for (const match of markdown.matchAll(/\n/g)) offsets.push(match.index + 1);
  const code = parser.parse(markdown, {}).filter(token => ['fence', 'code_block'].includes(token.type) && token.map)
    .map(token => [offsets[token.map![0]], offsets[token.map![1]] ?? markdown.length]);
  const outsideCode = (match: RegExpMatchArray) => !code.some(([from, to]) => match.index! >= from && match.index! < to);
  return {
    starts: [...markdown.matchAll(/^<!-- lekh:toc -->\r?$/gm)].filter(outsideCode),
    ends: [...markdown.matchAll(/^<!-- \/lekh:toc -->\r?$/gm)].filter(outsideCode),
  };
}

export function hasMarkedTableOfContents(markdown: string): boolean {
  const { starts, ends } = markedContents(markdown);
  return starts.length > 0 || ends.length > 0;
}

export function tableOfContents(markdown: string): string {
  const outline = headings(markdown);
  if (!outline.length) throw new Error('Add headings before inserting a table of contents.');
  const used = new Map<string, number>();
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n';
  return [TOC_START, '**Contents**', '', ...outline.map(item => {
    const anchor = headingAnchor(item.text, used);
    const text = item.displayText.replace(/[[\]\\]/g, '\\$&');
    return `${'  '.repeat(item.level - 1)}- [${text}](#${anchor})`;
  }), TOC_END].join(newline);
}

export function updateTableOfContents(markdown: string): string {
  const { starts, ends } = markedContents(markdown);
  const start = starts[0]?.index;
  const endMarker = ends[0]?.index;
  if (starts.length !== 1 || ends.length !== 1 || start === undefined || endMarker === undefined || start >= endMarker) {
    throw new Error('Update requires exactly one marked Lekh table of contents. Insert a new one if your contents list has no markers.');
  }
  return markdown.slice(0, start) + tableOfContents(markdown) + markdown.slice(endMarker + TOC_END.length);
}
