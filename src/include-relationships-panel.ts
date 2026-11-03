import type { RelationshipConsumer, RelationshipReport } from '../lib/include-relationships.js';
import type { OpenedFile } from './bridge.js';
import { selectRelationshipControl } from './relationship-control.js';

interface Context { id: string; markdown: string; path: string | null }
interface Options {
  context: (id?: string) => Context | undefined;
  query: (id: string, markdown: string, source: string | null, refresh: boolean) => Promise<RelationshipReport | null>;
  workspace: (id: string, revoke: boolean) => Promise<string | null>;
  openFile: (id: string, file: string, line: number) => Promise<OpenedFile>;
  report: (message: string) => void;
}
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function text(tag: string, className: string, value: string): HTMLElement {
  const node = document.createElement(tag); node.className = className; node.textContent = value; return node;
}

export class IncludeRelationshipsPanel {
  private readonly panel = element<HTMLElement>('relationships-panel');
  private readonly results = element<HTMLElement>('relationships-results');
  private readonly status = element<HTMLElement>('relationships-status');
  private readonly search = element<HTMLInputElement>('relationships-search');
  private source: string | null = null;
  private list = true;
  private ownerId = '';
  private followId = '';
  private navigating = false;
  private sequence = 0;
  private signature = '';
  private timer?: ReturnType<typeof setTimeout>;
  private data: RelationshipReport | null = null;

  constructor(private readonly options: Options) {
    element('relationships-close').onclick = () => this.open(false);
    element('relationships-refresh').onclick = () => this.schedule(true, true);
    element('relationships-workspace').onclick = () => { void this.chooseWorkspace(); };
    element('relationships-revoke').onclick = () => { void this.revoke(); };
    element('relationships-back').onclick = () => {
      this.list = true; this.source = null; this.sync(); this.render();
    };
    element('relationships-this-file').onclick = () => { this.list = false; this.source = null; this.schedule(true); };
    this.search.oninput = () => this.render();
    this.panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.open(false); } });
  }
  get isOpen(): boolean { return !this.panel.hidden; }

  open(open = this.panel.hidden, source?: string): void {
    this.panel.hidden = !open;
    if (!open) {
      ++this.sequence; clearTimeout(this.timer); this.signature = ''; this.sync(); return;
    }
    const context = this.options.context();
    if (!context) return;
    if (source !== undefined || context.id !== this.ownerId) {
      this.ownerId = context.id; this.followId = ''; this.source = source ?? null; this.list = source === undefined;
      this.search.value = ''; this.data = null;
    }
    this.schedule(true);
  }

  schedule(immediate = false, refresh = false): void {
    if (!this.isOpen || this.navigating) return;
    const active = this.options.context();
    if (!active) return;
    if ((active.id !== this.ownerId && active.id !== this.followId) || !this.options.context(this.ownerId)) {
      this.ownerId = active.id; this.followId = ''; this.source = null; this.list = true; this.search.value = ''; this.data = null;
    }
    const context = this.options.context(this.ownerId)!;
    const signature = JSON.stringify([context.id, context.path, context.markdown, this.source]);
    if (!immediate && signature === this.signature) return;
    this.signature = signature;
    clearTimeout(this.timer);
    const sequence = ++this.sequence;
    this.data = null; this.results.replaceChildren(); this.search.disabled = true;
    element('relationships-target').textContent = this.source ?? (this.list ? 'Includes in this article' : context.path ?? 'Unsaved document');
    this.status.textContent = refresh ? 'Refreshing the workspace index\u2026 Large workspaces can take a few minutes. Forget workspace cancels access.' : 'Checking local include relationships\u2026';
    this.sync();
    this.timer = setTimeout(() => { void this.load(context, sequence, refresh); }, immediate ? 0 : 450);
  }

  private sync(): void {
    selectRelationshipControl(this.isOpen && !this.list ? { id: this.ownerId, source: this.source } : null);
    for (const control of document.querySelectorAll('[data-action="include-relationships"]')) control.setAttribute('aria-expanded', String(this.isOpen));
    element('relationships-back').hidden = this.list;
    element('relationships-this-file').hidden = !this.list;
  }
  private async load(context: Context, sequence: number, refresh: boolean): Promise<void> {
    try {
      const data = await this.options.query(context.id, context.markdown, this.source, refresh);
      if (sequence !== this.sequence || !this.isOpen) return;
      this.data = data; this.search.disabled = !data; this.render();
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.status.textContent = `Relationships could not be checked: ${error instanceof Error ? error.message : String(error)}`;
      this.options.report(this.status.textContent);
    }
  }
  private async chooseWorkspace(): Promise<void> {
    const context = this.options.context(this.ownerId);
    if (!context) return;
    try {
      const root = await this.options.workspace(context.id, false);
      if (root && this.ownerId === context.id && this.isOpen) {
        element('relationships-revoke').hidden = false;
        this.schedule(true);
      }
    } catch (error) { this.options.report(error instanceof Error ? error.message : String(error)); }
  }
  private async revoke(): Promise<void> {
    const id = this.ownerId;
    try {
      await this.options.workspace(id, true);
      if (this.ownerId !== id) return;
      ++this.sequence; clearTimeout(this.timer); this.data = null; this.signature = ''; this.render();
    } catch (error) { this.options.report(error instanceof Error ? error.message : String(error)); }
  }
  private async navigate(consumer: RelationshipConsumer, line: number): Promise<void> {
    const id = this.ownerId;
    this.navigating = true;
    try {
      const opened = await this.options.openFile(id, consumer.file, line);
      if (this.ownerId === id) this.followId = opened.id;
    } catch (error) { this.options.report(error instanceof Error ? error.message : String(error)); }
    finally { this.navigating = false; }
  }
  private consumer(consumer: RelationshipConsumer, indirect: boolean): HTMLElement {
    const row = text('li', 'relationship-consumer', '');
    row.append(text('strong', '', consumer.file), text('p', 'relationship-reference-count', `${consumer.referenceCount} ${consumer.referenceCount === 1 ? 'reference' : 'references'}${indirect ? ' to the next include in the chain' : ''}${consumer.lines.length < consumer.referenceCount ? ` (showing ${consumer.lines.length} line links)` : ''}`));
    for (const line of consumer.lines) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'relationship-line';
      button.textContent = `Line ${line}`; button.title = `Open ${consumer.file} at line ${line}`;
      button.onclick = () => { void this.navigate(consumer, line); }; row.append(button);
    }
    if (indirect) row.append(text('p', 'relationship-chain', consumer.chain.join(' \u2192 ')));
    return row;
  }
  private render(): void {
    const data = this.data;
    this.results.replaceChildren();
    this.sync();
    this.search.disabled = !data;
    element('relationships-revoke').hidden = !data;
    element('relationships-title').textContent = this.list ? 'Includes in this article' : 'Used by within this workspace';
    if (!data) {
      element('relationships-target').textContent = this.source ?? '';
      this.status.textContent = 'Choose a workspace folder to scan local Markdown. Save an untitled document first. Access is separate from image/include loading and lasts until this document is closed or saved elsewhere.';
      return;
    }
    element('relationships-target').textContent = this.list ? data.document : data.target;
    this.status.textContent = `${data.root} \u00b7 ${data.files} Markdown files \u00b7 scanned ${new Date(data.scannedAt).toLocaleTimeString()}. ${data.incomplete ? 'Incomplete scan. ' : ''}Reference context: ${data.document}. Its in-memory edits are included; other files use their last scanned disk contents.`;
    const query = this.search.value.trim().toLowerCase();
    for (const warning of data.warnings) this.results.append(text('p', 'relationship-warning', warning));
    if (this.list) {
      const list = document.createElement('ul'); list.className = 'relationship-list';
      for (const item of data.includes.filter(item => `${item.file ?? item.source} ${item.label}`.toLowerCase().includes(query))) {
        const row = document.createElement('li');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'relationship-include';
        button.append(text('strong', '', item.file ?? item.source), text('span', '', `${item.lines.length} references in this article \u00b7 ${item.status}`));
        button.onclick = () => { this.source = item.source; this.list = false; this.search.value = ''; this.schedule(true); };
        row.append(button); list.append(row);
      }
      this.results.append(list);
      if (!list.children.length) this.results.append(text('p', '', query ? 'No matching includes.' : 'No supported include directives in this article. Use “Where is this file used?” to find consumers of the open file.'));
    } else {
      const matches = (consumer: RelationshipConsumer) => consumer.file.toLowerCase().includes(query);
      const direct = data.direct.filter(matches), indirect = data.indirect.filter(matches);
      this.results.append(text('h3', '', `Direct references \u00b7 ${direct.length} files`));
      const list = document.createElement('ul'); list.className = 'relationship-list';
      direct.forEach(consumer => list.append(this.consumer(consumer, false))); this.results.append(list);
      if (!direct.length) this.results.append(text('p', '', 'No direct references found within the indexed workspace. This does not prove that the file is unused elsewhere.'));
      if (indirect.length) {
        const details = document.createElement('details');
        details.append(text('summary', '', `Also used indirectly by ${indirect.length} files`));
        const nested = document.createElement('ul'); nested.className = 'relationship-list';
        indirect.forEach(consumer => nested.append(this.consumer(consumer, true))); details.append(nested); this.results.append(details);
      }
    }
  }
}
