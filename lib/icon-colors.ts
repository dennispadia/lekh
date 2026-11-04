export type IconTone = 'format' | 'insert' | 'review' | 'navigation' | 'note' | 'tip' | 'important' | 'caution' | 'warning';
const groups: Record<string, IconTone> = {
  bold: 'format', italic: 'format', strike: 'format', code: 'format', bullet: 'format', ordered: 'format',
  task: 'format', quote: 'format', steps: 'format', checklist: 'format',
  plus: 'insert', folder: 'insert', image: 'insert', table: 'insert', link: 'insert', codeblock: 'insert',
  contents: 'insert', refresh: 'insert', diagram: 'insert', blocks: 'insert', block: 'insert',
  rule: 'insert', metadata: 'insert', include: 'insert', tabs: 'insert', selector: 'insert', nextstepaction: 'insert',
  save: 'insert', export: 'insert', html: 'insert', word: 'format', pdf: 'caution',
  delete: 'caution',
  check: 'review', learn: 'review', help: 'review', command: 'review',
  note: 'note', tip: 'tip', important: 'important', caution: 'caution', warning: 'warning',
};
export function iconTone(name: string): IconTone { return Object.hasOwn(groups, name) ? groups[name] : 'navigation'; }
