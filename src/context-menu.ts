import type { ContextMenuItem, EditorContextMenu } from './bridge.js';
import { publishingIcon } from '../lib/publishing-icons.js';

type ContextIcon = 'cut' | 'copy' | 'paste' | 'delete' | 'bold' | 'italic' | 'code' | 'link' | 'quote' | 'ordered' | 'bullet' | 'task';
const directActions: [string, string, ContextIcon][] = [
  ['Cut', 'Cut', 'cut'], ['Copy', 'Copy', 'copy'], ['Paste', 'Paste', 'paste'], ['Delete selection', 'Delete', 'delete'],
  ['Bold', 'Bold', 'bold'], ['Italic', 'Italic', 'italic'], ['Inline code', 'Code', 'code'], ['Link...', 'Link', 'link'],
];

export class ContextMenu {
  private readonly root = document.createElement('div');
  private readonly submenus: HTMLElement[] = [];
  private readonly triggers = new Map<HTMLElement, HTMLButtonElement>();
  private origin: HTMLElement | null = null;
  private execute: (command: string) => void = () => {};

  constructor(private readonly icon: (name: ContextIcon) => string) {
    this.root.id = 'editor-context-menu';
    this.root.className = 'editor-context-menu';
    this.root.popover = 'auto';
    this.root.setAttribute('role', 'menu');
    this.root.setAttribute('aria-label', 'Edit Markdown');
    document.body.append(this.root);
    this.root.addEventListener('mousedown', event => event.preventDefault());
    this.root.addEventListener('click', event => event.stopPropagation());
    this.root.addEventListener('keydown', event => this.keydown(event));
    this.root.addEventListener('toggle', () => {
      if (!this.root.matches(':popover-open')) this.closeSubmenus();
    });
    window.addEventListener('resize', () => this.hide());
    window.addEventListener('blur', () => this.hide());
  }

  hide(restoreFocus = false): void {
    this.closeSubmenus();
    if (this.root.matches(':popover-open')) this.root.hidePopover();
    if (restoreFocus && this.origin?.isConnected) this.origin.focus({ preventScroll: true });
  }

  show(menu: EditorContextMenu, origin: HTMLElement, execute: (command: string) => void): void {
    this.hide();
    for (const submenu of this.submenus.splice(0)) submenu.remove();
    this.triggers.clear();
    this.root.replaceChildren();
    this.origin = origin;
    this.execute = execute;
    const all: ContextMenuItem[] = [];
    const collect = (items: ContextMenuItem[]) => {
      for (const item of items) { all.push(item); if (item.submenu) collect(item.submenu); }
    };
    collect(menu.items);
    const used = new Set<string>();
    const grid = document.createElement('div');
    grid.className = 'context-tools';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'Quick editing');
    for (const [label, caption, icon] of directActions) {
      const item = all.find(item => item.label === (label === 'Link...' && all.some(item => item.label === 'Edit link...') ? 'Edit link...' : label));
      if (!item) continue;
      used.add(item.id);
      const control = this.control(item);
      control.replaceChildren();
      control.insertAdjacentHTML('beforeend', this.icon(icon));
      const text = document.createElement('span');
      text.textContent = caption;
      control.append(text);
      grid.append(control);
    }
    if (grid.childElementCount) this.root.append(grid);
    for (const item of menu.items) {
      if (used.has(item.id)) continue;
      this.append(this.root, item);
    }
    this.root.showPopover();
    this.position(this.root, menu.x, menu.y);
    this.controls(this.root)[0]?.focus({ preventScroll: true });
  }

  private control(item: ContextMenuItem): HTMLButtonElement {
    const control = document.createElement('button');
    control.type = 'button';
    control.tabIndex = -1;
    control.disabled = !item.enabled;
    control.dataset.contextLabel = item.label;
    control.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (item.checked !== undefined) control.setAttribute('aria-checked', String(item.checked));
    control.setAttribute('aria-label', item.label);
    control.title = item.shortcut ? `${item.label} (${item.shortcut})` : item.label;
    if (item.description) { control.title = item.description; control.setAttribute('aria-description', item.description); }
    const label = document.createElement('span');
    label.className = 'context-menu-label';
    if (item.icon) label.insertAdjacentHTML('beforeend', publishingIcon(item.icon));
    const text = document.createElement('span');
    text.textContent = item.label;
    label.append(text);
    control.append(label);
    if (item.submenu) {
      const submenu = document.createElement('div');
      submenu.id = `context-submenu-${this.submenus.length}`;
      submenu.className = 'editor-context-menu editor-context-submenu';
      submenu.popover = 'manual';
      submenu.setAttribute('role', 'menu');
      submenu.setAttribute('aria-label', item.label);
      control.setAttribute('aria-haspopup', 'menu');
      control.setAttribute('aria-expanded', 'false');
      control.setAttribute('aria-controls', submenu.id);
      const arrow = document.createElement('span');
      arrow.textContent = '\u203a';
      arrow.setAttribute('aria-hidden', 'true');
      control.append(arrow);
      this.submenus.push(submenu);
      this.triggers.set(submenu, control);
      this.root.append(submenu);
      for (const child of item.submenu) this.append(submenu, child);
      const open = (focus = false) => {
        const parent = control.closest<HTMLElement>('[role="menu"]')!;
        const keep = this.ancestors(parent);
        keep.add(submenu);
        this.closeSubmenus(keep);
        if (!submenu.matches(':popover-open')) submenu.showPopover();
        control.setAttribute('aria-expanded', 'true');
        const bounds = control.getBoundingClientRect();
        this.position(submenu, parent.getBoundingClientRect().right + 3, bounds.top, parent);
        if (focus) this.controls(submenu)[0]?.focus({ preventScroll: true });
      };
      control.addEventListener('pointerenter', () => { if (!control.disabled) open(); });
      control.addEventListener('click', () => open(true));
      control.addEventListener('keydown', event => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        open(true);
      });
      submenu.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        this.closeSubmenus(this.ancestors(control.closest<HTMLElement>('[role="menu"]')!));
        control.focus({ preventScroll: true });
      });
    } else {
      if (item.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = item.shortcut;
        control.append(shortcut);
      }
      control.addEventListener('click', () => {
        this.hide(true);
        this.execute(item.id);
      });
      control.addEventListener('pointerenter', () => {
        this.closeSubmenus(this.ancestors(control.closest<HTMLElement>('[role="menu"]')!));
      });
    }
    return control;
  }

  private append(container: HTMLElement, item: ContextMenuItem): void {
    if (item.separator) {
      const separator = document.createElement('div');
      separator.className = 'context-separator';
      separator.setAttribute('role', 'separator');
      container.append(separator);
    } else container.append(this.control(item));
  }

  private controls(container: HTMLElement): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      .filter(control => control.closest('[role="menu"]') === container);
  }

  private ancestors(menu: HTMLElement): Set<HTMLElement> {
    const keep = new Set<HTMLElement>();
    for (let current: HTMLElement | null = menu; current && current !== this.root;
      current = this.triggers.get(current)?.closest<HTMLElement>('[role="menu"]') ?? null) keep.add(current);
    return keep;
  }

  private closeSubmenus(keep = new Set<HTMLElement>()): void {
    for (const submenu of this.submenus) {
      if (!keep.has(submenu) && submenu.matches(':popover-open')) submenu.hidePopover();
      this.triggers.get(submenu)?.setAttribute('aria-expanded', String(keep.has(submenu) && submenu.matches(':popover-open')));
    }
  }

  private position(menu: HTMLElement, x: number, y: number, parent?: HTMLElement): void {
    const bounds = menu.getBoundingClientRect();
    if (parent && x + bounds.width > innerWidth - 8) x = parent.getBoundingClientRect().left - bounds.width - 3;
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
  }

  private keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      this.hide(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const container = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="menu"]') : null;
    if (!container) return;
    const controls = this.controls(container);
    const current = controls.findIndex(control => control === document.activeElement);
    const previous = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : (current + (previous ? controls.length - 1 : 1)) % controls.length;
    controls[index]?.focus({ preventScroll: true });
  }
}
