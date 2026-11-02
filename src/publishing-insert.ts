import type { JSONContent } from '@tiptap/core';
import { Fragment, type Node as ModelNode, type Schema } from '@tiptap/pm/model';
import { NodeSelection, Selection, type Transaction } from '@tiptap/pm/state';
import { parser } from '../lib/markdown.js';
import type { PublishingMeta } from '../lib/publishing.js';

const unreachableVariantMessage = 'Nested variant content must share at least one option with every enclosing variant. Choose a shared option or insert it outside the existing variant.';

export function variantInsertionPosition(selection: Selection): number | undefined {
  return selection instanceof NodeSelection && selection.node.isBlock ? selection.to : undefined;
}

function sharedVariants(variants: readonly string[], enclosing: readonly string[]): string[] {
  const shared = variants.filter(id => enclosing.includes(id));
  if (!shared.length) throw new Error(unreachableVariantMessage);
  return shared;
}

export function reachableVariantChoices(doc: ModelNode, position: number, variants: string[]): string[] {
  const zone = doc.nodeAt(position);
  if (!zone || zone.type.name !== 'lekhZone') throw new Error('The variant content could not be located for editing.');
  if (!variants.length) throw new Error('Variant content must apply to at least one option.');
  const resolved = doc.resolve(position);
  let reachable = variants;
  for (let depth = 1; depth <= resolved.depth; depth++) {
    const ancestor = resolved.node(depth);
    if (ancestor.type.name === 'lekhZone') reachable = sharedVariants(reachable, ancestor.attrs.variants);
  }
  return reachable;
}

export function validateVariantAssignment(doc: ModelNode, position: number, variants: string[]): string[] {
  const reachable = reachableVariantChoices(doc, position, variants);
  const zone = doc.nodeAt(position)!;
  const checkChildren = (node: ModelNode, allowed: string[]) => {
    node.forEach(child => {
      const next = child.type.name === 'lekhZone' ? sharedVariants(child.attrs.variants, allowed) : allowed;
      checkChildren(child, next);
    });
  };
  checkChildren(zone, reachable);
  return reachable;
}

export function validateSourceVariantInsertion(markdown: string, position: number): void {
  const line = markdown.slice(0, position).split('\n').length - 1;
  const enclosing: string[][] = [];
  let insertedDepth: number | undefined;
  for (const token of parser.parse(markdown, {})) {
    if (token.type === 'publishing_zone_open') {
      const variants = (token.meta as PublishingMeta).variants;
      if (!variants?.length) throw new Error('The variant content has no valid options.');
      const allowed = enclosing.length ? variants.filter(id => enclosing.at(-1)!.includes(id)) : variants;
      if (token.map?.[0] === line) insertedDepth = enclosing.length;
      if (insertedDepth !== undefined && !allowed.length) throw new Error(unreachableVariantMessage);
      enclosing.push(allowed);
    } else if (token.type === 'publishing_zone_close') {
      if (insertedDepth !== undefined && enclosing.length === insertedDepth + 1) return;
      enclosing.pop();
    }
  }
  throw new Error('Variant content could not be inserted as a Markdown block here. Place it in a paragraph outside a code block or directive marker.');
}

export function prepareVariantInsertion(schema: Schema, content: JSONContent[]): { content: Fragment; zone: ModelNode } {
  const nodes = content.map(node => schema.nodeFromJSON(node));
  const zone = nodes.find(node => node.type.name === 'lekhZone');
  if (!zone) throw new Error('The variant content could not be prepared for insertion.');
  return { content: Fragment.fromArray([...nodes, schema.nodes.paragraph.create()]), zone };
}

export function selectInsertedVariant(tr: Transaction, inserted: ModelNode): string[] {
  let position: number | undefined;
  tr.doc.descendants((node, offset) => {
    if (position !== undefined) return false;
    if (node === inserted || (node.type === inserted.type && node.attrs === inserted.attrs)) {
      position = offset;
      return false;
    }
    return true;
  });
  if (position === undefined) throw new Error('The new variant content could not be located for editing.');
  const selection = Selection.near(tr.doc.resolve(position + 1), 1);
  const variants: string[] = inserted.attrs.variants;
  const reachable = validateVariantAssignment(tr.doc, position, variants);
  tr.setSelection(selection);
  return reachable;
}
