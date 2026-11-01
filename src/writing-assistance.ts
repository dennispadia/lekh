import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { maxGrammarCharacters, type GrammarIssue, type GrammarRequest, type GrammarResponse } from '../lib/grammar.js';
import { setGrammarHighlights, visualGrammarRange, visualGrammarSnapshot, type VisualGrammarSnapshot } from './grammar-highlights.js';

interface WritingContext {
  id: string;
  markdown: string;
  mode: 'visual' | 'source';
  editor: Editor;
  source: HTMLTextAreaElement;
  pane: HTMLElement;
}
interface Options {
  context: () => WritingContext | undefined;
  applySource: (from: number, to: number, replacement: string) => void;
  report: (message: string) => void;
}
interface Snapshot {
  context: WritingContext;
  text: string;
  visual?: VisualGrammarSnapshot;
  document?: Editor['state']['doc'];
}
const settingKey = 'lekh-writing-assistance';
const phraseKey = (issue: GrammarIssue) => JSON.stringify([issue.rule, issue.matchedText.toLocaleLowerCase('en-US')]);
const occurrenceKey = (issue: GrammarIssue) => JSON.stringify([issue.from, issue.to, issue.rule, issue.matchedText]);

export class WritingAssistance {
  private readonly panel = document.querySelector<HTMLElement>('#writing-panel')!;
  private readonly enabled = document.querySelector<HTMLInputElement>('#writing-enabled')!;
  private readonly status = document.querySelector<HTMLElement>('#writing-status')!;
  private readonly list = document.querySelector<HTMLElement>('#writing-suggestions')!;
  private worker?: Worker;
  private timer?: ReturnType<typeof setTimeout>;
  private timeout?: ReturnType<typeof setTimeout>;
  private pending?: { id: number; snapshot: Snapshot };
  private sequence = 0;
  private signature?: { id: string; mode: WritingContext['mode']; markdown: string; enabled: boolean };
  private snapshot?: Snapshot;
  private issues: GrammarIssue[] = [];
  private limited = false;
  private ignored = new Map<string, Set<string>>();
  private ignoredPhrases = new Map<string, Set<string>>();
  private watched = new WeakSet<HTMLTextAreaElement>();

  constructor(private readonly options: Options) {
    try { this.enabled.checked = localStorage.getItem(settingKey) === 'true'; }
    catch (error) { options.report(`Writing assistance settings could not be read: ${String(error)}`); }
    this.enabled.addEventListener('change', () => {
      try { localStorage.setItem(settingKey, String(this.enabled.checked)); }
      catch (error) { options.report(`Writing assistance changed, but could not be remembered: ${String(error)}`); }
      this.resetWorker();
      this.signature = undefined;
      this.schedule();
    });
    document.querySelector('#writing-check')!.addEventListener('click', () => {
      this.signature = undefined;
      this.schedule(true);
    });
    document.querySelector('#writing-close')!.addEventListener('click', () => this.open(false));
    window.addEventListener('resize', () => this.paintSource());
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.open(false); }
    });
    this.schedule();
  }

  open(open = this.panel.hidden): void {
    this.panel.hidden = !open;
    document.querySelector('#writing-toggle')!.setAttribute('aria-expanded', String(open));
    for (const control of document.querySelectorAll('.grammar-control')) control.setAttribute('aria-pressed', String(open));
    if (open) this.enabled.focus();
    else {
      const context = this.options.context();
      if (context?.mode === 'source') context.source.focus();
      else context?.editor.commands.focus();
    }
  }

  schedule(immediate = false): void {
    const context = this.options.context();
    if (!context) return;
    if (!this.watched.has(context.source)) {
      this.watched.add(context.source);
      context.source.addEventListener('scroll', () => {
        const layer = context.pane.querySelector<HTMLElement>('.grammar-highlights');
        if (layer) { layer.scrollTop = context.source.scrollTop; layer.scrollLeft = context.source.scrollLeft; }
      });
      context.source.addEventListener('click', () => {
        if (!this.current()) return;
        const index = this.issues.findIndex(issue => context.source.selectionStart >= issue.from && context.source.selectionStart < issue.to);
        if (index >= 0) this.select(index);
      });
      context.pane.addEventListener('click', event => {
        const mark = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-grammar-issue]') : null;
        if (mark && this.current()) {
          event.preventDefault();
          event.stopPropagation();
          this.select(Number(mark.dataset.grammarIssue));
        }
      }, true);
    }
    const previous = this.signature;
    if (previous && previous.id === context.id && previous.mode === context.mode
      && previous.markdown === context.markdown && previous.enabled === this.enabled.checked) return;
    this.signature = { id: context.id, mode: context.mode, markdown: context.markdown, enabled: this.enabled.checked };
    document.querySelector<HTMLButtonElement>('#writing-check')!.disabled = !this.enabled.checked;
    clearTimeout(this.timer);
    this.clearMarks();
    this.snapshot = undefined;
    this.issues = [];
    this.list.replaceChildren();
    const toggle = document.querySelector<HTMLElement>('#writing-toggle')!;
    toggle.textContent = 'Writing assistance';
    toggle.title = 'Offline English grammar checking';
    if (!this.enabled.checked) { this.status.textContent = 'Off. Enable offline English grammar checking above.'; return; }
    if (context.markdown.length > maxGrammarCharacters) {
      this.status.textContent = `Not checked: writing assistance supports documents up to ${maxGrammarCharacters.toLocaleString()} characters.`;
      return;
    }
    this.status.textContent = 'Checking English locally…';
    this.timer = setTimeout(() => this.check(), immediate ? 0 : 650);
  }

  private current(snapshot = this.snapshot): boolean {
    const context = this.options.context();
    return Boolean(this.enabled.checked && snapshot && context && context.id === snapshot.context.id
      && context.markdown === snapshot.context.markdown && context.mode === snapshot.context.mode
      && (context.mode === 'source' ? context.source.value === snapshot.text : context.editor.state.doc === snapshot.document));
  }

  private check(): void {
    const context = this.options.context();
    if (!context || !this.enabled.checked || context.markdown.length > maxGrammarCharacters || this.pending) return;
    const visual = context.mode === 'visual' ? visualGrammarSnapshot(context.editor.state.doc) : undefined;
    const snapshot: Snapshot = {
      context: { ...context }, text: visual?.text ?? context.source.value,
      visual, document: visual ? context.editor.state.doc : undefined,
    };
    if (!this.worker) {
      try { this.worker = new Worker(new URL('./grammar-worker.ts', import.meta.url), { type: 'module' }); }
      catch (error) { this.fail(`Offline grammar worker could not start: ${String(error)}`); return; }
      this.worker.onmessage = (event: MessageEvent<GrammarResponse>) => this.receive(event.data);
      this.worker.onerror = event => this.fail(`Offline grammar worker failed: ${event.message}`);
      this.worker.onmessageerror = () => this.fail('Offline grammar results could not be read.');
    }
    const id = ++this.sequence;
    this.pending = { id, snapshot };
    this.timeout = setTimeout(() => this.fail('Offline grammar checking exceeded 45 seconds. Use Check again to retry.'), 45000);
    const request: GrammarRequest = { id, text: snapshot.text, language: visual ? 'plaintext' : 'markdown' };
    try { this.worker.postMessage(request); }
    catch (error) { this.fail(`Offline grammar request could not be sent: ${String(error)}`); }
  }

  private receive(response: GrammarResponse): void {
    if (!this.pending || response.id !== this.pending.id) return;
    clearTimeout(this.timeout);
    const { snapshot } = this.pending;
    this.pending = undefined;
    if (!this.current(snapshot)) { this.check(); return; }
    if (!response.ok) { this.fail(response.error); return; }
    this.snapshot = snapshot;
    this.issues = response.issues.filter(issue => !snapshot.visual || visualGrammarRange(snapshot.visual, issue));
    this.limited = response.limited;
    this.render();
  }

  private fail(message: string): void {
    this.resetWorker();
    this.clearMarks();
    this.snapshot = undefined;
    this.issues = [];
    this.list.replaceChildren();
    this.status.textContent = message;
    this.options.report(message);
  }

  private resetWorker(): void {
    clearTimeout(this.timeout);
    this.worker?.terminate();
    this.worker = undefined;
    this.pending = undefined;
  }

  private clearMarks(): void {
    for (const layer of document.querySelectorAll('.grammar-highlights')) layer.replaceChildren();
    const previous = this.snapshot?.context.editor;
    const context = this.options.context();
    if (previous && previous !== context?.editor && !previous.isDestroyed) setGrammarHighlights(previous, []);
    if (context && !context.editor.isDestroyed) setGrammarHighlights(context.editor, []);
  }

  private visibleIssues(): GrammarIssue[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    const id = snapshot.context.id;
    return this.issues.filter(issue => !this.ignored.get(id)?.has(occurrenceKey(issue))
      && !this.ignoredPhrases.get(id)?.has(phraseKey(issue)));
  }

  private render(): void {
    if (!this.current()) return;
    const visible = this.visibleIssues();
    this.list.replaceChildren();
    this.status.textContent = `${visible.length}${this.limited ? '+' : ''} suggestion${visible.length === 1 ? '' : 's'} · English · Offline${this.limited ? ' · Showing the first results; correct these and check again.' : ''}`;
    const toggle = document.querySelector<HTMLElement>('#writing-toggle')!;
    toggle.textContent = visible.length ? `Writing assistance · ${visible.length}${this.limited ? '+' : ''}` : 'Writing assistance';
    toggle.title = visible.length ? `${visible.length} writing suggestion${visible.length === 1 ? '' : 's'}: open writing assistance` : 'Offline English grammar checking';
    for (const [index, issue] of this.issues.entries()) {
      if (!visible.includes(issue)) continue;
      const row = document.createElement('li');
      row.dataset.grammarIndex = String(index);
      const message = document.createElement('p');
      message.textContent = issue.message;
      const original = document.createElement('button');
      original.type = 'button';
      original.className = 'grammar-original';
      original.textContent = issue.matchedText;
      original.title = 'Show this suggestion in the document';
      original.addEventListener('click', () => this.locate(issue));
      const actions = document.createElement('div');
      for (const replacement of issue.suggestions.slice(0, 5)) {
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.dataset.grammarApply = String(index);
        apply.textContent = replacement || 'Remove';
        apply.setAttribute('aria-label', replacement ? `Replace with ${replacement}` : 'Remove this text');
        apply.addEventListener('click', () => this.apply(issue, replacement));
        actions.append(apply);
      }
      for (const all of [false, true]) {
        const ignore = document.createElement('button');
        ignore.type = 'button';
        ignore.textContent = all ? 'Ignore throughout document' : 'Ignore';
        ignore.addEventListener('click', () => {
          if (!this.current()) { this.stale(); return; }
          const map = all ? this.ignoredPhrases : this.ignored;
          const id = this.snapshot!.context.id;
          const set = map.get(id) ?? new Set<string>();
          set.add(all ? phraseKey(issue) : occurrenceKey(issue));
          map.set(id, set);
          this.render();
        });
        actions.append(ignore);
      }
      row.append(message, original, actions);
      this.list.append(row);
    }
    const snapshot = this.snapshot!;
    if (snapshot.visual) {
      setGrammarHighlights(snapshot.context.editor, this.issues.flatMap((issue, index) => {
        const range = visible.includes(issue) ? visualGrammarRange(snapshot.visual!, issue) : null;
        return range ? [{ ...range, message: issue.message, index }] : [];
      }));
    }
    this.paintSource();
  }

  private paintSource(): void {
    if (!this.current() || !this.snapshot || this.snapshot.visual) return;
    const { source, pane } = this.snapshot.context;
    let layer = pane.querySelector<HTMLElement>('.grammar-highlights');
    if (!layer) {
      layer = document.createElement('pre');
      layer.className = 'grammar-highlights';
      layer.setAttribute('aria-hidden', 'true');
      source.parentElement!.prepend(layer);
    }
    layer.replaceChildren();
    let end = 0;
    for (const issue of this.visibleIssues().sort((a, b) => a.from - b.from || a.to - b.to)) {
      if (issue.from < end) continue;
      layer.append(document.createTextNode(source.value.slice(end, issue.from)));
      const mark = document.createElement('span');
      mark.className = 'grammar-mark';
      mark.textContent = source.value.slice(issue.from, issue.to);
      layer.append(mark);
      end = issue.to;
    }
    layer.append(document.createTextNode(source.value.slice(end) + '\n'));
    layer.style.width = `${source.clientWidth}px`;
    layer.scrollTop = source.scrollTop;
    layer.scrollLeft = source.scrollLeft;
  }

  private select(index: number): void {
    if (!Number.isInteger(index) || !this.issues[index]) return;
    this.open(true);
    const row = this.list.querySelector<HTMLElement>(`[data-grammar-index="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    row?.querySelector<HTMLButtonElement>('button')?.focus();
  }

  private locate(issue: GrammarIssue): void {
    if (!this.current()) { this.stale(); return; }
    const snapshot = this.snapshot!;
    if (snapshot.visual) {
      const range = visualGrammarRange(snapshot.visual, issue);
      if (range) snapshot.context.editor.chain().focus().setTextSelection(range).scrollIntoView().run();
    } else {
      const source = snapshot.context.source;
      source.focus();
      source.setSelectionRange(issue.from, issue.to);
      source.scrollTop = Math.max(0, source.value.slice(0, issue.from).split('\n').length * 24 - source.clientHeight / 2);
    }
  }

  private apply(issue: GrammarIssue, replacement: string): void {
    if (!this.current()) { this.stale(); return; }
    const context = this.options.context()!;
    if (context.source.readOnly || !context.editor.isEditable) {
      this.options.report('Finish the current operation before applying a grammar suggestion.');
      return;
    }
    const snapshot = this.snapshot!;
    if (snapshot.text.slice(issue.from, issue.to) !== issue.matchedText) { this.stale(); return; }
    if (snapshot.visual) {
      const range = visualGrammarRange(snapshot.visual, issue);
      if (!range) { this.stale(); return; }
      const { editor } = snapshot.context;
      editor.view.dispatch(closeHistory(editor.state.tr).insertText(replacement, range.from, range.to).scrollIntoView());
      editor.commands.focus();
    } else this.options.applySource(issue.from, issue.to, replacement);
    this.schedule();
  }

  private stale(): void {
    this.options.report('The document changed. Check again before applying this suggestion.');
    this.signature = undefined;
    this.schedule(true);
  }

  forget(id: string): void {
    this.ignored.delete(id);
    this.ignoredPhrases.delete(id);
  }
}
