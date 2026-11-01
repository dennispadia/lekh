import type MarkdownIt from 'markdown-it';
import Token from 'markdown-it/lib/token.mjs';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';
import { unescapeAll } from 'markdown-it/lib/common/utils.mjs';
import { publishingIcon } from './publishing-icons.js';

export type PublishingKind = 'callout' | 'tabs' | 'tab' | 'steps' | 'image' | 'caption' | 'metadata' | 'unsupported' | 'include' | 'zone' | 'selector';
export type PublishingMeta = {
  kind: PublishingKind;
  raw: string;
  variant?: string;
  title?: string;
  id?: string;
  labels?: string[];
  index?: number;
  label?: string;
  reason?: string;
  variants?: string[];
  options?: { id: string; label: string }[];
};

export const interactiveExportMessage = 'Word and PDF export are not supported for documents with tabbed examples or variants. Export to HTML to review them interactively offline.';

export function hasInteractivePublishing(tokens: readonly Token[]): boolean {
  return tokens.some(token => token.type === 'publishing_tabs_open' || token.type === 'publishing_selector' || token.type === 'publishing_zone_open');
}

export function assertStaticExportSupported(tokens: readonly Token[]): void {
  if (hasInteractivePublishing(tokens)) throw new Error(interactiveExportMessage);
}

const maxDepth = 12;
const maxTabs = 32;
const contextKey = Symbol('publishing');
type Context = { depth: number; sequence: number; original: Lines; variantLabels: Map<string, string> };
type Lines = {
  source: string;
  starts: number[];
  text: string[];
  closes: Map<number, number>;
  tabEnds: Map<number, number>;
  literal: Set<number>;
};
type Tab = { label: string; from: number; to: number };
type TabsGroup = { end: number; explicit: boolean; tabs: Tab[] };
type Block = {
  kind: PublishingKind;
  end: number;
  body?: string;
  bodyLine?: number;
  variant?: string;
  title?: string;
  tabs?: Tab[];
  attributes?: Record<string, string>;
  reason?: string;
  variants?: string[];
  options?: { id: string; label: string }[];
};
const stateLines = new WeakMap<StateBlock, Lines>();
const directivePattern = /^ {0,3}:::[ \t]*([a-z][\w-]*)(?:[ \t]+(.*?))?[ \t]*$/i;
const tabPattern = /^ {0,3}#{1,6}[ \t]+\[((?:\\.|[^\]\\\n])+)\]\(#tab\/([^\s)]+)\)[ \t]*$/i;
const calloutPattern = /^ {0,3}>[ \t]?\[!(NOTE|TIP|IMPORTANT|CAUTION|WARNING)\](?:[ \t]+(.*))?[ \t]*$/i;
const divisionPattern = /^ {0,3}>[ \t]?\[!div[ \t]+class=(?:"(checklist|nextstepaction)"|'(checklist|nextstepaction)')\](?:[ \t]+(.*))?[ \t]*$/i;
const includePattern = /^ {0,3}\[!INCLUDE\b/i;
const horizontalPattern = /^ {0,3}-{3,}[ \t]*$/;

function directive(line: string): { name: string; rest: string; selfClosing: boolean } | null {
  const match = directivePattern.exec(line);
  if (!match) return null;
  const rest = match[2] ?? '';
  return { name: match[1].toLowerCase(), rest: rest.replace(/[ \t]*:::[ \t]*$/, ''), selfClosing: /:::[ \t]*$/.test(rest) };
}

function opensBlock(item: NonNullable<ReturnType<typeof directive>>): boolean {
  return !item.selfClosing || item.name === 'image' && /\btype\s*=\s*["']?complex\b/i.test(item.rest);
}

function quotedCallout(read: (index: number) => string | undefined): { end: number; body: string } {
  const body: string[] = [];
  let fence: { character: string; length: number } | undefined;
  let comment = false;
  let cursor = 1;
  for (; ; cursor++) {
    const line = read(cursor);
    if (line === undefined) break;
    const quoted = /^ {0,3}>/.test(line);
    if (!quoted) {
      const next = read(cursor + 1) ?? '';
      if (line.trim() || !/^ {0,3}>/.test(next) ||
        (!fence && !comment && (calloutPattern.test(next) || divisionPattern.test(next)))) break;
    }
    if (!fence && !comment && (calloutPattern.test(line) || divisionPattern.test(line))) break;
    const content = quoted ? line.replace(/^ {0,3}>[ \t]?/, '') : '';
    body.push(content);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else {
      const state: { touched: boolean; open: boolean } = comments(content, comment);
      comment = state.open;
      if (!state.touched && marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
        fence = { character: marker[1][0], length: marker[1].length };
      }
    }
  }
  return { end: cursor, body: body.join('\n') };
}

function comments(line: string, open: boolean): { touched: boolean; open: boolean } {
  const markers = [...line.matchAll(/\\.|`+|<!--|-->/g)];
  const lastTicks = new Map<number, number>();
  for (const [index, marker] of markers.entries()) if (marker[0][0] === '`') lastTicks.set(marker[0].length, index);
  let code = 0;
  let touched = open;
  for (const [index, marker] of markers.entries()) {
    const text = marker[0];
    if (open) {
      if (text === '-->') open = false;
    } else if (text[0] === '`') {
      if (code === text.length) code = 0;
      else if (!code && lastTicks.get(text.length)! > index) code = text.length;
    } else if (!code && text === '<!--') {
      touched = true;
      open = true;
    }
  }
  return { touched, open };
}

function makeLines(source: string): Lines {
  const starts: number[] = [];
  const text: string[] = [];
  for (let position = 0; position < source.length;) {
    starts.push(position);
    const newline = source.indexOf('\n', position);
    const end = newline < 0 ? source.length : newline;
    text.push(source.slice(position, end).replace(/\r$/, ''));
    position = newline < 0 ? source.length : newline + 1;
  }
  starts.push(source.length);
  const result: Lines = { source, starts, text, closes: new Map(), tabEnds: new Map(), literal: new Set() };
  const openings = new Map<string, number[]>();
  let fence: { character: string; length: number } | undefined;
  let comment = false;
  for (const [index, line] of text.entries()) {
    if (!fence && !comment && /^(?: {4}|\t)/.test(line)) {
      result.literal.add(index);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      result.literal.add(index);
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    const commentState: { touched: boolean; open: boolean } = !comment && /^ {0,3}>/.test(line) ? { touched: false, open: false } : comments(line, comment);
    comment = commentState.open;
    if (commentState.touched) {
      result.literal.add(index);
      continue;
    }
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      result.literal.add(index);
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const item = directive(line);
    if (!item) continue;
    if (item.name.endsWith('-end')) {
      const start = openings.get(item.name.slice(0, -4))?.pop();
      if (start !== undefined) result.closes.set(start, index);
    } else if (opensBlock(item)) {
      const stack = openings.get(item.name) ?? [];
      stack.push(index);
      openings.set(item.name, stack);
    }
  }
  indexExplicitTabs(result);
  return result;
}

function indexExplicitTabs(lines: Lines): void {
  const create = (name = '') => ({ name, headers: Array.from({ length: 4 }, () => [] as number[]) });
  const containers = [create()];
  for (const [index, line] of lines.text.entries()) {
    if (lines.literal.has(index) || !line.trim()) continue;
    const container = containers.at(-1)!;
    const indent = line.length - line.trimStart().length;
    for (let level = indent + 1; level < 4; level++) container.headers[level] = [];
    if (tabPattern.test(line)) container.headers[indent].push(index);
    if (horizontalPattern.test(line)) {
      for (let level = 0; level <= indent; level++) {
        for (const start of container.headers[level]) lines.tabEnds.set(start, index);
        container.headers[level] = [];
      }
    }
    const item = directive(line);
    if (!item) continue;
    if (item.name.endsWith('-end')) {
      if (container.name === item.name.slice(0, -4)) containers.pop();
      else if (containers.length === 1) containers[0] = create();
    } else if (opensBlock(item) && (item.name !== 'image' || /\btype\s*=\s*["']?complex\b/i.test(item.rest))) {
      containers.push(create(item.name));
    }
  }
}

function rawRange(lines: Lines, start: number, end: number): string {
  return lines.source.slice(lines.starts[start] ?? lines.source.length, lines.starts[end] ?? lines.source.length);
}

function attributes(source: string): Record<string, string> | null {
  const result: Record<string, string> = {};
  const pattern = /([a-z][\w-]*)[ \t]*=[ \t]*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"'=<>`]+))/iy;
  let position = 0;
  while (position < source.length) {
    while (/[ \t]/.test(source[position] ?? '') && position < source.length) position++;
    if (position === source.length) break;
    pattern.lastIndex = position;
    const match = pattern.exec(source);
    if (!match || Object.hasOwn(result, match[1].toLowerCase())) return null;
    result[match[1].toLowerCase()] = (match[2] ?? match[3] ?? match[4]).replace(/\\(["'\\])/g, '$1');
    position = pattern.lastIndex;
  }
  return result;
}

function unsupported(end: number, reason: string, kind: PublishingKind = 'unsupported'): Block {
  return { kind, end, reason };
}

function frontmatter(lines: Lines, start: number, end: number): Block | null {
  if (start !== 0 || lines.text[0]?.trim() !== '---') return null;
  let candidate = 1;
  while (candidate < end && (!lines.text[candidate].trim() || lines.text[candidate].trim().startsWith('#'))) candidate++;
  if (!/^(?:[\w.-]+|"[^"]+"|'[^']+')[ \t]*:/.test(lines.text[candidate] ?? '')) return null;
  for (let line = 1; line < end; line++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines.text[line])) return { kind: 'metadata', end: line + 1 };
  }
  return unsupported(end, 'Unclosed document metadata; source retained.');
}

function docfxTabs(first: string, read: (index: number) => string | undefined, knownExplicit?: boolean): TabsGroup {
  const header = /^( *)(#+)/.exec(first)!;
  const indent = header[1].length;
  const level = header[2].length;
  const tabs: Tab[] = [{ label: publishingLabel(tabPattern.exec(first)![1]), from: 1, to: 1 }];
  const nested: string[] = [];
  let fence: { character: string; length: number } | undefined;
  let comment = false;
  let implicit: TabsGroup | undefined;
  const finish = (end: number, explicit = false) => {
    tabs.at(-1)!.to = end;
    return { end: end + Number(explicit), explicit, tabs };
  };
  for (let cursor = 1; ; cursor++) {
    const line = read(cursor);
    if (line === undefined) return implicit ?? finish(cursor);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (!comment && /^(?: {4}|\t)/.test(line)) continue;
    const commentState: { touched: boolean; open: boolean } = comments(line, comment);
    comment = commentState.open;
    if (commentState.touched || !line.trim()) continue;
    if (!nested.length && line.length - line.trimStart().length < indent) return implicit ?? finish(cursor);
    if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const item = directive(line);
    if (item) {
      if (item.name.endsWith('-end')) {
        if (nested.at(-1) === item.name.slice(0, -4)) nested.pop();
        else if (!nested.length) return implicit ?? finish(cursor);
      } else if (opensBlock(item) && (item.name !== 'image' || /\btype\s*=\s*["']?complex\b/i.test(item.rest))) {
        nested.push(item.name);
      }
      continue;
    }
    if (nested.length) continue;
    if (horizontalPattern.test(line)) return finish(cursor, true);
    const nextHeading = /^( {0,3})(#{1,6})(?:[ \t]+|$)/.exec(line);
    if (!nextHeading) continue;
    const tab = tabPattern.exec(line);
    if (tab && nextHeading[1].length === indent && nextHeading[2].length === level) {
      tabs.at(-1)!.to = cursor;
      tabs.push({ label: publishingLabel(tab[1]), from: cursor + 1, to: cursor + 1 });
    } else if (nextHeading[2].length <= level) {
      if (knownExplicit === false) return finish(cursor);
      if (!implicit) {
        implicit = { end: cursor, explicit: false, tabs: tabs.map(tab => ({ ...tab })) };
        implicit.tabs.at(-1)!.to = cursor;
      }
    }
  }
}

function inspect(lines: Lines, start: number, end: number, metadata: boolean): Block | null {
  const line = lines.text[start] ?? '';
  if (metadata) {
    const block = frontmatter(lines, start, end);
    if (block) return block;
  }
  const callout = calloutPattern.exec(line);
  const division = divisionPattern.exec(line);
  if (callout || division) {
    const scanned = quotedCallout(offset => start + offset < end ? lines.text[start + offset] : undefined);
    const variant = callout ? callout[1].toLowerCase() : division![1] ?? division![2];
    return {
      kind: 'callout', end: start + scanned.end, variant, title: callout?.[2]?.trim() || division?.[3]?.trim(),
      body: scanned.body, bodyLine: start + 1,
    };
  }
  if (includePattern.test(line)) return unsupported(start + 1, 'Local include directives are preserved but not loaded.', 'include');
  if (tabPattern.test(line)) {
    // Explicit terminators take priority over headings without rescanning later implicit groups.
    const group = docfxTabs(line, offset => start + offset < end ? lines.text[start + offset] : undefined,
      (lines.tabEnds.get(start) ?? Infinity) < end);
    const stop = start + group.end;
    if (!group.explicit && group.tabs.length < 2) return unsupported(stop, 'Unclosed tabs; add a --- terminator or a second panel. Source retained.');
    if (group.tabs.length > maxTabs) return unsupported(stop, 'Tabs exceed the 32-panel limit; source retained.');
    return { kind: 'tabs', end: stop, tabs: group.tabs.map(tab => ({ label: tab.label, from: start + tab.from, to: start + tab.to })) };
  }
  const item = directive(line);
  if (!item) return null;
  const close = lines.closes.get(start);
  const stop = close !== undefined && close < end ? close + 1 : !opensBlock(item) || item.name.endsWith('-end') ? start + 1 : end;
  if (item.name === 'zone') {
    const attrs = attributes(item.rest);
    const variants = (attrs?.pivot ?? attrs?.variants ?? '').split(',').map(value => value.trim());
    if (!attrs || Object.keys(attrs).some(key => !['pivot', 'variants'].includes(key)) ||
      variants.length > 32 || variants.some(value => !/^[a-z0-9][\w-]*$/i.test(value)) || close === undefined || close >= end) {
      return unsupported(stop, 'Zone not rendered: invalid variant IDs or missing :::zone-end. Source retained.');
    }
    return { kind: 'zone', end: stop, variants: [...new Set(variants)], body: rawRange(lines, start + 1, close), bodyLine: start + 1 };
  }
  if (item.name === 'selector') {
    const attrs = attributes(item.rest);
    if (!attrs || Object.keys(attrs).some(key => key !== 'title') || close === undefined || close >= end) {
      return unsupported(stop, 'Selector not rendered: invalid attributes or missing :::selector-end. Source retained.');
    }
    const options: { id: string; label: string }[] = [];
    for (let cursor = start + 1; cursor < close; cursor++) {
      if (!lines.text[cursor].trim()) continue;
      const option = /^ {0,3}[-*][ \t]+\[((?:\\.|[^\]\\])+)\]\(#variant\/([a-z0-9][\w-]*)\)[ \t]*$/i.exec(lines.text[cursor]);
      if (!option || options.some(value => value.id === option[2]) || options.length >= 32) {
        return unsupported(stop, 'Selector not rendered: use unique - [Label](#variant/id) options (at most 32). Source retained.');
      }
      options.push({ label: publishingLabel(option[1]), id: option[2] });
    }
    return options.length ? { kind: 'selector', end: stop, title: attrs.title ?? 'Content variants', options } :
      unsupported(stop, 'Selector not rendered: no variant options. Source retained.');
  }
  if (item.name === 'steps') {
    if (item.rest || close === undefined || close >= end) return unsupported(stop, 'Invalid or unclosed steps; use :::steps and :::steps-end. Source retained.');
    return { kind: 'steps', end: stop, body: rawRange(lines, start + 1, close), bodyLine: start + 1 };
  }
  if (item.name === 'tabs') {
    if (item.rest || close === undefined || close >= end) return unsupported(stop, 'Invalid or unclosed tabs; use :::tabs-end. Source retained.');
    const tabs: Tab[] = [];
    let cursor = start + 1;
    while (cursor < close) {
      if (!lines.text[cursor].trim()) { cursor++; continue; }
      const tab = directive(lines.text[cursor]);
      const tabClose = lines.closes.get(cursor);
      if (tab?.name !== 'tab' || !tab.rest.trim() || tabClose === undefined || tabClose >= close) {
        return unsupported(stop, 'Invalid tab panel; use :::tab Label and :::tab-end. Source retained.');
      }
      tabs.push({ label: tab.rest.trim(), from: cursor + 1, to: tabClose });
      if (tabs.length > maxTabs) return unsupported(stop, 'Tabs exceed the 32-panel limit; source retained.');
      cursor = tabClose + 1;
    }
    return tabs.length ? { kind: 'tabs', end: stop, tabs } : unsupported(stop, 'Tabs have no panels; source retained.');
  }
  if (item.name === 'image') {
    const attrs = attributes(item.rest);
    const type = attrs?.type ?? 'content';
    const complex = type === 'complex';
    const consumed = complex ? stop : start + 1;
    if (!attrs || !['content', 'complex', 'icon'].includes(type) || !attrs.source || !Object.hasOwn(attrs, 'alt-text') ||
      Object.keys(attrs).some(key => !['type', 'source', 'alt-text', 'border', 'caption'].includes(key)) ||
      attrs.border !== undefined && !['true', 'false'].includes(attrs.border) ||
      complex && (close === undefined || close >= end)) {
      return unsupported(consumed, 'Image directive not rendered: invalid attributes, missing source/alt-text, or unclosed complex description. Source retained.');
    }
    return {
      kind: 'image', end: consumed, attributes: attrs, variant: type,
      ...(complex ? { body: rawRange(lines, start + 1, close!), bodyLine: start + 1 } : {}),
    };
  }
  return unsupported(stop, 'Directive not rendered; original source retained.');
}

function prefixEnd(first: string, read: (index: number) => string | undefined): number {
  if (tabPattern.test(first)) return docfxTabs(first, read).end;
  const item = directive(first);
  if (includePattern.test(first) || item?.name.endsWith('-end') ||
    item && (item.selfClosing && item.name !== 'image' ||
      item.name === 'image' && !/\btype\s*=\s*["']?complex\b/i.test(item.rest))) {
    return 1;
  }
  const quote = calloutPattern.test(first) || divisionPattern.test(first);
  if (quote) return quotedCallout(read).end;
  const metadata = first.trim() === '---';
  let fence: { character: string; length: number } | undefined;
  let comment = false;
  let depth = 1;
  let cursor = 1;
  for (; ; cursor++) {
    const line = read(cursor);
    if (line === undefined) return cursor;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else {
      const commentState: { touched: boolean; open: boolean } = comments(line, comment);
      comment = commentState.open;
      if (commentState.touched) continue;
      if (marker && (marker[1][0] !== '`' || !marker[2].includes('`'))) fence = { character: marker[1][0], length: marker[1].length };
      else if (metadata && /^(---|\.\.\.)[ \t]*$/.test(line)) return cursor + 1;
      else if (item) {
        const nested = directive(line);
        if (nested?.name === item.name && opensBlock(nested)) depth++;
        if (nested?.name === `${item.name}-end` && --depth === 0) return cursor + 1;
      }
    }
  }
}

function sourceBlock(source: string): { raw: string; block: Block; lines: Lines } | null {
  const text: string[] = [];
  const starts = [0];
  const read = (index: number): string | undefined => {
    while (text.length <= index) {
      const position = starts.at(-1)!;
      if (position >= source.length) return undefined;
      const newline = source.indexOf('\n', position);
      text.push(source.slice(position, newline < 0 ? source.length : newline).replace(/\r$/, ''));
      starts.push(newline < 0 ? source.length : newline + 1);
    }
    return text[index];
  };
  const first = read(0) ?? '';
  if (!candidate(first)) return null;
  if (first.trim() === '---' && !/^(?:[ \t]*(?:#[^\n]*)?\r?\n)*(?:[\w.-]+|"[^"\r\n]+"|'[^'\r\n]+')[ \t]*:/.test(source.slice(starts[1]))) return null;
  // Only index this block, not the remaining article, for streaming tokenizers.
  const boundary = starts[prefixEnd(first, read)] ?? source.length;
  const lines = makeLines(source.slice(0, boundary));
  const block = inspect(lines, 0, lines.text.length, true);
  return block ? { raw: rawRange(lines, 0, block.end), block, lines } : null;
}

export function publishingLabel(value: string): string {
  return unescapeAll(value);
}

export type EditablePublishingBlock = {
  raw: string;
  kind: PublishingKind;
  body?: string;
  title?: string;
  variant?: string;
  variants?: string[];
  options?: { id: string; label: string }[];
  attributes?: Record<string, string>;
  syntax?: 'heading' | 'directive';
  panels?: { label: string; id: string; level: number; body: string }[];
};

/** Shared boundaries and validation keep editable blocks consistent with previews/exports. */
export function editablePublishingBlockAtStart(source: string): EditablePublishingBlock | null {
  const parsed = sourceBlock(source);
  if (!parsed) return null;
  const { raw, block, lines } = parsed;
  return {
    raw, kind: block.kind,
    body: block.kind === 'metadata' ? rawRange(lines, 1, block.end - 1) : block.body,
    title: block.title, variant: block.variant, variants: block.variants,
    options: block.options, attributes: block.attributes,
    ...(block.tabs ? {
      syntax: tabPattern.test(lines.text[0]) ? 'heading' as const : 'directive' as const,
      panels: block.tabs.map((tab, index) => {
        const header = lines.text[tab.from - 1];
        const match = tabPattern.exec(header);
        return { label: tab.label, id: match?.[2] ?? `example-${index + 1}`,
          level: /^ {0,3}(#{1,6})/.exec(header)?.[1].length ?? 1,
          body: rawRange(lines, tab.from, tab.to) };
      }),
    } : {}),
  };
}

/** Exact source consumed by a publishing node; ordinary Markdown is left alone. */
export function publishingBlockAtStart(source: string): { raw: string; kind: string } | null {
  const parsed = sourceBlock(source);
  return parsed ? { raw: parsed.raw, kind: parsed.block.kind } : null;
}

function candidate(line: string): boolean {
  return directivePattern.test(line) || tabPattern.test(line) || calloutPattern.test(line) ||
    divisionPattern.test(line) || includePattern.test(line) || line.trim() === '---';
}

/** A cheap start hint for block tokenizers. The tokenizer still validates the block. */
export function firstPublishingBlock(source: string): number {
  const pattern = /^(?: {0,3}(?::::[ \t]*[a-z]|\[!INCLUDE\b|#{1,6}[ \t]+\[[^\]\n]+\]\(#tab\/|>[ \t]?\[!(?:NOTE|TIP|IMPORTANT|CAUTION|WARNING|div)\b)|---[ \t]*\r?$)/gim;
  const match = pattern.exec(source);
  return match?.index ?? -1;
}

export function publishingBlockRanges(markdown: string): { from: number; to: number; raw: string; kind: string }[] {
  const lines = makeLines(markdown);
  const result: { from: number; to: number; raw: string; kind: string }[] = [];
  for (let cursor = 0; cursor < lines.text.length;) {
    const block = !lines.literal.has(cursor) && inspect(lines, cursor, lines.text.length, cursor === 0);
    if (!block) { cursor++; continue; }
    const raw = rawRange(lines, cursor, block.end);
    result.push({ from: lines.starts[cursor], to: lines.starts[block.end], raw, kind: block.kind });
    cursor = block.end;
  }
  return result;
}

function parseBody(state: StateBlock, source: string, firstLine: number, context: Context): void {
  const tokens: Token[] = [];
  context.depth++;
  try { state.md.block.parse(source, state.md, state.env, tokens); }
  finally { context.depth--; }
  for (const token of tokens) {
    token.level += state.level;
    if (token.map) token.map = [token.map[0] + firstLine, token.map[1] + firstLine];
    state.tokens.push(token);
  }
}

export function registerPublishing(parser: MarkdownIt): void {
  parser.core.ruler.before('normalize', 'publishing_source', state => {
    state.env[contextKey] = { depth: 0, sequence: 0, original: makeLines(state.src), variantLabels: new Map() } satisfies Context;
  });
  parser.core.ruler.after('block', 'publishing_variant_labels', state => {
    const context = state.env[contextKey] as Context;
    for (const token of state.tokens) {
      if (token.type !== 'publishing_zone_open') continue;
      const meta = token.meta as PublishingMeta;
      meta.label = meta.variants!.map(id => context.variantLabels.get(id) ??
        id.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase())).join(' / ');
    }
  });
  parser.block.ruler.before('blockquote', 'publishing', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false;
    const actual = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
    if (!candidate(actual)) return false;
    let lines = stateLines.get(state);
    if (!lines) {
      lines = makeLines(state.src);
      stateLines.set(state, lines);
    }
    if (lines.literal.has(start)) return false;
    const physical = lines;
    let offset = 0;
    let from = start;
    let until = end;
    // Blockquotes and lists can temporarily shift line starts in markdown-it.
    if (state.blkIndent || actual !== lines.text[start]?.trimStart()) {
      if (actual.trim() === '---') return false;
      const read = (index: number) => start + index < end &&
        (!index || !state.blkIndent || state.sCount[start + index] >= state.blkIndent || state.isEmpty(start + index))
        ? state.getLines(start + index, start + index + 1, state.blkIndent, true).replace(/\r?\n$/, '') : undefined;
      const consumed = prefixEnd(read(0)!, read);
      lines = makeLines(state.getLines(start, start + consumed, state.blkIndent, true));
      offset = start;
      from = 0;
      until = lines.text.length;
    }
    const context: Context = state.env[contextKey] ??= { depth: 0, sequence: 0, original: lines, variantLabels: new Map() };
    const block = inspect(lines, from, until, context.depth === 0 && state.parentType === 'root' && !offset);
    if (!block) return false;
    if (silent) return true;
    const stop = block.end + offset;
    const raw = context.depth === 0 ? rawRange(context.original, start, stop) : rawRange(physical, start, stop);
    const meta: PublishingMeta = { kind: block.kind, raw, variant: block.variant, title: block.title, reason: block.reason };
    if (context.depth >= maxDepth) {
      block.kind = 'unsupported';
      meta.kind = 'unsupported';
      meta.reason = 'Publishing nesting exceeds the 12-level limit; source retained.';
    }
    const push = (type: string, tag: string, nesting: -1 | 0 | 1, metadata = meta): Token => {
      const token = state.push(type, tag, nesting);
      token.map = [start, stop];
      token.meta = metadata;
      return token;
    };
    const body = () => parseBody(state, block.body ?? '', (block.bodyLine ?? from + 1) + offset, context);
    if (block.kind === 'unsupported' || block.kind === 'include') {
      push('publishing_unsupported', '', 0).content = raw;
    } else if (block.kind === 'metadata') {
      push('publishing_metadata', '', 0).content = raw;
    } else if (block.kind === 'selector') {
      meta.title = state.md.utils.unescapeAll(block.title!);
      meta.options = block.options!;
      for (const option of meta.options) context.variantLabels.set(option.id, option.label);
      push('publishing_selector', '', 0);
    } else if (block.kind === 'zone') {
      meta.variants = block.variants!;
      meta.label = meta.variants.map(value => context.variantLabels.get(value) ?? value.replace(/[-_]+/g, ' ').replace(/\b\w/g, value => value.toUpperCase())).join(' / ');
      push('publishing_zone_open', 'section', 1);
      body();
      push('publishing_zone_close', 'section', -1);
    } else if (block.kind === 'callout') {
      meta.title ||= ({ note: 'Note', tip: 'Tip', important: 'Important', caution: 'Caution', warning: 'Warning', checklist: 'Checklist', nextstepaction: 'Next step' })[block.variant!];
      push('publishing_callout_open', 'aside', 1);
      body();
      push('publishing_callout_close', 'aside', -1);
    } else if (block.kind === 'steps') {
      push('publishing_steps_open', 'section', 1);
      body();
      push('publishing_steps_close', 'section', -1);
    } else if (block.kind === 'tabs') {
      meta.id = `publishing-tabs-${context.sequence++}`;
      meta.labels = block.tabs!.map(tab => tab.label);
      push('publishing_tabs_open', 'section', 1);
      for (const [index, tab] of block.tabs!.entries()) {
        const panel: PublishingMeta = { kind: 'tab', raw: rawRange(lines, tab.from, tab.to), id: meta.id, index, label: tab.label };
        push('publishing_tab_open', 'section', 1, panel);
        parseBody(state, rawRange(lines, tab.from, tab.to), tab.from + offset, context);
        push('publishing_tab_close', 'section', -1, panel);
      }
      push('publishing_tabs_close', 'section', -1);
    } else if (block.kind === 'image') {
      const attrs = block.attributes!;
      const source = state.md.normalizeLink(state.md.utils.unescapeAll(attrs.source));
      if (!state.md.validateLink(source)) {
        meta.kind = 'unsupported';
        meta.reason = 'Image directive not rendered: unsafe image source. Source retained.';
        push('publishing_unsupported', '', 0).content = raw;
      } else {
        const figure = push('publishing_image_open', 'figure', 1);
        figure.attrSet('class', `publishing-image publishing-image-${block.variant}${attrs.border === 'true' ? ' publishing-image-bordered' : ''}`);
        const inline = state.push('inline', '', 0);
        inline.content = '';
        const image = new Token('image', 'img', 0);
        image.attrSet('src', source);
        image.attrSet('alt', '');
        image.content = state.md.utils.unescapeAll(attrs['alt-text']);
        const alt = new Token('text', '', 0);
        alt.content = image.content;
        image.children = [alt];
        inline.children = [image];
        if (attrs.caption) {
          push('publishing_caption_open', 'figcaption', 1, { kind: 'caption', raw: '' });
          const caption = state.push('inline', '', 0);
          caption.content = attrs.caption;
          caption.children = [];
          push('publishing_caption_close', 'figcaption', -1, { kind: 'caption', raw: '' });
        }
        if (block.body) body();
        push('publishing_image_close', 'figure', -1);
      }
    }
    state.line = stop;
    return true;
  }, { alt: ['paragraph', 'blockquote', 'list'] });

  parser.inline.ruler.before('html_inline', 'publishing_safe_inline', (state, silent) => {
    if (state.src[state.pos] !== '<') return false;
    const source = state.src.slice(state.pos);
    const br = /^<br[ \t]*\/?>/i.exec(source);
    if (br) {
      if (!silent) state.push('hardbreak', 'br', 0);
      state.pos += br[0].length;
      return true;
    }
    const script = /^<(sub|sup)>([^<\r\n]{1,2048})<\/\1>/i.exec(source);
    if (!script) return false;
    if (!silent) {
      const tag = script[1].toLowerCase();
      state.push(`publishing_${tag}_open`, tag, 1);
      state.push('text', '', 0).content = state.md.utils.unescapeAll(script[2]);
      state.push(`publishing_${tag}_close`, tag, -1);
    }
    state.pos += script[0].length;
    return true;
  });

  const escape = parser.utils.escapeHtml;
  parser.renderer.rules.publishing_callout_open = (tokens, index) => {
    const meta = tokens[index].meta as PublishingMeta;
    return `<aside class="publishing-callout publishing-callout-${escape(meta.variant!)}" role="note"><p class="publishing-callout-title">${publishingIcon(meta.variant!)}<span>${escape(meta.title!)}</span></p>\n`;
  };
  parser.renderer.rules.publishing_callout_close = () => '</aside>\n';
  parser.renderer.rules.publishing_steps_open = () => '<section class="publishing-steps" aria-label="Steps">\n';
  parser.renderer.rules.publishing_steps_close = () => '</section>\n';
  parser.renderer.rules.publishing_selector = (tokens, index, _options, env) => {
    const meta = tokens[index].meta as PublishingMeta;
    const accessibleLabel = escape(meta.title || 'Variant options');
    return `<section class="publishing-selector" data-publishing-selector="primary" aria-label="${accessibleLabel}"><p class="publishing-selector-title">${escape(meta.title!)}</p><div class="publishing-variant-options" role="group" aria-label="${accessibleLabel}">${meta.options!.map((option, panel) =>
      env.publishingExport && !env.publishingInteractive ? `<span class="publishing-variant-option">${escape(option.label)}</span>` :
        `<button type="button" data-publishing-variant="${escape(option.id)}" aria-pressed="${panel === 0}">${escape(option.label)}</button>`).join('')}</div></section>\n`;
  };
  parser.renderer.rules.publishing_zone_open = (tokens, index) => {
    const meta = tokens[index].meta as PublishingMeta;
    return `<section class="publishing-zone" data-publishing-zone="${escape(meta.variants!.join(','))}"><p class="publishing-zone-label">${escape(meta.label!)}</p>\n`;
  };
  parser.renderer.rules.publishing_zone_close = () => '</section>\n';
  parser.renderer.rules.publishing_tabs_open = (tokens, index, _options, env) => {
    const meta = tokens[index].meta as PublishingMeta;
    if (env.publishingExport && !env.publishingInteractive) return `<section class="publishing-tabs" data-publishing-tabs="${meta.id}">\n`;
    return `<section class="publishing-tabs" data-publishing-tabs="${meta.id}"><div class="publishing-tablist" role="tablist" aria-label="Content tabs">${meta.labels!.map((label, panel) =>
      `<button type="button" role="tab" id="${meta.id}-tab-${panel}" aria-controls="${meta.id}-panel-${panel}" aria-selected="${panel === 0}" tabindex="${panel ? '-1' : '0'}" data-publishing-tab="${panel}">${escape(label)}</button>`).join('')}</div>\n`;
  };
  parser.renderer.rules.publishing_tabs_close = () => '</section>\n';
  parser.renderer.rules.publishing_tab_open = (tokens, index, _options, env) => {
    const meta = tokens[index].meta as PublishingMeta;
    const staticExport = env.publishingExport && !env.publishingInteractive;
    return `<section class="publishing-tab-panel"${staticExport ? '' : ' role="tabpanel"'} id="${meta.id}-panel-${meta.index}"${staticExport ? '' : ` aria-labelledby="${meta.id}-tab-${meta.index}"`} data-publishing-panel="${meta.index}"${meta.index && !env.publishingExport ? ' hidden' : ''}><p class="publishing-tab-label">${escape(meta.label!)}</p>\n`;
  };
  parser.renderer.rules.publishing_tab_close = () => '</section>\n';
  parser.renderer.rules.publishing_metadata = (tokens, index, _options, env) => env.publishingExport ? '' :
    `<pre class="publishing-metadata">${escape(tokens[index].content)}</pre>\n`;
  parser.renderer.rules.publishing_unsupported = (tokens, index) =>
    `<aside class="publishing-unsupported" role="note"><p>${escape((tokens[index].meta as PublishingMeta).reason!)}</p><pre>${escape(tokens[index].content)}</pre></aside>\n`;
}

export const publishingCalloutPalette: Record<string, { background: string; border: string; darkBackground: string; darkBorder: string }> = {
  note: { background: '#efd9fd', border: '#3b2e58', darkBackground: '#3b2e58', darkBorder: '#efd9fd' },
  tip: { background: '#f1faf1', border: '#0e700e', darkBackground: '#054b16', darkBorder: '#dff6dd' },
  important: { background: '#ebf3fc', border: '#115ea3', darkBackground: '#004173', darkBorder: '#9ccbee' },
  caution: { background: '#fdf3f4', border: '#b10e1c', darkBackground: '#630001', darkBorder: '#fde7e9' },
  warning: { background: '#fff9f5', border: '#8a3707', darkBackground: '#4a1e04', darkBorder: '#fdcfb4' },
};
const lightCalloutRules = Object.entries(publishingCalloutPalette).map(([name, colors]) =>
  `.publishing-callout-${name} { --publishing-background: ${colors.background}; --publishing-border: ${colors.border}; }`).join('\n');

export const publishingCSS = `
.publishing-callout { --publishing-background: #f1f5f5; --publishing-border: #227c78; border: 0; border-left: 4px solid var(--publishing-border); border-radius: 0 6px 6px 0; background: var(--publishing-background); color: #161616; padding: 14px 18px; margin: 1.25em 0; }
.publishing-callout .publishing-callout-title { display: flex; align-items: center; gap: 8px; color: var(--publishing-border); font-weight: 650; line-height: 1.4; margin: 0 0 8px; }
.publishing-icon { display: inline-block; width: 18px; height: 18px; flex: 0 0 18px; vertical-align: middle; }
.publishing-callout-body > :first-child { margin-top: 0; }
.publishing-callout-body > :last-child { margin-bottom: 0; }
.publishing-callout > :last-child { margin-bottom: 0; }
${lightCalloutRules}
${Object.entries(publishingCalloutPalette).map(([name, colors]) =>
    `:root[data-theme="dark"] .publishing-callout-${name} { --publishing-background: ${colors.darkBackground}; --publishing-border: ${colors.darkBorder}; color: #fff; }`).join('\n')}
.publishing-callout-checklist ul { list-style-type: "\\2713  "; }
.publishing-callout-nextstepaction a { display: inline-block; font-weight: 650; }
.publishing-tabs { min-width: 0; color: var(--text, #263238); background: var(--paper, #fff); border: 1px solid var(--line, #dde5e5); border-radius: 6px; margin: 1em 0; overflow: hidden; }
.publishing-tablist { display: flex; flex-wrap: wrap; color: var(--text, #263238); border-bottom: 1px solid var(--line, #dde5e5); background: var(--soft, #f1f5f5); }
.publishing-tablist button { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; text-align: left; font: inherit; color: var(--text, #263238); background: transparent; padding: .65em .95em; border: 0; border-bottom: 3px solid transparent; cursor: pointer; }
.publishing-tablist button:hover { color: var(--text, #263238); background: var(--hover, #e2ede6); }
.publishing-tablist button[aria-selected="true"] { color: var(--text, #263238); background: var(--paper, #fff); border-bottom-color: var(--accent, #227c78); font-weight: 650; }
.publishing-tablist button:focus-visible { outline: 2px solid var(--accent, #227c78); outline-offset: -3px; }
.publishing-tab-panel { color: var(--text, #263238); padding: .5em 1em; }
.publishing-tab-panel[hidden] { display: none; }
.publishing-tab-label { display: none; font-weight: 700; margin-bottom: .5em; }
.publishing-steps { border-left: 2px solid #dde5e5; margin: 1em 0; padding-left: 1em; }
.publishing-steps > ol > li { padding-left: .5em; margin: .8em 0; }
.publishing-selector { color: var(--text, #263238); background: var(--soft, #f1f5f5); border: 1px solid var(--line, #dde5e5); border-radius: 6px; margin: 1em 0; padding: 14px 18px; }
.publishing-selector-title,.publishing-zone-label { font-weight: 700; margin: .4em 0; }
.publishing-variant-options { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.publishing-variant-options button { min-width: 0; max-width: 100%; overflow-wrap: anywhere; font: inherit; color: var(--text, #263238); border: 1px solid var(--muted, #52636b); border-radius: 4px; background: var(--paper, #fff); padding: .5em .8em; cursor: pointer; white-space: normal; }
.publishing-variant-options button[aria-pressed="true"] { color: #115ea3; background: #ebf3fc; border-color: #115ea3; font-weight: 650; }
.publishing-variant-options button:focus-visible { outline: 2px solid var(--accent, #227c78); outline-offset: 2px; }
:root[data-theme="dark"] .publishing-variant-options button[aria-pressed="true"] { color: #9ccbee; background: #002b49; border-color: #9ccbee; }
.publishing-variant-option + .publishing-variant-option::before { content: " / "; }
.publishing-zone { border-left: 2px solid #dde5e5; margin: 1em 0; padding-left: 1em; }
.publishing-zone[hidden] { display: none; }
.publishing-image { margin: 1em 0; }
.publishing-image img { max-width: 100%; height: auto; }
.publishing-image-icon img { width: 2em; max-height: 2em; object-fit: contain; }
.publishing-image-bordered img { border: 1px solid #dde5e5; }
.publishing-image figcaption { color: var(--muted, #607078); font-size: .9em; margin: .4em 0; }
.publishing-metadata,.publishing-unsupported { margin: 1em 0; border: 1px solid var(--line, #dde5e5); border-radius: 6px; padding: .75em 1em; }
.publishing-unsupported { border-color: #b7791f; background: #fff8e6; color: #263238; }
.publishing-metadata { white-space: pre-wrap; overflow-wrap: anywhere; font: .85em/1.6 Consolas, monospace; }
.publishing-unsupported pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .85em; }
.publishing-unsupported pre { background: #fff3d4; color: #263238; border-color: #b7791f; }
:root[data-theme="dark"] .publishing-unsupported { background: #3a2c17; color: #fff4df; border-color: #c69742; }
:root[data-theme="dark"] .publishing-unsupported pre { background: #241e13; color: #fff4df; border-color: #8c6c35; }
@media print {
  .publishing-metadata,.publishing-tablist { display: none !important; }
  .publishing-tab-panel[hidden],.publishing-tab-label { display: block !important; }
  .publishing-zone[hidden] { display: block !important; }
  .publishing-tabs { overflow: visible; }
  .publishing-tab-panel { border-top: 1px solid #dde5e5; }
  .publishing-callout-title,.publishing-tab-label { break-after: avoid; }
  .publishing-callout { color: #161616 !important; }
  ${Object.entries(publishingCalloutPalette).map(([name, colors]) =>
    `.publishing-callout-${name},:root[data-theme="dark"] .publishing-callout-${name} { --publishing-background: ${colors.background}; --publishing-border: ${colors.border}; }`).join('\n')}
}
`;
