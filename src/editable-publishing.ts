import { Extension, Node, type Editor, type JSONContent, type MarkdownParseHelpers, type MarkdownRendererHelpers, type MarkdownToken } from '@tiptap/core';
import type { Node as ModelNode, Schema } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { editablePublishingBlockAtStart, firstPublishingBlock, publishingLabel, type EditablePublishingBlock } from '../lib/publishing.js';
import { imageDisplayURL } from '../lib/markdown.js';
import { publishingIcon } from '../lib/publishing-icons.js';
import { choosePublishingVariant, initializePublishing, publishingHTML, refreshPublishingVariants } from './publishing-view.js';
import { containsResolvedReference, inlineDestinations, referenceDefinitions, snapshot, withoutSource } from './publishing-source.js';

interface Options {
  schema: (() => Schema) | null;
  documentId: string;
  reportError: (message: string) => void;
  addVariantContent: (position: number) => void;
}
export type VariantOption = { id: string; label: string };
const defaults: Options = { schema: null, documentId: '', reportError: message => console.error(message),
  addVariantContent: () => { throw new Error('Variant content insertion is unavailable.'); } };
let nextTabGroup = 0;
const idPattern = /^[a-z0-9][\w-]*$/i;
const names: Partial<Record<EditablePublishingBlock['kind'], string>> = {
  zone: 'lekhZone', steps: 'lekhSteps', tabs: 'lekhTabs', selector: 'lekhSelector',
  metadata: 'lekhMetadata', image: 'lekhImageDescription',
};

export function setPublishingEditable(editor: Editor, editable: boolean): void {
  editor.view.dom.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement>(
    '.publishing-editable input, .publishing-editable textarea, .publishing-editable button, .publishing-editable select, .publishing-block-tools button, .publishing-raw-editor',
  ).forEach(control => { control.disabled = !editable; });
}

export function documentVariantOptions(editor: Editor): VariantOption[] {
  const options = new Map<string, string>();
  editor.state.doc.descendants(node => {
    if (node.type.name === 'lekhSelector') for (const choice of variantOptions(node.attrs.options)) options.set(choice.id, choice.label);
  });
  return [...options].map(([id, label]) => ({ id, label }));
}

function variantOptions(value: unknown): VariantOption[] {
  if (!Array.isArray(value)) throw new Error('Variant choices must be a list.');
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || !('label' in item) ||
      typeof item.id !== 'string' || !idPattern.test(item.id) || typeof item.label !== 'string' || !item.label.trim()) {
      throw new Error('Variant choices require a stable ID and a nonempty label.');
    }
    return { id: item.id, label: item.label };
  });
}

function provenance() {
  return {
    sourceMarkdown: { default: null, rendered: false, parseHTML: () => null },
    sourceBaseline: { default: null, rendered: false, parseHTML: () => null },
    sourceHasReferences: { default: false, rendered: false, parseHTML: () => false },
    sourceDefinitions: { default: [], rendered: false, parseHTML: () => [] },
  };
}

function remember(node: JSONContent, raw: string, tokens: MarkdownToken[] = []): JSONContent {
  node.attrs = { ...node.attrs, sourceDefinitions: referenceDefinitions(tokens) };
  node.attrs = { ...node.attrs, sourceMarkdown: raw, sourceBaseline: JSON.stringify(withoutSource(node)),
    sourceHasReferences: containsResolvedReference(tokens) };
  return node;
}

function original(node: JSONContent, schema: Schema | null): string | null {
  if (node.attrs?.sourceHasReferences || typeof node.attrs?.sourceMarkdown !== 'string' ||
    typeof node.attrs?.sourceBaseline !== 'string') return null;
  try {
    if (snapshot(node, schema) === snapshot(JSON.parse(node.attrs.sourceBaseline) as JSONContent, schema)) {
      return node.attrs.sourceMarkdown.replace(/\r?\n$/, '');
    }
  } catch (error) {
    console.warn('Invalid publishing provenance was ignored; the editable model will be serialized.', error);
  }
  return null;
}

function body(node: JSONContent, helpers: MarkdownRendererHelpers): string {
  const rendered = (node.content ?? []).map((child, index) =>
    helpers.renderChild?.(node.attrs?.sourceHasReferences ? inlineDestinations(child) : child, index) ??
    helpers.renderChildren([node.attrs?.sourceHasReferences ? inlineDestinations(child) : child])).join('\n\n');
  const definitions: string[] = Array.isArray(node.attrs?.sourceDefinitions)
    ? node.attrs.sourceDefinitions.filter((item: unknown): item is string => typeof item === 'string') : [];
  return [...definitions.map(raw => raw.trimEnd()), rendered].filter(Boolean).join('\n\n');
}

const quote = (value: unknown) => String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
const label = (value: unknown) => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;').replace(/[\\[\]]/g, '\\$&');
function includeMarkdown(attrs: Record<string, unknown>): string {
  const source = String(attrs.source ?? '').replace(/[()<>\s&]/g, character => encodeURIComponent(character));
  return `[!INCLUDE [${label(attrs.label)}](${source})]`;
}
function tabId(value: string, used: Map<string, number>): string {
  const base = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'example';
  const count = used.get(base) ?? 0;
  used.set(base, count + 1);
  return `${base}${count ? `-${count + 1}` : ''}`;
}
function children(tokens: MarkdownToken[], helpers: MarkdownParseHelpers): JSONContent[] {
  const content = (helpers.parseBlockChildren ?? helpers.parseChildren)(tokens);
  return content.length ? content : [helpers.createNode('paragraph', undefined, [])];
}

type ViewContext = { editor: Editor; getPos: () => number | undefined; node: ModelNode; options: Options };
function viewContext(editor: Editor, getPos: () => number | undefined, initial: ModelNode, options: Options) {
  const context: ViewContext = { editor, getPos, node: initial, options };
  const set = (attrs: Record<string, unknown>) => {
    const position = getPos();
    if (!editor.isEditable || typeof position !== 'number' || editor.state.doc.nodeAt(position)?.type !== initial.type) {
      options.reportError('The editor is busy or this block changed. Retry in the intended document.');
      return;
    }
    editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...context.node.attrs, ...attrs }));
  };
  return { context, set };
}

function field(context: ViewContext, title: string, value: () => string, change: (value: string) => void, multiline = false, required = false) {
  const wrapper = document.createElement('label');
  wrapper.className = multiline ? 'publishing-field' : 'publishing-field publishing-inline-field';
  const caption = document.createElement('span');
  caption.textContent = title;
  const input = multiline ? document.createElement('textarea') : document.createElement('input');
  input.setAttribute('aria-label', title);
  input.placeholder = title;
  input.title = title;
  input.value = value();
  input.spellcheck = !/source|path|YAML/i.test(title);
  if (input instanceof HTMLTextAreaElement) input.rows = 5;
  wrapper.append(caption, input);
  input.addEventListener('focus', () => {
    if (context.editor.isEditable) context.editor.view.dispatch(closeHistory(context.editor.state.tr));
  });
  input.addEventListener('input', () => {
    if (!context.editor.isEditable) { input.value = value(); context.options.reportError('Wait for the current operation to finish before editing this block.'); return; }
    input.setCustomValidity(required && !input.value.trim() ? `Enter ${title.toLowerCase()}.` : '');
    if (input.validity.valid) change(input.value);
  });
  input.addEventListener('blur', () => {
    if (!input.validity.valid) { context.options.reportError(input.validationMessage); input.value = value(); input.setCustomValidity(''); }
    if (context.editor.isEditable) context.editor.view.dispatch(closeHistory(context.editor.state.tr));
  });
  input.addEventListener('keydown', event => {
    if (!(event instanceof KeyboardEvent)) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
      event.preventDefault(); event.stopPropagation();
      if (!context.editor.isEditable) { context.options.reportError('Wait for the current operation to finish before undoing.'); return; }
      if (event.shiftKey) context.editor.commands.redo(); else context.editor.commands.undo();
      if (input.isConnected) input.value = value();
    }
  });
  return { wrapper, input, refresh: () => {
    input.disabled = !context.editor.isEditable;
    const current = multiline ? value().replace(/\r\n/g, '\n') : value();
    if (input.value === current || document.activeElement === input && !input.validity.valid) return;
    const focused = document.activeElement === input;
    const from = input.selectionStart ?? 0; const to = input.selectionEnd ?? from;
    input.value = current;
    if (focused) input.setSelectionRange(Math.min(from, current.length), Math.min(to, current.length));
  } };
}

function tool(text: string, action: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
  return button;
}

function iconTool(title: string, symbol: string, action: () => void): HTMLButtonElement {
  const button = tool(symbol, action);
  button.className = 'publishing-icon-tool';
  button.setAttribute('aria-label', title);
  button.title = title;
  return button;
}

function choiceLabel(context: ViewContext, title: string, value: () => string, change: (value: string) => void, activate: () => void) {
  const name = field(context, title, value, change, false, true);
  name.wrapper.classList.add('publishing-choice-editor');
  name.wrapper.hidden = true;
  const button = tool(value(), activate);
  button.title = 'Click to show content. Double-click or press F2 to rename here.';
  let originalName = value();
  const rename = () => {
    if (!context.editor.isEditable) { context.options.reportError('Wait for the current operation to finish before renaming.'); return; }
    originalName = value();
    activate();
    button.hidden = true; name.wrapper.hidden = false;
    name.input.focus(); name.input.select();
  };
  button.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); rename(); });
  button.addEventListener('keydown', event => {
    if (event.key === 'F2') { event.preventDefault(); event.stopPropagation(); rename(); }
  });
  name.input.addEventListener('blur', () => { button.hidden = false; name.wrapper.hidden = true; });
  name.input.addEventListener('keydown', event => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') {
      name.input.setCustomValidity('');
      change(originalName);
      name.input.value = value();
    }
    name.input.blur(); button.focus();
  });
  return { button, name, refresh: () => { button.textContent = value(); button.disabled = !context.editor.isEditable; name.refresh(); } };
}

function paragraphAfter(context: ViewContext): HTMLButtonElement {
  return tool('Write after block', () => {
    const position = context.getPos();
    if (!context.editor.isEditable || typeof position !== 'number') {
      context.options.reportError('Wait for the current operation to finish before editing this block.'); return;
    }
    const end = position + context.node.nodeSize;
    const tr = closeHistory(context.editor.state.tr).insert(end, context.editor.schema.nodes.paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, end + 1));
    context.editor.view.dispatch(tr.scrollIntoView());
    context.editor.view.focus();
  });
}

function ignoreControls(dom: HTMLElement, contentDOM?: HTMLElement) {
  return {
    stopEvent: (event: Event) => {
      if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey) && !event.altKey &&
        event.key.toLowerCase() === 'z' && event.target instanceof Element && event.target.closest('button')) return false;
      return event.target instanceof Element && Boolean(event.target.closest('input, textarea, select, button'));
    },
    ignoreMutation: (mutation: { type: string; target: globalThis.Node }) => mutation.type !== 'selection' &&
      (!contentDOM || !contentDOM.contains(mutation.target) || mutation.target === dom ||
        mutation.type === 'attributes' && mutation.target === contentDOM),
  };
}

function container(name: string, kind: 'zone' | 'steps' | 'callout') {
  return Node.create<Options>({
    name, group: 'block', content: 'block+', defining: true,
    addOptions: () => defaults,
    addAttributes: () => ({ ...provenance(),
      variants: { default: ['first'], rendered: false, parseHTML: element => (element.getAttribute('data-publishing-zone') ?? 'first').split(','),
        validate: value => {
          if (!Array.isArray(value) || !value.length || value.length > 32 || value.some(id => typeof id !== 'string' || !idPattern.test(id)) ||
            new Set(value).size !== value.length) throw new Error('Variant content requires 1–32 unique existing IDs.');
        } },
      variant: { default: 'checklist', rendered: false, parseHTML: element => element.getAttribute('data-lekh-division') ?? 'checklist' },
      title: { default: '', rendered: false, parseHTML: element => element.getAttribute('data-publishing-title') ?? '' },
    }),
    parseHTML: () => [{ tag: `[data-lekh-container="${name}"]`, contentElement: '.publishing-editable-body' }],
    renderHTML: ({ node }) => ['section', { 'data-lekh-container': name,
      ...(kind === 'zone' ? { 'data-publishing-zone': node.attrs.variants.join(',') } : {}),
      ...(kind === 'callout' ? { 'data-lekh-division': node.attrs.variant, 'data-publishing-title': node.attrs.title } : {}),
    }, ['div', { class: 'publishing-editable-body' }, 0]],
    parseMarkdown: (token, helpers) => remember(helpers.createNode(name, {
      variants: token.variants ?? ['first'], variant: token.variant ?? 'checklist', title: token.title ?? '',
    }, children(token.tokens ?? [], helpers)), token.raw ?? '', token.tokens ?? []),
    renderMarkdown(node, helpers) {
      const raw = original(node, this.options.schema?.() ?? null);
      if (raw !== null) return raw;
      const content = body(node, helpers);
      if (kind === 'zone') return `:::zone pivot="${node.attrs?.variants.join(',')}"\n${content}\n:::zone-end`;
      if (kind === 'steps') return `:::steps\n${content}\n:::steps-end`;
      return `> [!div class="${quote(node.attrs?.variant)}"]${node.attrs?.title ? ` ${String(node.attrs.title).replace(/[\r\n]+/g, ' ')}` : ''}\n${content.split(/\r?\n/).map(line => line ? `> ${line}` : '>').join('\n')}`;
    },
    addNodeView() {
      const options = this.options;
      return ({ editor, node, getPos }) => {
        const { context, set } = viewContext(editor, getPos, node, options);
        const dom = document.createElement('section');
        dom.dataset.lekhContainer = name;
        dom.dataset.lekhEditableZone = kind === 'zone' ? 'true' : 'false';
        const header = document.createElement('div');
        header.contentEditable = 'false';
        header.className = 'publishing-edit-header';
        const title = document.createElement('strong');
        const heading = kind === 'callout'
          ? field(context, 'Block title', () => String(context.node.attrs.title), value => set({ title: value }))
          : null;
        if (heading) heading.input.placeholder = node.attrs.variant === 'checklist' ? 'Checklist' : 'Next step';
        const show = tool('Show and edit', () => {
          const pane = dom.closest<HTMLElement>('.document-pane');
          if (pane) choosePublishingVariant(pane, String(context.node.attrs.variants[0]));
        });
        const assignments = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Applies to…';
        const choices = document.createElement('div');
        assignments.append(summary, choices);
        header.append(heading?.wrapper ?? title, ...(kind === 'zone' ? [assignments, show] : []), paragraphAfter(context));
        const contentDOM = document.createElement('div');
        contentDOM.className = 'publishing-editable-body';
        dom.append(header, contentDOM);
        let signature = '';
        const refresh = () => {
          const current = context.node;
          if (kind === 'zone') {
            const available = documentVariantOptions(editor);
            const ids: string[] = current.attrs.variants;
            dom.className = 'publishing-zone publishing-editable';
            dom.dataset.publishingZone = ids.join(',');
            title.textContent = `Variant content · ${ids.map(id => available.find(option => option.id === id)?.label ?? id).join(' / ')}`;
            const next = JSON.stringify([available, ids]);
            if (signature !== next) {
              signature = next;
              choices.replaceChildren();
              for (const option of [...available, ...ids.filter(id => !available.some(option => option.id === id)).map(id => ({ id, label: id }))]) {
                const choice = document.createElement('label');
                const check = document.createElement('input');
                check.type = 'checkbox'; check.checked = ids.includes(option.id); check.disabled = !editor.isEditable;
                check.addEventListener('change', () => {
                  const variants = check.checked ? [...context.node.attrs.variants, option.id] : context.node.attrs.variants.filter((id: string) => id !== option.id);
                  if (!variants.length) { check.checked = true; options.reportError('Variant content must apply to at least one option.'); return; }
                  set({ variants });
                });
                choice.append(check, document.createTextNode(option.label)); choices.append(choice);
              }
            }
          } else if (kind === 'steps') {
            dom.className = 'publishing-steps publishing-editable'; title.textContent = 'Structured steps';
          } else {
            dom.className = `publishing-callout publishing-callout-${current.attrs.variant} publishing-editable`;
            title.textContent = current.attrs.title || (current.attrs.variant === 'checklist' ? 'Checklist' : 'Next step');
            heading?.refresh();
          }
          header.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !editor.isEditable; });
        };
        editor.on('update', refresh);
        refresh();
        return { dom, contentDOM, ...ignoreControls(dom, contentDOM),
          update: updated => { if (updated.type !== node.type) return false; context.node = updated; refresh(); return true; },
          destroy: () => editor.off('update', refresh),
        };
      };
    },
  });
}

const TabNode = Node.create<Options>({
  name: 'lekhTab', content: 'block+', defining: true, addOptions: () => defaults,
  addAttributes: () => ({ ...provenance(),
    label: { default: 'Example', rendered: false, parseHTML: element => element.getAttribute('data-tab-label') ?? 'Example' },
    id: { default: 'example', rendered: false, parseHTML: element => element.getAttribute('data-publishing-panel') ?? 'example' },
    level: { default: 1, rendered: false, parseHTML: element => Number(element.getAttribute('data-tab-level') ?? 1) },
  }),
  parseHTML: () => [{ tag: '[data-lekh-tab]', contentElement: '.publishing-editable-body' }],
  renderHTML: ({ node }) => ['section', { 'data-lekh-tab': '', 'data-tab-label': node.attrs.label, 'data-publishing-panel': node.attrs.id, 'data-tab-level': node.attrs.level },
    ['div', { class: 'publishing-editable-body' }, 0]],
  renderMarkdown: (node, helpers) => body(node, helpers),
  addNodeView() {
    const options = this.options;
    return ({ editor, node, getPos }) => {
      const { context } = viewContext(editor, getPos, node, options);
      const dom = document.createElement('section');
      dom.className = 'publishing-tab-panel'; dom.dataset.lekhTab = '';
      const contentDOM = document.createElement('div'); contentDOM.className = 'publishing-editable-body';
      dom.append(contentDOM);
      const refresh = () => {
        const position = getPos();
        dom.dataset.publishingPanel = String(typeof position === 'number' ? editor.state.doc.resolve(position).index() : 0);
        dom.dataset.publishingPanelId = String(context.node.attrs.id);
        dom.dataset.tabLabel = String(context.node.attrs.label);
      };
      refresh();
      return { dom, contentDOM, ...ignoreControls(dom, contentDOM),
        update: updated => { if (updated.type !== node.type) return false; context.node = updated; refresh(); return true; } };
    };
  },
});

const TabsNode = Node.create<Options>({
  name: 'lekhTabs', group: 'block', content: 'lekhTab+', defining: true, isolating: true,
  addOptions: () => defaults, addAttributes: () => ({ ...provenance(), syntax: { default: 'heading', rendered: false, parseHTML: element => element.getAttribute('data-tabs-syntax') ?? 'heading' } }),
  parseHTML: () => [{ tag: '[data-lekh-tabs]', contentElement: '.publishing-editable-panels' }],
  renderHTML: ({ node }) => ['section', { 'data-lekh-tabs': '', class: 'publishing-tabs', 'data-tabs-syntax': node.attrs.syntax }, ['div', { class: 'publishing-editable-panels' }, 0]],
  parseMarkdown: (token, helpers) => remember(helpers.createNode('lekhTabs', { syntax: token.syntax },
    (token.panels as MarkdownToken[]).map(panel => remember(helpers.createNode('lekhTab', {
      label: panel.label, id: panel.id, level: panel.level,
    }, children(panel.tokens ?? [], helpers)), '', panel.tokens ?? []))), token.raw ?? '', token.panels as MarkdownToken[]),
  renderMarkdown(node, helpers) {
    const raw = original(node, this.options.schema?.() ?? null);
    if (raw !== null) return raw;
    const usedIds = new Map<string, number>();
    const panels = (node.content ?? []).map(panel => {
      const content = body(panel, helpers);
      return node.attrs?.syntax === 'directive' ? `:::tab ${String(panel.attrs?.label).replace(/[\r\n]/g, ' ')}\n${content}\n:::tab-end`
        : `${'#'.repeat(Math.min(6, Math.max(1, Number(panel.attrs?.level))))} [${label(panel.attrs?.label)}](#tab/${tabId(String(panel.attrs?.label), usedIds)})\n\n${content}`;
    }).join('\n\n');
    return node.attrs?.syntax === 'directive' ? `:::tabs\n${panels}\n:::tabs-end` : `${panels}\n\n---`;
  },
  addNodeView() {
    const options = this.options;
    return ({ editor, node, getPos }) => {
      const { context } = viewContext(editor, getPos, node, options);
      const dom = document.createElement('section'); dom.className = 'publishing-tabs publishing-editable'; dom.dataset.lekhTabs = ''; dom.dataset.publishingTabs = ''; dom.dataset.publishingReady = 'true';
      const header = document.createElement('div'); header.contentEditable = 'false';
      const tabs = document.createElement('div'); tabs.className = 'publishing-tablist'; tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Content tabs');
      const tools = document.createElement('div'); tools.className = 'publishing-edit-tools';
      const contentDOM = document.createElement('div'); contentDOM.className = 'publishing-editable-panels';
      const groupId = `lekh-editable-tabs-${++nextTabGroup}`;
      let selected = 0;
      const select = (index: number) => {
        selected = index;
        dom.dataset.activeTab = String(index);
        for (const button of tabs.querySelectorAll<HTMLButtonElement>('[data-publishing-tab]')) {
          const active = Number(button.dataset.publishingTab) === index;
          button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
        }
        for (const [index, panel] of Array.from(contentDOM.children).entries()) if (panel instanceof HTMLElement) {
          panel.dataset.publishingPanel = String(index);
          panel.hidden = index !== selected;
          panel.id = `${groupId}-panel-${index}`;
          panel.setAttribute('role', 'tabpanel');
          panel.setAttribute('aria-labelledby', `${groupId}-tab-${index}`);
        }
      };
      const panelPosition = (index: number) => {
        const position = getPos();
        if (!editor.isEditable || typeof position !== 'number') { options.reportError('Wait for the current operation to finish.'); return undefined; }
        let found: number | undefined;
        context.node.forEach((panel, offset, current) => { if (current === index) found = position + 1 + offset; });
        const panel = context.node.maybeChild(index);
        if (found === undefined || !panel || !editor.state.doc.nodeAt(found)?.eq(panel)) {
          options.reportError('This tab changed. Retry in the intended document.'); return undefined;
        }
        return found;
      };
      const add = iconTool('Add tab', '+', () => {
        const position = getPos();
        if (!editor.isEditable || typeof position !== 'number') { options.reportError('Wait for the current operation to finish.'); return; }
        if (context.node.childCount >= 32) { options.reportError('A tab group can contain at most 32 examples.'); return; }
        let next = context.node.childCount + 1;
        const ids = new Set<string>(); context.node.forEach(child => ids.add(String(child.attrs.id)));
        while (ids.has(`example-${next}`)) next++;
        selected = context.node.childCount;
        const panel = editor.schema.nodes.lekhTab.create({ id: `example-${next}`, label: `Example ${next}` }, editor.schema.nodes.paragraph.create());
        const insertAt = position + context.node.nodeSize - 1;
        const tr = closeHistory(editor.state.tr).insert(insertAt, panel);
        tr.setSelection(TextSelection.create(tr.doc, insertAt + 2));
        editor.view.dispatch(tr.scrollIntoView()); editor.view.focus();
      });
      const remove = (index: number) => {
        const position = panelPosition(index);
        if (position === undefined) return;
        if (context.node.childCount === 1) { options.reportError('Keep at least one tab, or delete the entire group.'); return; }
        const panel = editor.state.doc.nodeAt(position)!;
        if (index < selected) selected--;
        else if (index === selected) selected = Math.max(0, index - 1);
        editor.view.dispatch(closeHistory(editor.state.tr).delete(position, position + panel.nodeSize));
        queueMicrotask(() => tabs.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
      };
      tools.append(paragraphAfter(context)); header.append(tabs); dom.append(header, contentDOM, tools);
      let signature = '';
      let labels: ReturnType<typeof choiceLabel>[] = [];
      const refresh = () => {
        const panels: { id: string; label: string }[] = [];
        context.node.forEach(panel => panels.push({ id: String(panel.attrs.id), label: String(panel.attrs.label) }));
        if (selected >= panels.length) selected = panels.length - 1;
        const next = JSON.stringify(panels.map(panel => panel.id));
        if (signature !== next) {
          signature = next; labels = []; tabs.replaceChildren();
          for (const [index, panel] of panels.entries()) {
            const item = document.createElement('div'); item.className = 'publishing-tab-item';
            const name = choiceLabel(context, `Tab name (${panel.id})`,
              () => String(context.node.child(index).attrs.label),
              value => {
                const position = panelPosition(index);
                if (position === undefined) return;
                const current = editor.state.doc.nodeAt(position)!;
                editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...current.attrs, label: value }));
              }, () => select(index));
            const button = name.button;
            button.dataset.publishingTab = String(index); button.dataset.tabId = panel.id; button.setAttribute('role', 'tab');
            button.id = `${groupId}-tab-${index}`; button.setAttribute('aria-controls', `${groupId}-panel-${index}`);
            button.addEventListener('keydown', event => {
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? panels.length - 1 :
                event.key === 'ArrowRight' ? (index + 1) % panels.length : event.key === 'ArrowLeft' ? (index + panels.length - 1) % panels.length : null;
              if (next !== null) { event.preventDefault(); select(next); tabs.querySelectorAll<HTMLButtonElement>('[data-publishing-tab]')[next].focus(); }
            });
            const close = iconTool('Remove tab', '\u00d7', () => remove(index));
            close.dataset.removeTab = panel.id;
            item.append(button, name.name.wrapper, close); tabs.append(item); labels.push(name);
          }
          tabs.append(add);
        }
        labels.forEach(label => label.refresh());
        tabs.querySelectorAll<HTMLButtonElement>('[data-remove-tab]').forEach(button => { button.disabled = !editor.isEditable; });
        add.disabled = !editor.isEditable;
        tools.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !editor.isEditable; });
        queueMicrotask(() => { if (dom.isConnected) select(selected); });
      };
      refresh();
      return { dom, contentDOM, ...ignoreControls(dom, contentDOM),
        update: updated => { if (updated.type !== node.type) return false; context.node = updated; refresh(); return true; } };
    };
  },
});

const SelectorNode = Node.create<Options>({
  name: 'lekhSelector', group: 'block', atom: true, addOptions: () => defaults,
  addAttributes: () => ({ ...provenance(),
    title: { default: 'Choose an option', rendered: false, parseHTML: element => element.getAttribute('data-selector-title') ?? 'Choose an option' },
    options: { default: [{ id: 'first', label: 'First option' }, { id: 'second', label: 'Second option' }], rendered: false,
      parseHTML: element => JSON.parse(element.getAttribute('data-selector-options') ?? '[]'),
      validate: value => { const choices = variantOptions(value); if (!choices.length || choices.length > 32 || new Set(choices.map(item => item.id)).size !== choices.length) throw new Error('Use 1–32 unique variant choices.'); } },
  }),
  parseHTML: () => [{ tag: '[data-lekh-selector]' }],
  renderHTML: ({ node }) => ['section', { 'data-lekh-selector': '', 'data-selector-title': node.attrs.title, 'data-selector-options': JSON.stringify(node.attrs.options) }],
  parseMarkdown: (token, helpers) => remember(helpers.createNode('lekhSelector', { title: token.title, options: token.options }), token.raw ?? ''),
  renderMarkdown(node) {
    return original(node, this.options.schema?.() ?? null) ?? `:::selector title="${quote(node.attrs?.title)}"\n${variantOptions(node.attrs?.options).map(option => `- [${label(option.label)}](#variant/${option.id})`).join('\n')}\n:::selector-end`;
  },
  addNodeView() {
    const options = this.options;
    return ({ editor, node, getPos }) => {
      const { context, set } = viewContext(editor, getPos, node, options);
      const dom = document.createElement('section'); dom.className = 'publishing-selector publishing-editable'; dom.dataset.lekhSelector = ''; dom.dataset.publishingSelector = 'editable'; dom.contentEditable = 'false'; dom.setAttribute('role', 'group');
      const title = field(context, 'Selector prompt', () => String(context.node.attrs.title), value => set({ title: value }), false, true);
      const controls = document.createElement('div'); controls.className = 'publishing-variant-options';
      const add = iconTool('Add option', '+', () => {
        const existing = documentVariantOptions(editor);
        if (context.node.attrs.options.length >= 32) { options.reportError('A selector can contain at most 32 options.'); return; }
        let next = 1; while (existing.some(option => option.id === `option-${next}`)) next++;
        set({ options: [...context.node.attrs.options, { id: `option-${next}`, label: `Option ${next}` }] });
      });
      const content = tool('Add variant content\u2026', () => {
        const position = context.getPos();
        if (!editor.isEditable || typeof position !== 'number') {
          options.reportError('Wait for the current operation to finish before adding variant content.'); return;
        }
        options.addVariantContent(position);
      });
      content.className = 'publishing-add-variant-content';
      content.title = 'Choose which options apply, then write their content directly below this selector.';
      dom.append(title.wrapper, controls, content, paragraphAfter(context));
      let idsSignature = ''; let fields: ReturnType<typeof choiceLabel>[] = [];
      const refresh = () => {
        dom.setAttribute('aria-label', String(context.node.attrs.title));
        title.refresh();
        const choices = variantOptions(context.node.attrs.options);
        const signature = choices.map(choice => choice.id).join(',');
        if (signature !== idsSignature) {
          idsSignature = signature; fields = []; controls.replaceChildren();
          for (const choice of choices) {
            const activate = () => { const pane = dom.closest<HTMLElement>('.document-pane'); if (pane) choosePublishingVariant(pane, choice.id); };
            const name = choiceLabel(context, `Option name (${choice.id})`, () => variantOptions(context.node.attrs.options).find(option => option.id === choice.id)!.label,
              value => set({ options: variantOptions(context.node.attrs.options).map(option => option.id === choice.id ? { ...option, label: value } : option) }), activate);
            const remove = iconTool('Remove option', '\u00d7', () => {
              let used = false;
              editor.state.doc.descendants(node => { if (node.type.name === 'lekhZone' && node.attrs.variants.includes(choice.id)) used = true; });
              if (used) { options.reportError('Reassign or remove the content for this option before removing it.'); return; }
              if (context.node.attrs.options.length === 1) { options.reportError('Keep at least one selector option.'); return; }
              set({ options: variantOptions(context.node.attrs.options).filter(option => option.id !== choice.id) });
              controls.querySelector<HTMLButtonElement>('[data-publishing-choice]')?.focus();
            });
            const button = name.button;
            button.dataset.publishingVariant = choice.id; button.dataset.publishingChoice = choice.id; button.dataset.publishingChoiceReady = 'true';
            const item = document.createElement('div'); item.className = 'publishing-variant-item';
            item.append(button, name.name.wrapper, remove); fields.push(name); controls.append(item);
          }
          controls.append(add);
        }
        fields.forEach(field => field.refresh());
        dom.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = !editor.isEditable; });
        queueMicrotask(() => { const pane = dom.closest<HTMLElement>('.document-pane'); if (pane) refreshPublishingVariants(pane); });
      };
      refresh();
      return { dom, ...ignoreControls(dom),
        update: updated => { if (updated.type !== node.type) return false; context.node = updated; refresh(); return true; } };
    };
  },
});

const MetadataNode = Node.create<Options>({
  name: 'lekhMetadata', group: 'block', atom: true, addOptions: () => defaults,
  addAttributes: () => ({ ...provenance(), yaml: { default: '', rendered: false, parseHTML: element => element.textContent ?? '' } }),
  parseHTML: () => [{ tag: '[data-lekh-metadata]' }],
  renderHTML: ({ node }) => ['pre', { 'data-lekh-metadata': '' }, String(node.attrs.yaml)],
  parseMarkdown: (token, helpers) => remember(helpers.createNode('lekhMetadata', { yaml: token.body ?? '' }), token.raw ?? ''),
  renderMarkdown(node) { return original(node, this.options.schema?.() ?? null) ?? `---\n${String(node.attrs?.yaml).trimEnd()}\n---`; },
  addNodeView() {
    const options = this.options;
    return ({ editor, node, getPos }) => {
      const { context, set } = viewContext(editor, getPos, node, options);
      const dom = document.createElement('section'); dom.className = 'publishing-metadata-block publishing-editable'; dom.contentEditable = 'false';
      const yaml = field(context, 'Metadata YAML', () => String(context.node.attrs.yaml), value => {
        const first = value.split(/\r?\n/).find(line => line.trim() && !line.trimStart().startsWith('#')) ?? '';
        const error = /^(?:---|\.\.\.)[ \t]*$/m.test(value) ? 'Metadata delimiter lines belong outside the YAML fields.' :
          !/^(?:[\w.-]+|"[^"]+"|'[^']+')[ \t]*:/.test(first) ? 'Keep at least one name: value metadata field, or delete the metadata block.' : '';
        yaml.input.setCustomValidity(error);
        if (!error) set({ yaml: value });
      }, true);
      yaml.wrapper.dataset.lekhMetadata = '';
      yaml.input.placeholder = 'Add YAML metadata…';
      yaml.wrapper.querySelector('span')?.remove();
      dom.append(yaml.wrapper);
      return { dom, ...ignoreControls(dom),
        update: updated => { if (updated.type !== node.type) return false; context.node = updated; yaml.refresh(); return true; } };
    };
  },
});

const IncludeNode = Node.create<Options>({
  name: 'lekhInclude', group: 'block', atom: true, addOptions: () => defaults,
  addAttributes: () => ({ ...provenance(), label: { default: 'Shared content', rendered: false, parseHTML: element => element.getAttribute('data-include-label') ?? 'Shared content' },
    source: { default: './includes/shared.md', rendered: false, parseHTML: element => element.getAttribute('data-include-source') ?? '' } }),
  parseHTML: () => [{ tag: '[data-lekh-include]' }],
  renderHTML: ({ node }) => ['section', { 'data-lekh-include': '', 'data-include-label': node.attrs.label, 'data-include-source': node.attrs.source }],
  parseMarkdown: (token, helpers) => remember(helpers.createNode('lekhInclude', { label: token.label, source: token.source }), token.raw ?? ''),
  renderMarkdown(node) { return original(node, this.options.schema?.() ?? null) ?? includeMarkdown(node.attrs ?? {}); },
  addNodeView() {
    const options = this.options;
    return ({ editor, node, getPos }) => {
      const { context, set } = viewContext(editor, getPos, node, options);
      const dom = document.createElement('section'); dom.className = 'publishing-include publishing-editable'; dom.dataset.lekhInclude = ''; dom.contentEditable = 'false';
        const title = document.createElement('strong'); title.textContent = 'Include directive (not loaded)';
        const name = field(context, 'Include name', () => String(context.node.attrs.label), value => set({ label: value }), false, true);
        const source = field(context, 'Include path', () => String(context.node.attrs.source), value => set({ source: value }), false, true);
        const hint = document.createElement('p'); hint.className = 'publishing-field-hint'; hint.textContent = 'The directive is preserved in Markdown. Referenced files are not opened or included.';
        dom.append(title, name.wrapper, source.wrapper, hint, paragraphAfter(context));
        return { dom, ...ignoreControls(dom),
          update: updated => {
            if (updated.type !== node.type) return false;
            context.node = updated; name.refresh(); source.refresh();
            return true;
          },
        };
    };
  },
});

const ImageDescriptionNode = Node.create<Options>({
  name: 'lekhImageDescription', group: 'block', content: 'block*', defining: true, addOptions: () => defaults,
  addAttributes: () => ({ ...provenance(),
    source: { default: '', rendered: false, parseHTML: element => element.getAttribute('data-image-source') ?? '' },
    alt: { default: '', rendered: false, parseHTML: element => element.getAttribute('data-image-alt') ?? '' },
    caption: { default: '', rendered: false, parseHTML: element => element.getAttribute('data-image-caption') ?? '' },
    imageType: { default: 'content', rendered: false, parseHTML: element => element.getAttribute('data-image-type') ?? 'content' },
    border: { default: '', rendered: false, parseHTML: element => element.getAttribute('data-image-border') ?? '' },
  }),
  parseHTML: () => [{ tag: '[data-lekh-described-image]', contentElement: '.publishing-editable-body' }],
  renderHTML: ({ node }) => ['figure', { 'data-lekh-described-image': '', 'data-image-source': node.attrs.source, 'data-image-alt': node.attrs.alt, 'data-image-caption': node.attrs.caption, 'data-image-type': node.attrs.imageType, 'data-image-border': node.attrs.border },
    ['div', { class: 'publishing-editable-body' }, 0]],
  parseMarkdown: (token, helpers) => remember(helpers.createNode('lekhImageDescription', {
    source: token.attributes.source, alt: token.attributes['alt-text'], caption: token.attributes.caption ?? '',
    imageType: token.attributes.type ?? 'content', border: token.attributes.border ?? '',
  }, token.tokens?.length ? children(token.tokens, helpers) : []), token.raw ?? '', token.tokens ?? []),
  renderMarkdown(node, helpers) {
    const raw = original(node, this.options.schema?.() ?? null);
    if (raw !== null) return raw;
    const opening = `:::image type="${quote(node.attrs?.imageType)}" source="${quote(node.attrs?.source)}" alt-text="${quote(node.attrs?.alt)}"${node.attrs?.caption ? ` caption="${quote(node.attrs.caption)}"` : ''}${node.attrs?.border ? ` border="${quote(node.attrs.border)}"` : ''}:::`;
    return node.attrs?.imageType === 'complex' ? `${opening}\n${body(node, helpers)}\n:::image-end` : opening;
  },
  addNodeView() {
    const options = this.options;
    return ({ editor, node, getPos }) => {
      const { context, set } = viewContext(editor, getPos, node, options);
      const dom = document.createElement('figure'); dom.className = 'publishing-image publishing-editable'; dom.dataset.lekhDescribedImage = '';
      const form = document.createElement('div'); form.contentEditable = 'false';
      const image = document.createElement('img');
      const fields = [['source', 'Image source'], ['alt', 'Alternate text'], ['caption', 'Image caption']] as const;
      const inputs = fields.map(([key, title]) => field(context, title, () => String(context.node.attrs[key]), value => set({ [key]: value }), false, key === 'source'));
      const description = tool('Add long description', () => {
        const position = getPos();
        if (!editor.isEditable || typeof position !== 'number') { options.reportError('Wait for the current operation to finish.'); return; }
        const tr = editor.state.tr.setNodeMarkup(position, undefined, { ...context.node.attrs, imageType: 'complex' });
        if (!context.node.content.size) tr.insert(position + 1, editor.schema.nodes.paragraph.create());
        tr.setSelection(TextSelection.near(tr.doc.resolve(position + 1)));
        editor.view.dispatch(closeHistory(tr)); editor.view.focus();
      });
      const settings = document.createElement('details'); settings.className = 'publishing-advanced';
      const settingsTitle = document.createElement('summary'); settingsTitle.textContent = 'Image source and alternate text';
      settings.append(settingsTitle, inputs[0].wrapper, inputs[1].wrapper);
      form.append(image, inputs[2].wrapper, settings, description, paragraphAfter(context));
      const contentDOM = document.createElement('div'); contentDOM.className = 'publishing-editable-body'; dom.append(form, contentDOM);
      const refresh = () => {
        image.src = imageDisplayURL(String(context.node.attrs.source), options.documentId); image.alt = String(context.node.attrs.alt);
        contentDOM.hidden = context.node.attrs.imageType !== 'complex'; description.hidden = context.node.attrs.imageType === 'complex'; inputs.forEach(field => field.refresh());
      };
      refresh();
      return { dom, contentDOM, ...ignoreControls(dom, contentDOM),
        update: updated => { if (updated.type !== node.type) return false; context.node = updated; refresh(); return true; } };
    };
  },
});

export const EditablePublishing = Extension.create<Options>({
  name: 'editablePublishing', addOptions: () => defaults,
  addExtensions() {
    const tokenizer = Node.create({
      // Marked prepends registrations; register after the opaque fallback.
      name: 'lekhPublishingTokenizer', group: 'block', atom: true, priority: 90,
      renderHTML: () => ['div'],
      markdownTokenizer: (() => {
        let depth = 0;
        return { name: 'lekhPublishingTokenizer', level: 'block' as const, start: firstPublishingBlock,
          tokenize: (source: string, _tokens: MarkdownToken[], lexer: { blockTokens: (source: string) => MarkdownToken[] }) => {
            const block = editablePublishingBlockAtStart(source);
            if (!block || block.kind === 'unsupported' || block.kind === 'callout' && !['checklist', 'nextstepaction'].includes(block.variant ?? '')) return undefined;
            if (depth >= 12) return undefined;
            const include = block.kind === 'include' ? /^ {0,3}\[!INCLUDE[ \t]+\[((?:\\.|[^\]\\])+)\]\(([^\r\n]*)\)\][ \t]*(?:\r?\n|$)/i.exec(block.raw) : null;
            if (block.kind === 'include' && !include) return undefined;
            const type = block.kind === 'include' ? 'lekhInclude' : block.kind === 'callout' ? 'lekhDivision' : names[block.kind];
            if (!type) return undefined;
            depth++;
            try {
              return { ...block, type, ...(include ? { label: publishingLabel(include[1]), source: publishingLabel(include[2].replace(/^<(.*)>$/, '$1')).replace(/\\ /g, ' ') } : {}),
                ...(block.body !== undefined && block.kind !== 'metadata' ? { tokens: lexer.blockTokens(block.body) } : {}),
                ...(block.panels ? { panels: block.panels.map(panel => ({ ...panel, type: 'lekhTab', tokens: lexer.blockTokens(panel.body) })) } : {}) };
            } finally { depth--; }
          } };
      })(),
    });
    return [tokenizer, container('lekhZone', 'zone'), container('lekhSteps', 'steps'), container('lekhDivision', 'callout'),
      TabsNode, TabNode, SelectorNode, MetadataNode, IncludeNode, ImageDescriptionNode].map(extension => extension.configure(this.options));
  },
});
