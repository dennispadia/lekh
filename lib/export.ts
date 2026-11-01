import {
  AlignmentType, Bookmark, BorderStyle, Document, ExternalHyperlink, HeadingLevel, ImageRun,
  InternalHyperlink, LevelFormat, LineRuleType, Packer, Paragraph, Tab, TabStopType, Table, TableCell, TableLayoutType,
  TableRow, TextRun, UnderlineType, VerticalAlign,
  WidthType, type ILevelsOptions, type IParagraphOptions, type IRunOptions, type IStylesOptions,
  type ParagraphChild,
} from 'docx';
import { createHash } from 'node:crypto';
import Token from 'markdown-it/lib/token.mjs';
import { escapeHTML, headingAnchor, isSafeLink, parser } from './markdown.js';
import { embeddedImage, readImage } from './images.js';
import { highlightedHTML, highlightedSegments, syntaxCSS, type CodeSegment } from './highlight.js';
import { diagramLimits, isMermaidLanguage, prepareMermaid } from './diagrams.js';
import { productName } from './branding.js';
import { assertStaticExportSupported, publishingCalloutPalette, publishingCSS, type PublishingMeta } from './publishing.js';
import { interactiveExportCSS, interactiveExportScript } from './interactive-export.js';

export type ImageLoader = (source: string) => Promise<{ data: Buffer; mime: string }>;
export type RasterValidator = (data: Buffer, mime: string) => Promise<void>;
/** The renderer supplies locally rendered PNGs keyed by the original fence source. */
export type DiagramImageLoader = (source: string) => Promise<{ data: Buffer; mime: 'image/png' }>;

async function diagramImage(source: string, loader?: DiagramImageLoader) {
  prepareMermaid(source);
  if (!loader) throw new Error('Mermaid export requires a rendered diagram image. Please render the diagram before exporting.');
  const image = await loader(source);
  if (image.mime !== 'image/png' || !Buffer.isBuffer(image.data) || image.data.length > diagramLimits.pngBytes) {
    throw new Error('Mermaid export requires a PNG image smaller than 8 MB.');
  }
  const dimensions = imageDimensions(image.data, 'png');
  if (dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 8_000_000) {
    throw new Error('Mermaid export image dimensions are too large.');
  }
  return { ...image, dimensions };
}
type Block = Paragraph | Table;
const page = { width: 11906, height: 16838, margin: 1134 };
const contentWidth = page.width - page.margin * 2;
const wordLineSpacing = 276;
const ink = { text: '263238', muted: '607078', accent: '227C78', line: 'DDE5E5', soft: 'F1F5F5', code: 'F3F6F6' };
const headingSizes = [51, 32, 26, 23, 22, 20];
const headingSpacing = [
  { before: 0, after: 330 }, { before: 600, after: 220 }, { before: 430, after: 180 },
  { before: 360, after: 160 }, { before: 330, after: 140 }, { before: 300, after: 120 },
];
const headingLevels = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
];
const styles: IStylesOptions = {
  default: {
    document: {
      run: { font: 'Segoe UI', size: 24, color: ink.text },
      paragraph: { spacing: { before: 0, after: 160, line: wordLineSpacing, lineRule: LineRuleType.AUTO } },
    },
    hyperlink: { run: { color: ink.accent, underline: { type: UnderlineType.SINGLE } } },
    ...Object.fromEntries(headingSizes.map((size, index) => [`heading${index + 1}`, {
      run: { font: 'Segoe UI', size, bold: true, color: ink.text },
      paragraph: { spacing: { ...headingSpacing[index], line: wordLineSpacing, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true },
    }])),
  },
};

type List = { level: number; reference: string };
type ListItem = { pending: boolean };

export async function toDocx(markdown: string, loadImage: ImageLoader, loadDiagram?: DiagramImageLoader): Promise<Buffer> {
  const tokens = parser.parse(markdown, {});
  assertStaticExportSupported(tokens);
  if (tokens.filter(token => token.type === 'fence' && isMermaidLanguage(token.info)).length > diagramLimits.diagrams) throw new Error('An export supports at most 32 Mermaid diagrams.');
  const blocks: Block[] = [];
  const lists: List[] = [];
  const items: ListItem[] = [];
  const numbering: { reference: string; levels: ILevelsOptions[] }[] = [];
  const headingBookmarks = new Map<Token, string>();
  const anchorBookmarks = new Map<string, string>();
  const usedAnchors = new Map<string, number>();
  for (const [index, token] of tokens.entries()) {
    if (token.type !== 'heading_open') continue;
    const anchor = headingAnchor(tokens[index + 1].content, usedAnchors);
    const name = `lekh_heading_${index}`;
    headingBookmarks.set(token, name);
    anchorBookmarks.set(anchor, name);
  }
  let heading: (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined;
  let bookmark: string | undefined;
  let quote = 0;
  let currentTable: TableRow[] | null = null;
  let tableWidth = contentWidth;
  let columnWidth = contentWidth;
  let currentRow: TableCell[] = [];
  let currentCell: Paragraph[] | null = null;
  let headerCell = false;
  let headerRow = false;
  let cellAlignment: IParagraphOptions['alignment'];
  const callouts: PublishingMeta[] = [];
  let caption = false;

  const indentation = () => 360 * ((lists.at(-1)?.level ?? -1) + 1 + quote);
  const availableWidth = () => currentCell ? columnWidth - 320 : contentWidth - indentation();

  function appendParagraph(children: ParagraphChild[], options: IParagraphOptions = {}): void {
    const list = lists.at(-1);
    const item = items.at(-1);
    const marker = item?.pending && list && currentCell === null;
    const left = indentation();
    const alertColors = publishingCalloutPalette[callouts.at(-1)?.variant ?? ''];
    const paragraph = new Paragraph({
      children,
      widowControl: true,
      numbering: marker ? { reference: list.reference, level: list.level } : undefined,
      indent: left && currentCell === null ? { left, ...(marker ? { hanging: 240 } : {}) } : undefined,
      spacing: list ? { before: 45, after: 45, line: wordLineSpacing, lineRule: LineRuleType.AUTO } : undefined,
      ...(quote && currentCell === null ? {
        shading: { fill: ink.soft },
        border: { left: { color: ink.accent, style: BorderStyle.SINGLE, size: 18, space: 12 } },
      } : {}),
      ...(callouts.length && currentCell === null ? {
        shading: { fill: alertColors?.background.slice(1).toUpperCase() ?? ink.soft },
        border: { left: {
          color: alertColors?.border.slice(1).toUpperCase() ?? ink.accent,
          style: BorderStyle.SINGLE, size: 18, space: 12,
        } },
      } : {}),
      ...options,
    });
    (currentCell ?? blocks).push(paragraph);
    if (item) item.pending = false;
  }

  function imageRun(data: Buffer, type: 'png' | 'jpg' | 'gif', alt: string): ImageRun {
    const dimensions = imageDimensions(data, type);
    const scale = Math.min(1, availableWidth() / 15 / dimensions.width, 900 / dimensions.height);
    return new ImageRun({
      data, type,
      transformation: { width: Math.max(1, Math.round(dimensions.width * scale)), height: Math.max(1, Math.round(dimensions.height * scale)) },
      altText: { title: alt, description: alt, name: alt || 'Image' },
    });
  }

  async function inline(children: Token[], inherited: IRunOptions = {}): Promise<ParagraphChild[]> {
    const runs: ParagraphChild[] = [];
    const stack: IRunOptions[] = [];
    let style: IRunOptions = { ...inherited };
    for (let index = 0; index < children.length; index++) {
      const token = children[index];
      switch (token.type) {
        case 'strong_open': stack.push(style); style = { ...style, bold: true }; break;
        case 'em_open': stack.push(style); style = { ...style, italics: true }; break;
        case 's_open': stack.push(style); style = { ...style, strike: true }; break;
        case 'publishing_sub_open': stack.push(style); style = { ...style, subScript: true }; break;
        case 'publishing_sup_open': stack.push(style); style = { ...style, superScript: true }; break;
        case 'strong_close':
        case 'em_close':
        case 'publishing_sub_close':
        case 'publishing_sup_close':
        case 's_close': style = stack.pop() ?? inherited; break;
        case 'text': runs.push(new TextRun({ ...style, text: token.content })); break;
        case 'code_inline': runs.push(new TextRun({ ...style, text: token.content, font: 'Consolas', size: 19, shading: { fill: ink.code } })); break;
        case 'softbreak': runs.push(new TextRun({ ...style, text: ' ' })); break;
        case 'hardbreak': runs.push(new TextRun({ ...style, break: 1 })); break;
        case 'link_open': {
          let end = index + 1;
          let depth = 1;
          for (; end < children.length; end++) {
            if (children[end].type === 'link_open') depth++;
            if (children[end].type === 'link_close' && --depth === 0) break;
          }
          const label = await inline(children.slice(index + 1, end), {
            ...style, color: ink.accent, underline: { type: UnderlineType.SINGLE },
          });
          const href = token.attrGet('href') ?? '';
          let target: string | undefined;
          if (href.startsWith('#')) {
            try { target = anchorBookmarks.get(decodeURIComponent(href.slice(1))); }
            catch (error) {
              if (!(error instanceof URIError)) throw error;
              console.warn('Word export retained a malformed heading link as text.');
            }
          }
          if (target) runs.push(new InternalHyperlink({ anchor: target, children: label }));
          else if (isSafeLink(href)) runs.push(new ExternalHyperlink({ link: href, children: label }));
          else runs.push(...label);
          index = end;
          break;
        }
        case 'image': {
          const source = token.attrGet('src') ?? '';
          const { data, mime } = await loadImage(source);
          const type = mime === 'image/jpeg' ? 'jpg' : mime.slice(6);
          if (type !== 'png' && type !== 'jpg' && type !== 'gif') {
            throw new Error('Word export supports PNG, JPEG, and GIF images. Please replace WebP images before exporting to Word.');
          }
          runs.push(imageRun(data, type, token.content));
          break;
        }
      }
    }
    return runs;
  }

  for (const [tokenIndex, token] of tokens.entries()) {
    if (token.type === 'publishing_callout_open') {
      const meta = token.meta as PublishingMeta;
      callouts.push(meta);
      appendParagraph([new TextRun({
        text: meta.title!, bold: true, color: publishingCalloutPalette[meta.variant!]?.border.slice(1).toUpperCase() ?? ink.accent,
      })], { keepNext: true });
    } else if (token.type === 'publishing_callout_close') callouts.pop();
    else if (token.type === 'publishing_caption_open') caption = true;
    else if (token.type === 'publishing_caption_close') caption = false;
    else if (token.type === 'publishing_unsupported') {
      appendParagraph([new TextRun({ text: (token.meta as PublishingMeta).reason!, bold: true, color: '956019' })],
        { shading: { fill: 'FFF8E6' }, keepNext: true });
      for (const line of token.content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')) {
        appendParagraph([new TextRun({ text: line || ' ', font: 'Consolas', size: 18 })], { shading: { fill: 'FFF8E6' } });
      }
    } else if (token.type === 'heading_open') {
      heading = headingLevels[Number(token.tag.slice(1)) - 1];
      bookmark = headingBookmarks.get(token);
    } else if (token.type === 'heading_close') {
      heading = undefined;
      bookmark = undefined;
    }
    else if (token.type === 'blockquote_open') quote++;
    else if (token.type === 'blockquote_close') quote--;
    else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const level = Math.min(lists.length, 8);
      const reference = `list-${numbering.length}`;
      const ordered = token.type === 'ordered_list_open';
      numbering.push({
        reference, levels: Array.from({ length: 9 }, (_, index) => ({
          level: index, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
          text: ordered ? `%${index + 1}.` : ['\u2022', '\u25e6', '\u25aa'][index % 3],
          start: ordered && index === level ? Number(token.attrGet('start') || 1) : 1,
          alignment: AlignmentType.START,
          style: {
            run: { font: 'Segoe UI', color: ink.accent },
            paragraph: { indent: { left: 360 * (index + 1), hanging: 240 } },
          },
        })),
      });
      lists.push({ level, reference });
    } else if (token.type === 'bullet_list_close' || token.type === 'ordered_list_close') {
      lists.pop();
    } else if (token.type === 'list_item_open') items.push({ pending: true });
    else if (token.type === 'list_item_close') items.pop();
    else if (token.type === 'table_open') {
      currentTable = [];
      tableWidth = contentWidth - indentation();
      const headerEnd = tokens.findIndex((next, index) => index > tokenIndex && next.type === 'tr_close');
      const columns = tokens.slice(tokenIndex, headerEnd).filter(next => next.type === 'th_open').length;
      columnWidth = Math.floor(tableWidth / Math.max(1, columns));
    } else if (token.type === 'tr_open') {
      currentRow = [];
      headerRow = false;
    }
    else if (token.type === 'th_open' || token.type === 'td_open') {
      currentCell = [];
      headerCell = token.type === 'th_open';
      headerRow ||= headerCell;
      cellAlignment = ({
        'text-align:left': AlignmentType.LEFT, 'text-align:center': AlignmentType.CENTER,
        'text-align:right': AlignmentType.RIGHT,
      })[token.attrGet('style') ?? ''];
    } else if (token.type === 'th_close' || token.type === 'td_close') {
      currentRow.push(new TableCell({
        children: currentCell?.length ? currentCell : [new Paragraph('')],
        width: { size: columnWidth, type: WidthType.DXA },
        shading: headerCell ? { fill: ink.soft } : undefined,
        verticalAlign: VerticalAlign.TOP,
      }));
      currentCell = null;
      cellAlignment = undefined;
    } else if (token.type === 'tr_close') currentTable?.push(new TableRow({
      children: currentRow, tableHeader: headerRow, cantSplit: true,
    }));
    else if (token.type === 'table_close') {
      const border = { color: ink.line, size: 6, style: BorderStyle.SINGLE };
      if (currentTable?.length) {
        blocks.push(new Table({
          rows: currentTable, width: { size: tableWidth, type: WidthType.DXA },
          columnWidths: currentRow.map(() => columnWidth), layout: TableLayoutType.FIXED,
          indent: { size: indentation(), type: WidthType.DXA },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
        }));
      }
      currentTable = null;
    } else if (token.type === 'inline') {
      const children = token.children ?? [];
      const task = items.at(-1)?.pending && lists.length ? /^\[([ xX])\]\s+/.exec(children[0]?.type === 'text' ? children[0].content : '') : null;
      if (task) children[0].content = children[0].content.slice(task[0].length);
      const runs = await inline(children, currentCell ? { size: 19, ...(headerCell ? { bold: true } : {}) } :
        caption ? { size: 19, italics: true, color: ink.muted } : quote ? { color: ink.muted } : {});
      if (task) {
        runs.unshift(new TextRun({ children: [task[1].toLowerCase() === 'x' ? '\u2611' : '\u2610', new Tab()], font: 'Segoe UI Symbol', color: ink.accent }));
        items.at(-1)!.pending = false;
      }
      appendParagraph(bookmark ? [new Bookmark({ id: bookmark, children: runs })] : runs, {
        heading,
        ...(task ? {
          indent: { left: indentation(), hanging: 360 },
          tabStops: [{ type: TabStopType.LEFT, position: indentation() }],
        } : {}),
        ...(currentCell ? { alignment: cellAlignment, spacing: { before: 0, after: 0, line: wordLineSpacing, lineRule: LineRuleType.AUTO }, keepNext: headerCell } : {}),
        ...(heading ? { spacing: undefined } : {}),
      });
    } else if (token.type === 'fence' || token.type === 'code_block') {
      if (token.type === 'fence' && isMermaidLanguage(token.info)) {
        const { data } = await diagramImage(token.content, loadDiagram);
        appendParagraph([imageRun(data, 'png', 'Mermaid diagram')], { spacing: { before: 160, after: 160 } });
        continue;
      }
      const lines: CodeSegment[][] = [[]];
      for (const segment of highlightedSegments(token.content.replace(/\n$/, ''), token.info.trim().split(/\s+/)[0])) {
        for (const [index, part] of segment.text.split('\n').entries()) {
          if (index) lines.push([]);
          if (part) lines.at(-1)!.push({ text: part, color: segment.color });
        }
      }
      for (const [index, line] of lines.entries()) {
        appendParagraph((line.length ? line : [{ text: ' ' }]).map(segment => new TextRun({
          children: segment.text.split(/(\t)/).map(part => part === '\t' ? new Tab() : part),
          color: segment.color, font: 'Consolas', size: 19,
        })), {
          shading: { fill: ink.code }, spacing: { before: index ? 0 : 160, after: index === lines.length - 1 ? 160 : 0, line: wordLineSpacing, lineRule: LineRuleType.AUTO },
          keepNext: false,
        });
      }
    } else if (token.type === 'hr') {
      appendParagraph([], { spacing: { before: 240, after: 240 }, border: { bottom: { color: ink.line, size: 6, style: BorderStyle.SINGLE } } });
    }
  }
  return Packer.toBuffer(new Document({
    creator: productName,
    title: tokens.find(token => token.type === 'inline' && token.level === 1)?.children?.map(child => child.content).join('') || 'Markdown document',
    styles,
    numbering: { config: numbering },
    sections: [{
      properties: { page: {
        size: { width: page.width, height: page.height },
        margin: { top: page.margin, bottom: page.margin, left: page.margin, right: page.margin },
      } },
      children: blocks.length ? blocks : [new Paragraph('')],
    }],
  }));
}

export function imageDimensions(data: Buffer, type: string): { width: number; height: number } {
  if (type === 'png' && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return checked(data.readUInt32BE(16), data.readUInt32BE(20));
  }
  if (type === 'gif' && data.length >= 10 && data.toString('ascii', 0, 3) === 'GIF') {
    return checked(data.readUInt16LE(6), data.readUInt16LE(8));
  }
  if (type === 'jpg' && data[0] === 255 && data[1] === 216) {
    let offset = 2;
    while (offset < data.length) {
      if (data[offset] !== 255) break;
      while (offset < data.length && data[offset] === 255) offset++;
      if (offset >= data.length) break;
      const marker = data[offset++];
      if (marker === 0x00 || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        return checked(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
      }
      offset += length;
    }
  }
  throw new Error('An image is invalid or its dimensions could not be read. Please use a standard PNG, JPEG, or GIF image.');
}

function checked(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0 || width > 100000 || height > 100000) throw new Error('Invalid image dimensions.');
  return { width, height };
}

export const printCSS = `
  @page { size: A4; margin: 20mm; }
  * { box-sizing: border-box; }
  html { background: white; }
  body { margin: 0; font: 11pt/1.85 "Segoe UI", Arial, sans-serif; color: #${ink.text}; overflow-wrap: anywhere; }
  body > :first-child { margin-top: 0; }
  p { margin: .8em 0; orphans: 2; widows: 2; }
  h1,h2,h3,h4,h5,h6 { font-weight: 600; line-height: 1.35; break-after: avoid; break-inside: avoid; }
  h1 { font-size: 25.5pt; margin: 0 0 16.5pt; }
  h2 { font-size: 16pt; margin: 30pt 0 11pt; }
  h3 { font-size: 13pt; margin: 21.5pt 0 9pt; }
  h4 { font-size: 11.5pt; margin: 18pt 0 8pt; }
  h5 { font-size: 11pt; margin: 16.5pt 0 7pt; }
  h6 { font-size: 10pt; margin: 15pt 0 6pt; }
  a { color: #${ink.accent}; text-decoration-thickness: 1px; text-underline-offset: 2px; }
  img { max-width: 100%; max-height: 240mm; height: auto; object-fit: contain; }
  table { width: 100%; table-layout: fixed; border-collapse: collapse; margin: 15pt 0; font-size: 9.5pt; line-height: 1.5; }
  th,td { border: 1px solid #${ink.line}; padding: 6pt 8pt; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #${ink.soft}; font-weight: 650; }
  th p,td p { margin: 0; }
  thead { display: table-header-group; } tr,img { break-inside: avoid; }
  ul,ol { padding-left: 18pt; }
  li { padding-left: 2pt; }
  li::marker { color: #${ink.accent}; }
  li > p { margin: 2.25pt 0; }
  li.task-item { list-style: none; position: relative; }
  .task-checkbox { position: absolute; left: -18pt; color: #${ink.accent}; font-family: "Segoe UI Symbol", sans-serif; }
  blockquote { border-left: 3px solid #${ink.accent}; margin: 18pt 0; padding: 2pt 15pt; background: #${ink.soft}; color: #${ink.muted}; }
  pre { background: #${ink.code}; border: 1px solid #${ink.line}; border-radius: 5px; padding: 10pt; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
  code { font: 9.5pt/1.5 Consolas, monospace; background: #${ink.code}; border-radius: 3px; padding: 1pt 3pt; }
  pre code { background: none; padding: 0; border-radius: 0; }
  hr { border: 0; border-top: 1px solid #${ink.line}; margin: 24pt 0; }
  figure.mermaid-diagram { margin: 12pt 0; }
  ${publishingCSS}
  .publishing-tablist { display: none; }
  .publishing-tab-panel[hidden],.publishing-tab-label { display: block; }
  .publishing-tabs { border: 0; border-radius: 0; overflow: visible; }
  .publishing-tab-panel { padding: 0; margin: 15pt 0; border-top: 0; }
  .publishing-zone { border: 0; padding-left: 0; }
  .publishing-tab-label,.publishing-zone-label { color: #${ink.accent}; background: #${ink.soft}; border-bottom: 1px solid #${ink.line}; font-size: 13pt; line-height: 1.5; padding: 6pt 8pt; margin: 15pt 0 7pt; }
  .publishing-callout-title,.publishing-tab-label,.publishing-zone-label,.publishing-selector-title { break-after: avoid; break-inside: avoid; }
  .publishing-variant-options { display: block; }
  .publishing-image figcaption { break-before: avoid; }
  ${syntaxCSS('pre')}
`;

async function renderExportHTML(
  markdown: string, documentPath: string | null, interactive: boolean,
  loadDiagram?: DiagramImageLoader, authorizedRoot?: string | null, validateRaster?: RasterValidator,
): Promise<string> {
  const tokens = parser.parse(markdown, {});
  if (!interactive) assertStaticExportSupported(tokens);
  if (tokens.filter(token => token.type === 'fence' && isMermaidLanguage(token.info)).length > diagramLimits.diagrams) throw new Error('An export supports at most 32 Mermaid diagrams.');
  const anchors = new Map<string, number>();
  const imageURLs = new Map<string, string>();
  const listItems: { token: Token; pending: boolean }[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'list_item_open') listItems.push({ token, pending: true });
    else if (token.type === 'list_item_close') listItems.pop();
    else if (token.type === 'inline' && listItems.at(-1)?.pending) {
      const item = listItems.at(-1)!;
      item.pending = false;
      const text = token.children?.[0];
      const task = text?.type === 'text' ? /^\[([ xX])\]\s+/.exec(text.content) : null;
      if (text && task) {
        text.content = text.content.slice(task[0].length);
        item.token.attrJoin('class', 'task-item');
        const checkbox = new Token('html_inline', '', 0);
        const checked = task[1].toLowerCase() === 'x';
        checkbox.content = `<span class="task-checkbox" aria-label="${checked ? 'Completed task' : 'Incomplete task'}">${checked ? '&#x2611;' : '&#x2610;'}</span>`;
        token.children!.unshift(checkbox);
      }
    }
    if (token.type === 'fence' && isMermaidLanguage(token.info)) {
      const { data } = await diagramImage(token.content, loadDiagram);
      token.type = 'html_block';
      token.content = `<figure class="mermaid-diagram"><img alt="Mermaid diagram" src="data:image/png;base64,${data.toString('base64')}"></figure>\n`;
    }
    if (token.type === 'heading_open') token.attrSet('id', headingAnchor(tokens[index + 1].content, anchors));
    for (const child of token.children ?? []) {
      if (child.type === 'image') {
        const source = child.attrGet('src') ?? '';
        let url = imageURLs.get(source);
        if (!url) {
          const { data, mime } = await readImage(source, documentPath, authorizedRoot);
          url = `data:${mime};base64,${data.toString('base64')}`;
          if (interactive) {
            embeddedImage(/^data:/i.test(source) ? source.replace(/[\r\n]/g, '') : url);
            if (mime !== 'image/webp') imageDimensions(data, mime === 'image/jpeg' ? 'jpg' : mime.slice(6));
            if (validateRaster) await validateRaster(data, mime);
          }
          imageURLs.set(source, url);
        }
        child.attrSet('src', url);
      }
    }
  }
  if (interactive) {
    const usedIds = new Set(tokens.map(token => token.attrGet('id')).filter((id): id is string => id !== null));
    const replacements = new Map<string, string>();
    let sequence = 0;
    for (const token of tokens) {
      if (token.type !== 'publishing_tabs_open') continue;
      const meta = token.meta as PublishingMeta;
      let candidate: string;
      let ids: string[];
      do {
        candidate = `lekh-export-tabs-${sequence++}`;
        ids = meta.labels!.flatMap((_, index) => [`${candidate}-tab-${index}`, `${candidate}-panel-${index}`]);
      } while (ids.some(id => usedIds.has(id)));
      ids.forEach(id => usedIds.add(id));
      replacements.set(meta.id!, candidate);
    }
    for (const token of tokens) {
      if (!token.type.startsWith('publishing_tab')) continue;
      const meta = token.meta as PublishingMeta;
      if (meta.id && replacements.has(meta.id)) meta.id = replacements.get(meta.id)!;
    }
  }
  return parser.renderer.render(tokens, { ...parser.options, highlight: highlightedHTML }, {
    publishingExport: true, publishingInteractive: interactive,
  });
}

export async function toPrintHTML(markdown: string, documentPath: string | null, loadDiagram?: DiagramImageLoader, authorizedRoot?: string | null): Promise<string> {
  const html = await renderExportHTML(markdown, documentPath, false, loadDiagram, authorizedRoot);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${escapeHTML(`${productName} export`)}</title><style>${printCSS}</style></head><body>${html}</body></html>`;
}

export async function toOfflineHTML(markdown: string, documentPath: string | null, loadDiagram?: DiagramImageLoader, authorizedRoot?: string | null, validateRaster?: RasterValidator): Promise<string> {
  const html = await renderExportHTML(markdown, documentPath, true, loadDiagram, authorizedRoot, validateRaster);
  const hash = createHash('sha256').update(interactiveExportScript, 'utf8').digest('base64');
  const policy = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><title>${escapeHTML(`${productName} export`)}</title><style>${interactiveExportCSS}</style></head><body><noscript><p class="offline-notice">JavaScript is disabled; all tabbed examples and variant content are shown.</p></noscript>${html}<script>${interactiveExportScript}</script></body></html>`;
}
