export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface OpenedFile { id: string; path: string; content: string }
export interface EditorContext {
  mode: 'visual' | 'source';
  active: string[];
  heading: number;
  inTable: boolean;
  hasVariantSelector?: boolean;
  hasInteractivePublishing?: boolean;
  formField?: boolean;
}
export interface ContextMenuItem {
  id: string;
  label: string;
  enabled: boolean;
  separator: boolean;
  checked?: boolean;
  shortcut?: string;
  submenu?: ContextMenuItem[];
  icon?: string;
  description?: string;
}
export interface EditorContextMenu {
  id: string;
  x: number;
  y: number;
  items: ContextMenuItem[];
}
export interface LekhAPI {
  open: (recentPath?: string) => Promise<Result<OpenedFile | null>>;
  openPending: () => Promise<Result<Result<OpenedFile>[]>>;
  save: (id: string, content: string, saveAs: boolean) => Promise<Result<{ path: string } | null>>;
  newDocument: () => Promise<Result<string>>;
  closeDocument: (id: string) => Promise<Result<void>>;
  allowImageFolder: (id: string) => Promise<Result<boolean>>;
  revokeImageFolder: (id: string) => Promise<Result<void>>;
  prepareVariantConfiguration: (id: string, content: string) => Promise<Result<string>>;
  exportDocument: (id: string, content: string, format: 'pdf' | 'docx' | 'html') => Promise<Result<string | null>>;
  insertImage: () => Promise<Result<string | null>>;
  storeImage: (id: string, source: string, storage: 'embedded' | 'assets') => Promise<Result<string>>;
  recent: () => Promise<Result<string[]>>;
  clearRecent: () => Promise<Result<void>>;
  zoom: (command?: 'in' | 'out' | 'reset') => Promise<Result<number>>;
  setTheme: (theme: Theme) => Promise<Result<void>>;
  confirmUnsaved: (name: string) => Promise<Result<'save' | 'discard' | 'cancel'>>;
  setEditorContext: (context: EditorContext) => void;
  onContextMenu: (listener: (menu: EditorContextMenu) => void) => void;
  contextMenuCommand: (id: string, command: string) => Promise<Result<void>>;
  readClipboard: () => Promise<Result<string>>;
  paste: () => void;
  readClipboardImage: () => Promise<Result<string | null>>;
  copyImage: (id: string, source: string) => Promise<Result<void>>;
  writeClipboard: (text: string) => Promise<Result<void>>;
  setDirty: (dirty: boolean) => void;
  close: () => void;
  openExternal: (url: string) => Promise<Result<void>>;
  onAction: (listener: (action: string) => void) => void;
}

declare global {
  interface Window { lekh: LekhAPI }
}
import type { Theme } from '../lib/themes.js';
