export interface OutlineHeading { level: number; line: number; root?: boolean }

const movable = (heading: OutlineHeading) => heading.root !== false;

/** Line range [start, end) of the section headed by `headings[index]`, including its subsections. */
export function sectionRange(headings: readonly OutlineHeading[], index: number, lineCount: number): [number, number] {
  const { level, line } = headings[index];
  const next = headings.slice(index + 1).find(heading => movable(heading) && heading.level <= level);
  return [line, next ? next.line : lineCount];
}

/** Index of the first heading after the section headed by `headings[index]`, or `headings.length`. */
export function sectionEndIndex(headings: readonly OutlineHeading[], index: number): number {
  const next = headings.findIndex((heading, other) => other > index && movable(heading) && heading.level <= headings[index].level);
  return next < 0 ? headings.length : next;
}

/** Index of the previous or next heading at the same level within the same parent section, if any. */
export function siblingSection(headings: readonly OutlineHeading[], index: number, direction: -1 | 1): number | undefined {
  const level = headings[index].level;
  for (let other = index + direction; other >= 0 && other < headings.length; other += direction) {
    if (!movable(headings[other])) continue;
    if (headings[other].level < level) return undefined;
    if (headings[other].level === level) return other;
  }
  return undefined;
}

/** Whether a heading can be moved from the outline; headings inside lists, quotes, zones or tabs cannot. */
export function canMoveSection(headings: readonly OutlineHeading[], index: number): boolean {
  return index >= 0 && index < headings.length && movable(headings[index]);
}

function joinSection(lines: string[]): string[] {
  return lines.length && lines[lines.length - 1].trim() ? [...lines, ''] : lines;
}

/**
 * Moves the section headed by `headings[index]` so it starts where `headings[target]` starts,
 * or to the end of the document when `target` equals `headings.length`.
 * `blocks` are top-level container line ranges that a move must never split.
 * Returns the new markdown and the moved heading's new line, or undefined when the move is not allowed.
 */
export function relocateSection(markdown: string, headings: readonly OutlineHeading[], index: number, target: number, blocks: readonly [number, number][] = []): { markdown: string; line: number } | undefined {
  if (index < 0 || index >= headings.length || target < 0 || target > headings.length) return undefined;
  if (!movable(headings[index]) || (target < headings.length && !movable(headings[target]))) return undefined;
  const lines = markdown.split('\n');
  const [start, end] = sectionRange(headings, index, lines.length);
  const destination = target === headings.length ? lines.length : headings[target].line;
  if (destination >= start && destination <= end) return undefined;
  const topLevel = (line: number) => !/^[\s>|]/.test(lines[line] ?? '');
  if (!topLevel(start) || (target < headings.length && !topLevel(destination))) return undefined;
  for (const [blockStart, blockEnd] of blocks) {
    const overlaps = blockStart < end && blockEnd > start;
    if (overlaps && (blockStart < start || blockEnd > end)) return undefined;
    if (blockStart < destination && destination < blockEnd) return undefined;
  }
  const trailingNewline = markdown.endsWith('\n');
  const body = trailingNewline ? lines.slice(0, -1) : lines;
  const section = joinSection(body.slice(start, Math.min(end, body.length)));
  const remaining = [...body.slice(0, start), ...body.slice(Math.min(end, body.length))];
  const insertAt = destination > start ? destination - (Math.min(end, body.length) - start) : destination;
  const before = remaining.slice(0, insertAt);
  const after = remaining.slice(insertAt);
  const prefix = target === headings.length ? joinSection(before) : before;
  const result = [...prefix, ...section, ...after];
  while (result.length > 1 && !result[result.length - 1].trim()) result.pop();
  return { markdown: result.join('\n') + (trailingNewline ? '\n' : ''), line: prefix.length };
}

export function moveSectionTo(markdown: string, headings: readonly OutlineHeading[], index: number, target: number, blocks: readonly [number, number][] = []): string | undefined {
  return relocateSection(markdown, headings, index, target, blocks)?.markdown;
}

/** Target index for swapping a section with its previous (-1) or next (+1) sibling, if any. */
export function siblingTarget(headings: readonly OutlineHeading[], index: number, direction: -1 | 1): number | undefined {
  const sibling = siblingSection(headings, index, direction);
  if (sibling === undefined) return undefined;
  if (direction < 0) return sibling;
  const after = siblingSection(headings, sibling, 1);
  const parentEnd = headings.slice(sibling + 1).findIndex(heading => movable(heading) && heading.level < headings[index].level);
  return after ?? (parentEnd < 0 ? headings.length : sibling + 1 + parentEnd);
}

/** Swaps a section with its previous (-1) or next (+1) sibling. */
export function moveSection(markdown: string, headings: readonly OutlineHeading[], index: number, direction: -1 | 1, blocks: readonly [number, number][] = []): string | undefined {
  const target = siblingTarget(headings, index, direction);
  return target === undefined ? undefined : moveSectionTo(markdown, headings, index, target, blocks);
}