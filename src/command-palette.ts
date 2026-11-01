import { filterCommands, type CommandEntry } from '../lib/commands.js';

const escape = (value: string) => value.replace(/[&<>"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!);

/** Keyboard-first list of commands shared by the command palette and the slash menu. */
class CommandList {
  readonly list = document.createElement('div');
  private entries: CommandEntry[] = [];
  private shown: CommandEntry[] = [];
  private index = 0;

  constructor(id: string, label: string, private readonly onRun: (entry: CommandEntry) => void, private readonly grouped: boolean, private readonly iconFor?: (entry: CommandEntry) => string) {
    this.list.id = id;
    this.list.className = 'command-results';
    this.list.setAttribute('role', 'listbox');
    this.list.setAttribute('aria-label', label);
    this.list.addEventListener('mousedown', event => event.preventDefault());
    this.list.addEventListener('click', event => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[data-command-index]');
      if (option) this.onRun(this.shown[Number(option.dataset.commandIndex)]);
    });
    this.list.addEventListener('mousemove', event => {
      const option = (event.target as HTMLElement).closest<HTMLElement>('[data-command-index]');
      if (option && Number(option.dataset.commandIndex) !== this.index) this.select(Number(option.dataset.commandIndex));
    });
  }

  get count(): number { return this.shown.length; }

  setEntries(entries: CommandEntry[]): void { this.entries = entries; }

  filter(query: string): void {
    this.shown = filterCommands(this.entries, query);
    this.index = 0;
    let group = '';
    this.list.innerHTML = this.shown.length ? this.shown.map((entry, index) => {
      const header = this.grouped && !query.trim() && entry.group !== group ? `<div class="command-group" role="presentation">${escape(group = entry.group)}</div>` : '';
      return `${header}<div class="command-option" role="option" id="${this.list.id}-${index}" data-command-index="${index}" data-command-id="${escape(entry.id)}" aria-selected="${index === 0}">${this.iconFor ? `<span class="command-icon" aria-hidden="true">${this.iconFor(entry)}</span>` : ''}<span class="command-label">${escape(entry.label)}</span>${entry.description ? `<small>${escape(entry.description)}</small>` : ''}${!this.iconFor && (!this.grouped || query.trim()) ? `<span class="command-group-tag">${escape(entry.group)}</span>` : ''}${entry.shortcut ? `<kbd>${escape(entry.shortcut)}</kbd>` : ''}</div>`;
    }).join('') : '<p class="command-empty" role="status">No matching commands</p>';
    this.select(0);
  }

  select(index: number): void {
    if (!this.shown.length) return;
    this.index = (index + this.shown.length) % this.shown.length;
    for (const option of this.list.querySelectorAll<HTMLElement>('[data-command-index]')) {
      const selected = Number(option.dataset.commandIndex) === this.index;
      option.setAttribute('aria-selected', String(selected));
      if (selected) option.scrollIntoView({ block: 'nearest' });
    }
  }

  activeId(): string { return this.shown.length ? `${this.list.id}-${this.index}` : ''; }

  /** Handles navigation keys; returns true when the key was consumed. */
  key(event: KeyboardEvent): boolean {
    if (!this.shown.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { this.select(this.index + (event.key === 'ArrowDown' ? 1 : -1)); return true; }
    if (event.key === 'Home' && event.ctrlKey) { this.select(0); return true; }
    if (event.key === 'End' && event.ctrlKey) { this.select(this.shown.length - 1); return true; }
    if (event.key === 'Enter' || (event.key === 'Tab' && !this.grouped)) {
      if (this.shown.length) this.onRun(this.shown[this.index]);
      return true;
    }
    return false;
  }

  clear(): void { this.shown = []; this.list.replaceChildren(); }
}

export class CommandPalette {
  readonly root = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly results: CommandList;
  private restoreFocus: HTMLElement | null = null;

  constructor(private readonly entries: () => CommandEntry[], private readonly run: (id: string) => void) {
    this.root.id = 'command-palette';
    this.root.className = 'command-palette';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Command palette');
    this.results = new CommandList('command-results', 'Commands', entry => this.choose(entry), true);
    this.input.type = 'search';
    this.input.placeholder = 'Type a command, block or setting\u2026';
    this.input.setAttribute('aria-label', 'Search commands');
    this.input.setAttribute('role', 'combobox');
    this.input.setAttribute('aria-expanded', 'true');
    this.input.setAttribute('aria-controls', 'command-results');
    this.input.setAttribute('aria-autocomplete', 'list');
    this.input.spellcheck = false;
    const panel = document.createElement('div');
    panel.className = 'command-panel';
    const hint = document.createElement('p');
    hint.className = 'command-hint';
    hint.innerHTML = '<kbd>\u2191</kbd><kbd>\u2193</kbd> move <kbd>Enter</kbd> run <kbd>Esc</kbd> close';
    panel.append(this.input, this.results.list, hint);
    this.root.append(panel);
    this.root.addEventListener('mousedown', event => { if (event.target === this.root) { event.preventDefault(); this.close(); } });
    this.input.addEventListener('input', () => this.refresh());
    this.root.addEventListener('focusout', event => {
      const next = event.relatedTarget as Node | null;
      if (this.isOpen && next && !this.root.contains(next)) this.close(false);
    });
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); return; }
      if (event.key === 'Tab') { event.preventDefault(); return; }
      if (this.results.key(event)) { event.preventDefault(); this.input.setAttribute('aria-activedescendant', this.results.activeId()); }
    });
    document.body.append(this.root);
  }

  get isOpen(): boolean { return !this.root.hidden; }

  open(query = ''): void {
    if (this.isOpen) { this.input.focus(); return; }
    this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.results.setEntries(this.entries());
    this.root.hidden = false;
    this.input.value = query;
    this.refresh();
    this.input.focus();
    this.input.select();
  }

  close(restore = true): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.results.clear();
    this.input.removeAttribute('aria-activedescendant');
    if (restore) this.restoreFocus?.focus();
    this.restoreFocus = null;
  }

  private refresh(): void {
    this.results.filter(this.input.value);
    this.input.setAttribute('aria-activedescendant', this.results.activeId());
  }

  private choose(entry: CommandEntry): void {
    this.close();
    this.run(entry.id);
  }
}

/** Popover listing insertable blocks while the user types "/query" on an empty paragraph. */
export class SlashMenu {
  readonly root: HTMLElement;
  private readonly results: CommandList;
  private query = '';

  constructor(private readonly entries: () => CommandEntry[], private readonly run: (entry: CommandEntry, query: string) => void, iconFor?: (entry: CommandEntry) => string) {
    this.results = new CommandList('slash-results', 'Insert block', entry => this.run(entry, this.query), false, iconFor);
    this.root = this.results.list;
    this.root.classList.add('slash-menu');
    this.root.hidden = true;
    document.body.append(this.root);
  }

  get isOpen(): boolean { return !this.root.hidden; }

  update(query: string, anchor: DOMRect): void {
    if (!this.isOpen) this.results.setEntries(this.entries());
    this.query = query;
    this.results.filter(query);
    if (!this.results.count && query.length > 12) { this.close(); return; }
    this.root.hidden = false;
    const height = this.root.offsetHeight;
    const below = anchor.bottom + 6 + height <= innerHeight - 8;
    this.root.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - this.root.offsetWidth - 8))}px`;
    this.root.style.top = `${below ? anchor.bottom + 6 : Math.max(8, anchor.top - height - 6)}px`;
  }

  key(event: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (event.key === 'Escape') { this.close(); return true; }
    return this.results.key(event);
  }

  close(): void {
    this.root.hidden = true;
    this.results.clear();
  }
}
