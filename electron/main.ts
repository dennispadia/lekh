import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { readFile, realpath, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type Token from 'markdown-it/lib/token.mjs';
import { atomicWrite, atomicWriteIfUnchanged, exportWriteError, readMarkdown } from '../lib/files.js';
import { readImage, imageMime, embeddedImage, storeImage, MAX_IMAGE_BYTES, type AuthorizedImageRoots } from '../lib/images.js';
import { learnPathStatuses } from '../lib/learn-paths.js';
import { relationshipReport, scanRepository, validateWorkspace, withinWorkspace, type RepositoryIndex } from '../lib/repository-index.js';
import { documentPreviewTokensHTML, headingAnchor, isSafeLink, parser, requiresInteractiveExport } from '../lib/markdown.js';
import { IncludeAccessPrompts, resolveIncludes, suggestedIncludeFolder } from '../lib/includes.js';
import { toDocx, toOfflineHTML, toPrintHTML, type DiagramImageLoader } from '../lib/export.js';
import { diagramLimits, isMermaidLanguage, prepareMermaid } from '../lib/diagrams.js';
import { themes } from '../lib/themes.js';
import { formattingShortcuts } from '../lib/shortcuts.js';
import { fileArguments } from '../lib/launch.js';
import { productName, productTitle, userDataDirectory } from '../lib/branding.js';
import { addVariantMetadata, appendVariantGroupEntry, prepareVariantConfiguration, prepareVariantConfigurationFromFile, variantGroupIds, type SharedVariantGroup } from '../lib/variant-config.js';
import { publishingTemplates, variantInsertionTemplate } from '../lib/publishing-templates.js';
import { hasInteractivePublishing, interactiveExportMessage, type PublishingMeta } from '../lib/publishing.js';
import type { ContextMenuItem, EditorContext, OpenedFile, Result } from '../src/bridge.js';

protocol.registerSchemesAsPrivileged([{ scheme: 'lekh-image', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName(productName);
const profilePath = app.commandLine.getSwitchValue('user-data-dir') || path.join(app.getPath('appData'), userDataDirectory);
mkdirSync(profilePath, { recursive: true });
app.setPath('userData', profilePath);
app.setPath('sessionData', profilePath);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
let window: BrowserWindow;
const pendingFiles: string[] = [];
let rendererReady = false;
interface NativeDocument { path: string | null; diskContent: string | null }
const documents = new Map<string, NativeDocument>();
// Grant identity changes even when the same folder is authorized again.
const imageRoots = new Map<string, { root: string }>();
const includeRoots = new Map<string, { root: string }>();
interface RelationshipWorkspace { root: string; index?: RepositoryIndex; pending?: Promise<RepositoryIndex>; request?: number }
const relationshipWorkspaces = new Map<string, RelationshipWorkspace>();
const includePrompts = new IncludeAccessPrompts();
const pendingVariantFiles = new Map<string, { id: string; document: NativeDocument; documentPath: string | null; file: string; content: string; label: string }>();
const sharedVariantFiles = new Map<string, string>();
let dirty = false;
let allowClose = false;
let recentFiles: string[] = [];
const RECENT_FILE_LIMIT = 5;
let editorContext: EditorContext = { mode: 'visual', active: [], heading: 0, inTable: false };
let contextMenu: { id: string; native: Menu; x: number; y: number; commands: Map<string, () => void> } | null = null;
const entryURL = pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;
const recentPath = () => path.join(app.getPath('userData'), 'recent-files.json');
const variantAssociationsPath = () => path.join(app.getPath('userData'), 'shared-variant-files.json');
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
const variantAssociationKey = (file: string) => path.resolve(file).toLowerCase();
const sharedVariantAssociations = new Map<string, string>();

async function rememberVariantAssociation(documentPath: string, configPath: string): Promise<void> {
  const key = variantAssociationKey(documentPath);
  const previous = sharedVariantAssociations.get(key);
  sharedVariantAssociations.set(key, configPath);
  try {
    await atomicWrite(variantAssociationsPath(), JSON.stringify([...sharedVariantAssociations]));
  } catch (error) {
    if (previous === undefined) sharedVariantAssociations.delete(key);
    else sharedVariantAssociations.set(key, previous);
    throw error;
  }
}

function documentFor(id: unknown): NativeDocument {
  const document = typeof id === 'string' ? documents.get(id) : undefined;
  if (!document) throw new Error('This document is no longer open.');
  return document;
}

function assertSender(event: IpcMainInvokeEvent): void {
  if (event.sender !== window.webContents || event.senderFrame?.url !== entryURL) throw new Error('Untrusted application request.');
}

function contentArgument(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 10 * 1024 * 1024) {
    throw new Error('Documents must be UTF-8 text and no larger than 10 MB.');
  }
}

function isSharedVariantGroup(value: unknown): value is SharedVariantGroup {
  if (!value || typeof value !== 'object' || !('owner' in value) || typeof value.owner !== 'string' ||
      !('id' in value) || typeof value.id !== 'string' || !('title' in value) || typeof value.title !== 'string' ||
      !('prompt' in value) || typeof value.prompt !== 'string' || !('pivots' in value) || !Array.isArray(value.pivots)) return false;
  return value.pivots.every((pivot: unknown) => pivot !== null && typeof pivot === 'object' && 'id' in pivot &&
    typeof pivot.id === 'string' && 'title' in pivot && typeof pivot.title === 'string');
}

function handle<T, Args extends unknown[]>(channel: string, callback: (...args: Args) => Promise<T>): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
    try {
      assertSender(event);
      return { ok: true, value: await callback(...args as Args) };
    } catch (error) {
      console.error(channel, error);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

async function remember(file: string): Promise<void> {
  recentFiles = [file, ...recentFiles.filter(item => item !== file)].slice(0, RECENT_FILE_LIMIT);
  try { await atomicWrite(recentPath(), JSON.stringify(recentFiles)); }
  catch (error) {
    console.error('Could not update recent files:', error);
    await dialog.showMessageBox(window, { type: 'warning', message: 'Your document is safe, but the recent-file list could not be updated.', detail: String(error) });
  }
}

function action(command: string): void { window.webContents.send('app:action', command); }

function queueFiles(files: string[]): void {
  pendingFiles.push(...files);
  if (pendingFiles.length && rendererReady && !window.isDestroyed()) action('open-pending');
}

if (primaryInstance) {
  queueFiles(fileArguments(process.argv, process.cwd(), app.isPackaged));
  app.on('second-instance', (_event, argv, cwd) => {
    queueFiles(fileArguments(argv, cwd, app.isPackaged));
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
}

async function openDocument(file: string, preloadedContent?: string): Promise<OpenedFile> {
  const existing = [...documents].find(([, document]) => document.path && samePath(document.path, file));
  if (existing) {
    await remember(file);
    return { id: existing[0], path: file, content: existing[1].diskContent ?? '' };
  }
  const content = preloadedContent ?? await readMarkdown(file);
  const id = randomUUID();
  documents.set(id, { path: file, diskContent: content });
  const sharedFile = sharedVariantAssociations.get(variantAssociationKey(file));
  if (sharedFile) sharedVariantFiles.set(id, sharedFile);
  await remember(file);
  return { id, path: file, content };
}

function paste(): void {
  if (!clipboard.readImage().isEmpty()) action('paste-image');
  else window.webContents.paste();
}

function showContextMenu(items: MenuItemConstructorOptions[], x: number, y: number): void {
  const structureDetails: Record<string, { icon: string; description: string }> = {
    'structure-toc': { icon: 'contents', description: 'Insert a linked table of contents, or refresh the existing one.' },
    'structure-mermaid': { icon: 'diagram', description: 'Flowcharts, sequence and other diagrams written as text.' },
    'structure-rule': { icon: 'rule', description: 'Divide sections with a horizontal line.' },
  };
  const native = Menu.buildFromTemplate(items);
  const commands = new Map<string, () => void>();
  const serialize = (menu: Menu, parentEnabled = true): ContextMenuItem[] => menu.items.map(item => {
    const id = String(commands.size);
    const enabled = parentEnabled && item.enabled;
    if (!item.submenu && item.type !== 'separator' && enabled) {
      commands.set(id, () => {
        switch (item.role?.toLowerCase()) {
          case 'cut': window.webContents.cut(); break;
          case 'copy': window.webContents.copy(); break;
          case 'pasteandmatchstyle': window.webContents.pasteAndMatchStyle(); break;
          case 'selectall': window.webContents.selectAll(); break;
          default: item.click(item, window, {});
        }
      });
    } else commands.set(id, () => { throw new Error('This menu command is not available.'); });
    return {
      id, label: item.label, enabled, separator: item.type === 'separator',
      checked: item.type === 'checkbox' ? item.checked : undefined,
      shortcut: item.accelerator?.replace(/CommandOrControl|CmdOrCtrl/g, 'Ctrl'),
      submenu: item.submenu ? serialize(item.submenu, enabled) : undefined,
      icon: structureDetails[item.id]?.icon ?? publishingTemplates.find(template => template.id === item.id)?.icon,
      description: item.id === 'publishing-selector' ? variantInsertionTemplate(Boolean(editorContext.hasVariantSelector)).description :
        structureDetails[item.id]?.description ?? publishingTemplates.find(template => template.id === item.id)?.description,
    };
  });
  const model = serialize(native);
  const id = randomUUID();
  contextMenu = { id, native, commands, x, y };
  window.webContents.send('editor:context-menu', { id, x, y, items: model });
}

function paragraphItems(): MenuItemConstructorOptions[] {
  return Array.from({ length: 7 }, (_, index) => {
    const level = index === 6 ? 0 : index + 1;
    return {
      label: level ? `Heading ${level}` : 'Paragraph',
      id: `paragraph-${level}`,
      type: 'checkbox', checked: editorContext.heading === level,
      accelerator: `CmdOrCtrl+${level}`, click: () => action(`heading:${level}`),
    };
  });
}

function insertItems(): MenuItemConstructorOptions[] {
  return [
    { label: 'Image...', accelerator: 'CmdOrCtrl+Shift+I', click: () => action('image') },
    { label: 'Table', accelerator: 'CmdOrCtrl+T', click: () => action('table') },
    { label: 'Code fence', accelerator: 'CmdOrCtrl+Shift+K', click: () => action('format:codeblock') },
    { label: 'Alerts', submenu: publishingTemplates.filter(item => item.category === 'alerts').map(item => ({ id: item.id, label: item.label, click: () => action(`insert:${item.id}`) })) },
    { label: 'Structure', submenu: [
      { id: 'structure-toc', label: 'Table of contents', click: () => action('insert:toc') },
      { id: 'structure-mermaid', label: 'Mermaid diagram', click: () => action('insert:mermaid') },
      { id: 'structure-rule', label: 'Horizontal rule', click: () => action('format:rule') },
      ...publishingTemplates.filter(item => ['publishing-metadata', 'publishing-image', 'publishing-include'].includes(item.id)).map(item => ({
        id: item.id, label: item.label, click: () => action(`insert:${item.id}`),
      })),
    ] },
    { label: 'Interactive', submenu: [
      ...publishingTemplates.filter(item => ['publishing-tabs', 'publishing-selector'].includes(item.id)).map(item => ({
        id: item.id, label: item.id === 'publishing-selector' ? variantInsertionTemplate(Boolean(editorContext.hasVariantSelector)).label : item.label,
        click: () => action(`insert:${item.id}`),
      })),
    ] },
    { label: 'Footnote (Markdown)', click: () => action('insert:footnote') },
    { label: 'Link...', accelerator: 'CmdOrCtrl+K', click: () => action('link') },
    { label: 'Link reference (Markdown)', click: () => action('insert:reference') },
    { label: 'Horizontal line', click: () => action('format:rule') },
    { label: 'Math block (Markdown)', accelerator: 'CmdOrCtrl+Shift+M', click: () => action('insert:math') },
    { label: 'Mermaid diagram', click: () => action('insert:mermaid') },
    { label: 'YAML front matter (Markdown)', click: () => action('insert:frontmatter') },
    { type: 'separator' },
    { label: 'Paragraph before', click: () => action('insert:before') },
    { label: 'Paragraph after', click: () => action('insert:after') },
  ];
}

function blockItems(contextual = true): MenuItemConstructorOptions[] {
  const visual = !contextual || editorContext.mode === 'visual';
  return [
    { label: 'Move block up', accelerator: 'Alt+Shift+Up', registerAccelerator: false, enabled: visual, click: () => action('block:up') },
    { label: 'Move block down', accelerator: 'Alt+Shift+Down', registerAccelerator: false, enabled: visual, click: () => action('block:down') },
    { label: 'Duplicate block', enabled: visual, click: () => action('block:duplicate') },
    { label: 'Remove block', enabled: visual, click: () => action('block:remove') },
  ];
}

async function validateRaster(data: Buffer, mime: string): Promise<void> {
  if (!nativeImage.createFromBuffer(data).isEmpty()) return;
  // NativeImage only decodes PNG/JPEG; Chromium also validates GIF/WebP in an isolated sandbox.
  const decoder = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `image-decoder-${randomUUID()}`,
    },
  });
  try {
    decoder.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    decoder.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    decoder.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
    await decoder.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:">');
    const source = `data:${mime};base64,${data.toString('base64')}`;
    const valid: unknown = await decoder.webContents.executeJavaScript(`
      (async () => {
        const image = new Image();
        image.src = ${JSON.stringify(source)};
        try {
          await image.decode();
          return image.naturalWidth > 0 && image.naturalHeight > 0;
        } catch { return false; }
      })()
    `);
    if (valid !== true) throw new Error('This image could not be decoded. Choose a valid PNG, JPEG, GIF, or WebP image.');
  } finally { decoder.destroy(); }
}

async function exportPDF(content: string, documentPath: string | null, loadDiagram?: DiagramImageLoader, imageRoot?: AuthorizedImageRoots, tokens?: Token[]): Promise<Buffer> {
  const html = await toPrintHTML(content, documentPath, loadDiagram, imageRoot, tokens);
  const printWindow = new BrowserWindow({
    show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true },
  });
  try {
    printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await printWindow.webContents.executeJavaScript(`
      (async () => {
        await document.fonts.ready;
        await Promise.all(Array.from(document.images, image => image.decode()));
      })()
    `);
    return await printWindow.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true,
      generateTaggedPDF: true, generateDocumentOutline: true,
    });
  } finally { printWindow.destroy(); }
}

async function exportWithDiagrams(content: string, currentPath: string | null, format: 'pdf' | 'docx' | 'html', imageRoot: AuthorizedImageRoots, tokens: Token[]): Promise<Buffer> {
  const diagrams = tokens.filter(token => token.type === 'fence' && isMermaidLanguage(token.info));
  if (diagrams.length > diagramLimits.diagrams) throw new Error('Export supports at most 32 Mermaid diagrams.');
  for (const diagram of diagrams) prepareMermaid(diagram.content);
  let renderer: BrowserWindow | undefined;
  const images = new Map<string, { data: Buffer; mime: 'image/png' }>();
  const loadDiagram: DiagramImageLoader = async source => {
    const cached = images.get(source);
    if (cached) return cached;
    if (!renderer) {
      renderer = new BrowserWindow({
        show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'lekh-diagrams' },
      });
      renderer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      renderer.webContents.on('will-navigate', event => event.preventDefault());
      renderer.webContents.session.webRequest.onBeforeRequest((request, callback) => {
        callback({ cancel: !request.url.startsWith('file:') && !request.url.startsWith('data:') });
      });
      await renderer.loadFile(path.join(app.getAppPath(), 'dist', 'diagram-export.html'));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const png: unknown = await Promise.race([
        renderer.webContents.executeJavaScript(`window.lekhRenderDiagram(${JSON.stringify(source)})`),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            renderer?.destroy();
            reject(new Error('Mermaid export exceeded ten seconds. Simplify the diagram.'));
          }, 10000);
        }),
      ]);
      if (typeof png !== 'string' || png.length > diagramLimits.pngBytes * 4 / 3 + 32 || !png.startsWith('data:image/png;base64,')) {
        throw new Error('Diagram renderer returned an invalid PNG.');
      }
      const data = Buffer.from(png.slice('data:image/png;base64,'.length), 'base64');
      const image = nativeImage.createFromBuffer(data);
      if (image.isEmpty()) throw new Error('Diagram PNG could not be decoded.');
      const { width, height } = image.getSize();
      if (width > 4096 || height > 4096 || width * height > 8_000_000) throw new Error('Diagram PNG exceeds the export dimensions.');
      const result = { data, mime: 'image/png' as const };
      images.set(source, result);
      return result;
    } finally { clearTimeout(timer); }
  };
  try {
    if (format === 'pdf') return await exportPDF(content, currentPath, loadDiagram, imageRoot, tokens);
    if (format === 'html') return Buffer.from(await toOfflineHTML(content, currentPath, loadDiagram, imageRoot, validateRaster, tokens), 'utf8');
    return await toDocx(content, source => readImage(source, currentPath, imageRoot), loadDiagram, tokens);
  } finally { if (renderer && !renderer.isDestroyed()) renderer.destroy(); }
}

async function validateIncludeRoot(folder: string, documentPath: string): Promise<string> {
  const root = await realpath(folder);
  const file = await realpath(documentPath);
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Choose a project folder that contains both this saved document and its include files.');
  }
  return root;
}

interface PreparedDocument {
  prepared: string;
  tokens: Token[];
  currentPath: string | null;
  imageAccess: string[];
  assertAccess: () => void;
}

async function prepareDocument(id: unknown, content: string, preview = false): Promise<PreparedDocument> {
  const document = documentFor(id);
  const currentPath = document.path;
  const imageGrant = imageRoots.get(String(id));
  const includeGrant = includeRoots.get(String(id));
  const assertAccess = () => {
    if (documentFor(id) !== document || document.path !== currentPath ||
        imageRoots.get(String(id)) !== imageGrant || includeRoots.get(String(id)) !== includeGrant) {
      throw new Error('The document or its local folder access changed. Try again.');
    }
  };
  const selectedVariantFile = sharedVariantFiles.get(String(id));
  const prepared = /^zone_pivot_groups\s*:/m.test(content)
    ? selectedVariantFile
      ? await prepareVariantConfigurationFromFile(content, selectedVariantFile)
      : await prepareVariantConfiguration(content, currentPath, imageGrant?.root ?? null)
    : content;
  assertAccess();
  let resolvedDocument: string | undefined;
  const candidates: string[] = [];
  let tokens = await resolveIncludes(prepared, currentPath, includeGrant?.root, {
    displayErrors: true,
    preview,
    onAccessRequired: (file, candidate) => { resolvedDocument = file; candidates.push(candidate); },
  });
  assertAccess();
  if (currentPath && resolvedDocument && candidates.length) {
    const suggested = suggestedIncludeFolder(resolvedDocument, includeGrant ? [...candidates, includeGrant.root] : candidates);
    if (suggested) {
      const allowed = await includePrompts.request(String(id), suggested, async () => {
        const answer = await dialog.showMessageBox(window, {
          type: 'question',
          message: 'Allow this document to load shared files?',
          detail: `This document refers to Markdown includes outside its folder, including:\n${candidates[0]}\n\nAllow local Markdown includes and their images within:\n${suggested}\n\nAccess applies only to this document and ends when it is closed or saved in another folder.`,
          buttons: ['Allow folder', 'Not now'], defaultId: 1, cancelId: 1, noLink: true,
        });
        assertAccess();
        if (answer.response !== 0) return false;
        const root = await validateIncludeRoot(suggested, currentPath);
        assertAccess();
        if (!samePath(root, suggested)) throw new Error('The suggested project folder changed. Choose the folder again.');
        includeRoots.set(String(id), { root });
        window.webContents.send('includes:access-changed', String(id));
        return true;
      });
      if (allowed) return prepareDocument(id, content, preview);
      assertAccess();
    }
  }
  if (!preview && tokens.some(token =>
    token.type === 'publishing_unsupported' && (token.meta as PublishingMeta).kind === 'include')) {
    tokens = await resolveIncludes(prepared, currentPath, includeGrant?.root);
    assertAccess();
  }
  const imageAccess = [imageGrant?.root, includeGrant?.root].filter((root): root is string => Boolean(root));
  return { prepared, tokens, currentPath, imageAccess, assertAccess };
}

function installIPC(): void {
  ipcMain.on('editor:paste', event => { assertSender(event); paste(); });
  handle('app:theme', async (value: unknown) => {
    const theme = themes.find(theme => theme.id === value);
    if (!theme) throw new Error('Unsupported color theme.');
    nativeTheme.themeSource = theme.dark ? 'dark' : 'light';
    window.setBackgroundColor(theme.background);
    const item = Menu.getApplicationMenu()?.getMenuItemById(`theme-${value}`);
    if (item) item.checked = true;
  });
  handle('editor:clipboard-read', async () => {
    const text = clipboard.readText();
    contentArgument(text);
    return text;
  });
  handle('editor:context-menu-command', async (id: unknown, command: unknown) => {
    if (!contextMenu || contextMenu.id !== id || typeof command !== 'string') throw new Error('This context menu is no longer open.');
    const current = contextMenu;
    if (command === 'native') {
      contextMenu = null;
      current.native.popup({ window, x: current.x, y: current.y });
      return;
    }
    const execute = current.commands.get(command);
    if (!execute) throw new Error('Unknown context menu command.');
    contextMenu = null;
    execute();
  });
  handle('editor:clipboard-write', async (text: unknown) => {
    contentArgument(text);
    clipboard.writeText(text);
  });
  handle('editor:clipboard-image', async () => {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const data = image.toPNG();
    if (data.length > MAX_IMAGE_BYTES) throw new Error('The clipboard image exceeds the 20 MB image limit.');
    return `data:image/png;base64,${data.toString('base64')}`;
  });
  handle('document:store-image', async (id: unknown, source: unknown, storage: unknown) => {
    const document = documentFor(id);
    return storeImage(source, document.path, storage, validateRaster);
  });
  handle('editor:copy-image', async (id: unknown, source: unknown) => {
    contentArgument(source);
    const grant = imageRoots.get(String(id));
    const includeGrant = includeRoots.get(String(id));
    const roots = [grant?.root, includeGrant?.root].filter((root): root is string => Boolean(root));
    const { data } = await readImage(source, documentFor(id).path, roots);
    if (imageRoots.get(String(id)) !== grant || includeRoots.get(String(id)) !== includeGrant) throw new Error('Local image access changed. Try copying the image again.');
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) throw new Error('This image could not be decoded for copying.');
    clipboard.writeImage(image);
  });
  ipcMain.on('editor:context', (event, context: EditorContext) => {
    assertSender(event);
    if (!context || !['visual', 'source'].includes(context.mode) || !Array.isArray(context.active)
      || !context.active.every(item => typeof item === 'string') || !Number.isInteger(context.heading)
      || context.heading < 0 || context.heading > 6 || typeof context.inTable !== 'boolean'
      || context.hasVariantSelector !== undefined && typeof context.hasVariantSelector !== 'boolean'
      || context.hasInteractivePublishing !== undefined && typeof context.hasInteractivePublishing !== 'boolean'
      || context.formField !== undefined && typeof context.formField !== 'boolean'
      || context.view !== undefined && !['visual', 'source', 'split'].includes(context.view)
      || context.preview !== undefined && typeof context.preview !== 'boolean'
      || context.previewSource !== undefined && typeof context.previewSource !== 'boolean') {
      console.error('Invalid editor context.');
      return;
    }
    editorContext = context;
    for (const view of ['visual', 'source', 'split']) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(`view-${view}`);
      if (item) item.checked = !context.preview && (context.view ?? context.mode) === view;
    }
    const previewItem = Menu.getApplicationMenu()?.getMenuItemById('view-preview');
    if (previewItem) previewItem.label = context.preview ? 'Back to editing' : 'Preview';
    const previewSourceItem = Menu.getApplicationMenu()?.getMenuItemById('view-preview-source');
    if (previewSourceItem) {
      previewSourceItem.enabled = Boolean(context.preview);
      previewSourceItem.checked = Boolean(context.preview && context.previewSource);
    }
    const variantTool = Menu.getApplicationMenu()?.getMenuItemById('publishing-selector');
    if (variantTool) variantTool.label = variantInsertionTemplate(Boolean(context.hasVariantSelector)).label;
    const exportHint = Menu.getApplicationMenu()?.getMenuItemById('export-interactive-hint');
    const interactive = Boolean(context.hasInteractivePublishing);
    if (exportHint) exportHint.visible = interactive;
    for (const id of ['export-docx', 'export-pdf']) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (item) item.enabled = !interactive;
    }
    for (let level = 0; level <= 6; level++) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(`paragraph-${level}`);
      if (item) item.checked = context.heading === level;
    }
  });
  handle('document:recent', async () => recentFiles);
  handle('app:zoom', async (command: unknown) => {
    if (command !== undefined) {
      if (command !== 'in' && command !== 'out' && command !== 'reset') throw new Error('Choose Zoom in, Zoom out, or Reset zoom.');
      const current = window.webContents.getZoomLevel();
      const level = command === 'reset' ? 0 : current + (command === 'in' ? 0.5 : -0.5);
      window.webContents.setZoomLevel(Math.max(Math.log(0.5) / Math.log(1.2), Math.min(Math.log(3) / Math.log(1.2), level)));
    }
    return window.webContents.getZoomFactor();
  });
  handle('document:clear-recent', async () => {
    await atomicWrite(recentPath(), '[]');
    recentFiles = [];
  });
  handle('document:open-pending', async (): Promise<Result<OpenedFile>[]> => {
    rendererReady = true;
    const results: Result<OpenedFile>[] = [];
    for (const file of pendingFiles.splice(0)) {
      try { results.push({ ok: true, value: await openDocument(file) }); }
      catch (error) {
        console.error('Could not open requested file:', file, error);
        results.push({ ok: false, error: `Could not open "${file}": ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return results;
  });
  handle('document:open', async (recent?: string) => {
    let file: string;
    if (recent !== undefined) {
      if (typeof recent !== 'string' || !recentFiles.includes(recent)) throw new Error('Choose a file using Open.');
      file = recent;
    } else {
      const selected = await dialog.showOpenDialog(window, {
        title: 'Open Markdown in a new tab', properties: ['openFile'],
        filters: [{ name: 'Markdown and text', extensions: ['md', 'markdown', 'mdown', 'txt'] }, { name: 'All files', extensions: ['*'] }],
      });
      if (selected.canceled) return null;
      file = selected.filePaths[0];
    }
    return openDocument(file);
  });
  handle('document:new', async () => {
    const id = randomUUID();
    documents.set(id, { path: null, diskContent: null });
    return id;
  });
  handle('document:release', async (id: unknown) => {
    documentFor(id);
    documents.delete(String(id));
    imageRoots.delete(String(id));
    includeRoots.delete(String(id));
    relationshipWorkspaces.delete(String(id));
    includePrompts.forget(String(id));
    sharedVariantFiles.delete(String(id));
    for (const [token, pending] of pendingVariantFiles) if (pending.id === String(id)) pendingVariantFiles.delete(token);
  });
  handle('images:allow-folder', async (id: unknown) => {
    const document = documentFor(id);
    if (!document.path) throw new Error('Save this document before allowing access to a project image folder.');
    const selected = await dialog.showOpenDialog(window, {
      title: 'Allow project images and variant labels for this document', buttonLabel: 'Allow this folder',
      properties: ['openDirectory'],
    });
    if (selected.canceled) return false;
    const root = await realpath(selected.filePaths[0]);
    const file = await realpath(document.path);
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Choose a project folder that contains this saved document.');
    }
    imageRoots.set(String(id), { root });
    return true;
  });
  handle('variant-config:prepare', async (id: unknown, content: unknown) => {
    const document = documentFor(id);
    contentArgument(content);
    const grant = imageRoots.get(String(id));
    const selectedFile = sharedVariantFiles.get(String(id));
    const prepared = selectedFile
      ? await prepareVariantConfigurationFromFile(content, selectedFile)
      : await prepareVariantConfiguration(content, document.path, grant?.root ?? null);
    if (imageRoots.get(String(id)) !== grant) throw new Error('Local asset access changed. Refresh the preview.');
    return prepared;
  });
  handle('variant-config:choose-file', async (id: unknown) => {
    const document = documentFor(id);
    const documentPath = document.path;
    const selected = await dialog.showOpenDialog(window, {
      title: 'Choose an existing shared selector file',
      properties: ['openFile'],
      filters: [{ name: 'Shared selector files', extensions: ['yml', 'yaml'] }],
    });
    if (selected.canceled) return null;
    if (documentFor(id) !== document || document.path !== documentPath) throw new Error('The active document changed. Choose the shared file again.');
    const file = await realpath(selected.filePaths[0]);
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Choose an existing configuration file no larger than 1 MB.');
    if (!/\.ya?ml$/i.test(file)) throw new Error('Choose an existing .yml or .yaml configuration file.');
    const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
    if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw new Error('The shared configuration file exceeds the 1 MB limit.');
    const after = await stat(file);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error('The shared configuration changed while it was being read. Choose it again.');
    }
    variantGroupIds(content);
    for (const [token, pending] of pendingVariantFiles) if (pending.id === String(id)) pendingVariantFiles.delete(token);
    const token = randomUUID();
    const relative = documentPath ? path.relative(path.dirname(documentPath), file) : '';
    const label = relative && !path.isAbsolute(relative) ? relative : file;
    pendingVariantFiles.set(token, { id: String(id), document, documentPath, file, content, label });
    sharedVariantFiles.set(String(id), file);
    if (documentPath) await rememberVariantAssociation(documentPath, file);
    return { token, label };
  });
  handle('variant-config:create-group', async (id: unknown, token: unknown, value: unknown, content: unknown) => {
    const document = documentFor(id);
    contentArgument(content);
    if (typeof token !== 'string' || !isSharedVariantGroup(value)) throw new Error('Choose a shared file and enter a valid group.');
    const pending = pendingVariantFiles.get(token);
    if (!pending || pending.id !== String(id) || pending.document !== document || pending.documentPath !== document.path) {
      throw new Error('The selected shared file is no longer available. Choose it again.');
    }
    const file = await realpath(pending.file);
    if (!samePath(file, pending.file)) throw new Error('The selected shared file changed. Choose it again.');
    const latest = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
    if (latest !== pending.content) throw new Error('The shared file changed after you selected it. Choose it again to review the latest contents.');
    const updatedFile = appendVariantGroupEntry(latest, value);
    const updatedContent = addVariantMetadata(content, value.id);
    await atomicWriteIfUnchanged(file, latest, updatedFile);
    sharedVariantFiles.set(String(id), file);
    pendingVariantFiles.delete(token);
    return { content: updatedContent, file: pending.label };
  });
  handle('images:revoke-folder', async (id: unknown) => {
    documentFor(id);
    imageRoots.delete(String(id));
  });
  handle('includes:allow-folder', async (id: unknown) => {
    const document = documentFor(id);
    const currentPath = document.path;
    if (!currentPath) throw new Error('Save this document before allowing an include folder.');
    const selected = await dialog.showOpenDialog(window, {
      title: 'Allow local includes and their images for this document', buttonLabel: 'Allow this folder',
      properties: ['openDirectory'],
    });
    if (selected.canceled) return false;
    if (documentFor(id) !== document || document.path !== currentPath) throw new Error('The document changed. Choose the folder again.');
    const root = await validateIncludeRoot(selected.filePaths[0], currentPath);
    if (documentFor(id) !== document || document.path !== currentPath) throw new Error('The document changed. Choose the folder again.');
    includeRoots.set(String(id), { root });
    window.webContents.send('includes:access-changed', String(id));
    return true;
  });
  handle('includes:revoke-folder', async (id: unknown) => {
    documentFor(id);
    const grant = includeRoots.get(String(id));
    if (grant) includePrompts.deny(String(id), grant.root);
    includeRoots.delete(String(id));
    window.webContents.send('includes:access-changed', String(id));
  });
  handle('includes:preview', async (id: unknown, content: unknown) => {
    contentArgument(content);
    const { tokens, assertAccess } = await prepareDocument(id, content, true);
    const anchors = new Map<string, number>();
    for (const [index, token] of tokens.entries()) {
      if (token.type === 'heading_open') token.attrSet('id', headingAnchor(tokens[index + 1].content, anchors));
    }
    const html = documentPreviewTokensHTML(tokens, String(id));
    assertAccess();
    return html;
  });
  handle('includes:interactive', async (id: unknown, content: unknown) => {
    contentArgument(content);
    const { tokens, assertAccess } = await prepareDocument(id, content);
    const interactive = hasInteractivePublishing(tokens);
    assertAccess();
    return interactive;
  });
  handle('learn:check-paths', async (id: unknown, sources: unknown) => {
    const document = documentFor(id);
    const roots = [imageRoots.get(String(id))?.root, includeRoots.get(String(id))?.root].filter((root): root is string => Boolean(root));
    return learnPathStatuses(sources, document.path, roots);
  });
  handle('relationships:workspace', async (id: unknown, revoke: unknown) => {
    const document = documentFor(id);
    if (typeof revoke !== 'boolean') throw new Error('Invalid workspace request.');
    if (revoke) { relationshipWorkspaces.delete(String(id)); return null; }
    const currentPath = document.path;
    if (!currentPath) throw new Error('Save this document before choosing a relationship workspace.');
    const selected = await dialog.showOpenDialog(window, {
      title: 'Choose a workspace to scan Markdown include relationships',
      buttonLabel: 'Allow local Markdown scan', properties: ['openDirectory'],
      defaultPath: includeRoots.get(String(id))?.root ?? path.dirname(currentPath),
    });
    if (selected.canceled) return null;
    const root = await validateWorkspace(selected.filePaths[0], currentPath);
    if (documentFor(id) !== document || document.path !== currentPath) throw new Error('The document changed. Choose the workspace again.');
    const cached = [...relationshipWorkspaces.values()].find(workspace => samePath(workspace.root, root) && workspace.index);
    relationshipWorkspaces.set(String(id), { root, index: cached?.index });
    return root;
  });
  handle('relationships:query', async (id: unknown, content: unknown, source: unknown, refresh: unknown) => {
    const document = documentFor(id);
    contentArgument(content);
    if ((source !== null && (typeof source !== 'string' || source.length > 4096)) || typeof refresh !== 'boolean') throw new Error('Invalid relationship request.');
    const grant = relationshipWorkspaces.get(String(id));
    if (!grant || !document.path) return null;
    const currentPath = document.path;
    const request = grant.request = (grant.request ?? 0) + 1;
    const assertAccess = () => {
      if (documents.get(String(id)) !== document || document.path !== currentPath || relationshipWorkspaces.get(String(id)) !== grant) {
        throw new Error('Workspace access or the document changed. Choose the workspace again.');
      }
    };
    if (refresh && !grant.pending) grant.index = undefined;
    if (!grant.index) {
      if (!grant.pending) grant.pending = scanRepository(grant.root, { assertAccess });
      const pending = grant.pending;
      try { grant.index = await pending; }
      finally { if (grant.pending === pending) grant.pending = undefined; }
    }
    assertAccess();
    if (request !== grant.request) return null;
    return relationshipReport(grant.index, currentPath, content, source, assertAccess);
  });
  handle('relationships:open', async (id: unknown, relative: unknown) => {
    const document = documentFor(id), grant = relationshipWorkspaces.get(String(id));
    if (!grant?.index || !document.path || typeof relative !== 'string' || relative.length > 4096 || path.isAbsolute(relative)) throw new Error('Refresh relationships before opening a matching article.');
    const currentPath = document.path;
    const file = await realpath(path.resolve(grant.root, relative));
    if (!withinWorkspace(grant.root, file) || ![...grant.index.files.values()].some(entry => samePath(entry.file, file))) throw new Error('Choose a Markdown article listed in this workspace.');
    // Keep an existing tab's identity when Windows used an equivalent 8.3 path.
    let openPath = file;
    for (const existing of documents.values()) {
      if (!existing.path) continue;
      try {
        if (samePath(await realpath(existing.path), file)) { openPath = existing.path; break; }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code))) throw error;
      }
    }
    const content = await readMarkdown(file);
    if (documents.get(String(id)) !== document || document.path !== currentPath || relationshipWorkspaces.get(String(id)) !== grant) throw new Error('Workspace access changed. Refresh relationships.');
    const opened = await openDocument(openPath, content);
    if (!relationshipWorkspaces.has(opened.id)) relationshipWorkspaces.set(opened.id, { root: grant.root, index: grant.index });
    return opened;
  });
  handle('document:save', async (id: unknown, content: unknown, saveAs: unknown) => {
    const document = documentFor(id);
    const currentPath = document.path;
    contentArgument(content);
    if (typeof saveAs !== 'boolean') throw new Error('Invalid save request.');
    let file = currentPath;
    if (!file || saveAs) {
      const selected = await dialog.showSaveDialog(window, {
        title: 'Save Markdown', defaultPath: file ?? 'Untitled.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (selected.canceled || !selected.filePath) return null;
      file = selected.filePath;
    }
    if ([...documents].some(([otherId, other]) => otherId !== id && other.path && samePath(other.path, file))) {
      throw new Error('That file is already open in another tab. Switch to that tab, or choose a different filename.');
    }
    if (currentPath && path.dirname(file) !== path.dirname(currentPath)) {
      const relativeImages = parser.parse(content, {}).some(token => token.children?.some(child => {
        const source = child.attrGet('src') ?? '';
        return child.type === 'image' && !/^[a-z][a-z\d+.-]*:/i.test(source);
      }));
      if (relativeImages) {
        const approval = await dialog.showMessageBox(window, {
          type: 'warning', message: 'This document uses relative image paths.',
          detail: 'Saving in another folder will not copy the image files. Copy the images to the same relative locations in the new folder, or cancel and use Insert image to embed them first.',
          buttons: ['Save in new folder', 'Cancel'], defaultId: 1, cancelId: 1,
        });
        if (approval.response !== 0) return null;
      }
    }
    if (currentPath && samePath(file, currentPath)) {
      let actual: string | null = null;
      try { actual = await readMarkdown(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (actual !== document.diskContent) {
        throw new Error('This file changed or was removed outside Lekh. Your edits have not been overwritten. Use Save As to save your version under a different name, then reopen the original to compare.');
      }
    }
    await atomicWrite(file, content);
    if (currentPath && !samePath(path.dirname(file), path.dirname(currentPath))) {
      includeRoots.delete(String(id));
      includePrompts.forget(String(id));
    }
    if (currentPath && !samePath(file, currentPath)) relationshipWorkspaces.delete(String(id));
    document.path = file;
    document.diskContent = content;
    const sharedVariantFile = sharedVariantFiles.get(String(id));
    if (sharedVariantFile) {
      try { await rememberVariantAssociation(file, sharedVariantFile); }
      catch (error) {
        console.error('Could not remember the shared selector file for this document:', error);
        await dialog.showMessageBox(window, {
          type: 'warning',
          message: 'The article was saved, but its shared selector file could not be remembered.',
          detail: 'Choose the shared file again after reopening this article.\n\n' + String(error),
        });
      }
    }
    await remember(file);
    return { path: file };
  });
  handle('document:confirm', async (name: unknown) => {
    if (typeof name !== 'string') throw new Error('Missing document name.');
    const result = await dialog.showMessageBox(window, {
      type: 'question', message: `Save changes to "${name}" before continuing?`,
      detail: 'Unsaved changes will be lost if you choose Discard.',
      buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
    });
    return (['save', 'discard', 'cancel'] as const)[result.response];
  });
  handle('document:image', async () => {
    const selection = await dialog.showOpenDialog(window, {
      title: 'Insert image', properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    });
    if (selection.canceled) return null;
    const file = selection.filePaths[0];
    if ((await stat(file)).size > MAX_IMAGE_BYTES) throw new Error('Choose an image smaller than 20 MB.');
    const source = `data:${imageMime(file)};base64,${(await readFile(file)).toString('base64')}`;
    const { data, mime } = embeddedImage(source);
    await validateRaster(data, mime);
    return source;
  });
  handle('document:export', async (id: unknown, content: unknown, format: unknown) => {
    const currentPath = documentFor(id).path;
    contentArgument(content);
    if (format !== 'pdf' && format !== 'docx' && format !== 'html') throw new Error('Unsupported export format.');
    if (format !== 'html' && requiresInteractiveExport(content)) throw new Error(interactiveExportMessage);
    const { prepared, tokens, imageAccess, assertAccess } = await prepareDocument(id, content);
    assertAccess();
    if (format !== 'html' && hasInteractivePublishing(tokens)) throw new Error(interactiveExportMessage);
    const selection = await dialog.showSaveDialog(window, {
      title: `Export ${format.toUpperCase()}`,
      defaultPath: currentPath ? path.join(path.dirname(currentPath), `${path.parse(currentPath).name}.${format}`) : `Untitled.${format}`,
      filters: [{ name: format === 'pdf' ? 'PDF document' : format === 'docx' ? 'Word document' : 'HTML document', extensions: [format] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    if ([...documents.values()].some(document => document.path && samePath(selection.filePath!, document.path))) {
      throw new Error('Export cannot replace an open Markdown source file.');
    }
    assertAccess();
    const data = await exportWithDiagrams(prepared, currentPath, format, imageAccess, tokens);
    assertAccess();
    try { await atomicWrite(selection.filePath, data); }
    catch (error) { throw exportWriteError(selection.filePath, error); }
    return selection.filePath;
  });
  handle('app:external', async (url: unknown) => {
    if (typeof url !== 'string' || !isSafeLink(url)) throw new Error('Only web and email links can be opened.');
    const approval = await dialog.showMessageBox(window, {
      message: 'Open this link in your default application?', detail: url,
      buttons: ['Open link', 'Cancel'], defaultId: 1, cancelId: 1,
    });
    if (approval.response === 0) await shell.openExternal(url);
  });
  ipcMain.on('document:dirty', (event, value: unknown) => {
    assertSender(event);
    if (typeof value !== 'boolean') return;
    dirty = value;
    window.setDocumentEdited(dirty);
  });
  ipcMain.on('document:close', event => { assertSender(event); allowClose = true; window.close(); });
}

function viewAndToolsItems(): MenuItemConstructorOptions[] {
  return [
    { label: 'Command palette...', accelerator: 'CmdOrCtrl+Shift+P', registerAccelerator: false, click: () => action('command-palette') },
    { type: 'separator' },
    { label: 'Visual', type: 'checkbox', checked: !editorContext.preview && (editorContext.view ?? editorContext.mode) === 'visual', click: () => action('visual') },
    { label: 'Markdown', type: 'checkbox', checked: !editorContext.preview && (editorContext.view ?? editorContext.mode) === 'source', click: () => action('source') },
    { label: 'Split (Visual and Markdown)', type: 'checkbox', checked: !editorContext.preview && editorContext.view === 'split', click: () => action('edit-split') },
    { label: editorContext.preview ? 'Back to editing' : 'Preview', click: () => action('preview') },
    { label: 'Show Markdown beside preview', type: 'checkbox', enabled: Boolean(editorContext.preview), checked: Boolean(editorContext.preview && editorContext.previewSource), click: () => action('preview-source') },
    { label: 'Split / Unsplit files', click: () => action('split') },
    { type: 'separator' },
    { label: 'Writing assistance', click: () => action('writing-assistance') },
    { label: 'Learn checks', click: () => action('learn-checks') },
    { label: 'Include relationships', click: () => action('include-relationships') },
    { label: 'Getting started', click: () => action('help') },
  ];
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 850, minHeight: 600, backgroundColor: '#f8faf8',
    title: productTitle,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'electron', 'preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true,
    },
  });
  window.webContents.on('did-start-loading', () => { rendererReady = false; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('context-menu', (_event, parameters) => {
    const items: MenuItemConstructorOptions[] = [];
    if (parameters.misspelledWord) {
      items.push({ label: 'Spelling suggestions', submenu: parameters.dictionarySuggestions.length
        ? parameters.dictionarySuggestions.map(suggestion => ({ label: suggestion, click: () => window.webContents.replaceMisspelling(suggestion) }))
        : [{ label: 'No spelling suggestions', enabled: false }] });
    }
    if (parameters.isEditable && editorContext.formField) {
      items.push({ role: 'cut', enabled: parameters.editFlags.canCut }, { role: 'copy', enabled: parameters.editFlags.canCopy },
        { role: 'paste' }, { role: 'selectAll' });
      showContextMenu(items, parameters.x, parameters.y);
      return;
    }
    if (parameters.isEditable) {
      if (parameters.linkURL) items.push({ label: 'Edit link...', click: () => action('link') }, { type: 'separator' });
      items.push(
        { role: 'cut', enabled: parameters.editFlags.canCut },
        { role: 'copy', enabled: parameters.editFlags.canCopy || parameters.mediaType === 'image' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: paste },
      );
      items.push(
        { label: 'Delete selection', enabled: Boolean(parameters.selectionText), click: () => window.webContents.delete() },
        { label: 'Edit', submenu: [
          { label: 'Undo', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false, click: () => action('undo') },
          { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', registerAccelerator: false, click: () => action('redo') },
          { role: 'selectAll' },
          { type: 'separator' },
          { label: 'Copy / Paste As', submenu: [
          { label: 'Copy selection as Markdown', enabled: Boolean(parameters.selectionText), click: () => action('copy-markdown') },
          { label: 'Copy document as Markdown', click: () => action('copy-document') },
          { type: 'separator' }, { role: 'pasteAndMatchStyle', label: 'Paste as plain text' },
          { label: 'Paste as Markdown', click: () => action('paste-markdown') },
          { label: 'Paste image', enabled: !clipboard.readImage().isEmpty(), click: () => action('paste-image') },
          ] },
          { type: 'separator' }, ...blockItems(),
        ] },
        { label: 'Formatting', submenu: [
          ...[
            ['bold', 'Bold'], ['italic', 'Italic'], ['strike', 'Strikethrough'], ['code', 'Inline code'],
            ['quote', 'Block quote'], ['bullet', 'Bullet list'], ['ordered', 'Numbered list'], ['task', 'Task list'],
          ].map(([command, label]): MenuItemConstructorOptions => ({
            label, type: 'checkbox', checked: editorContext.active.includes(command), click: () => action(`format:${command}`),
            accelerator: formattingShortcuts.find(item => item.command === command)?.accelerator,
            registerAccelerator: false,
          })),
          { type: 'separator' }, { label: 'Clear formatting', enabled: editorContext.mode === 'visual', click: () => action('format:clear') },
        ] },
        { label: 'Paragraph', submenu: paragraphItems() },
        { label: 'Insert', submenu: insertItems() },
        { label: 'View and tools', submenu: viewAndToolsItems() },
        { label: 'Table', submenu: [
          { label: 'Insert table...', click: () => action('table') },
          { type: 'separator' },
          ...[
            ['row', 'Add row after'], ['column', 'Add column after'],
            ['delete-row', 'Remove row'], ['delete-column', 'Remove column'],
            ['delete-table', 'Remove table'],
          ].map(([command, label]): MenuItemConstructorOptions => ({
            label, enabled: editorContext.mode === 'visual' && editorContext.inTable,
            click: () => action(command),
          })),
        ] },
      );
    } else {
      if (parameters.selectionText) items.push({ role: 'copy' });
      if (editorContext.preview) items.push({ label: 'View and tools', submenu: viewAndToolsItems() });
    }
    if (parameters.mediaType === 'image') {
      items.push({ label: 'Copy image', click: () => action('copy-image') });
    }
    if (items.length) showContextMenu(items, parameters.x, parameters.y);
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = ['file:', 'data:', 'lekh-image:'].includes(new URL(details.url).protocol);
    callback({ cancel: !allowed });
  });
  window.on('close', event => {
    if (!allowClose && dirty) { event.preventDefault(); action('close'); }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox('The editor stopped unexpectedly', `Reason: ${details.reason}. Reopen ${productName} and use Recover draft if it is available. Your saved Markdown files have not been changed.`);
  });
  const send = (command: string) => () => action(command);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '&File', submenu: [
      { label: 'New', accelerator: 'CmdOrCtrl+N', click: send('new') },
      { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: send('open') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
      { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-as') },
      { label: 'Save All', accelerator: 'CmdOrCtrl+Alt+S', click: send('save-all') },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
      { label: 'Clear recent files', click: send('clear-recent') },
      { type: 'separator' },
      { label: 'Export interactive HTML (.html)...', click: send('export-html') },
      { id: 'export-docx', label: 'Export Word (.docx)...', click: send('export-docx') },
      { id: 'export-pdf', label: 'Export PDF...', accelerator: 'CmdOrCtrl+P', click: send('export-pdf') },
      { id: 'export-interactive-hint', label: 'Tabs and variants require HTML export', enabled: false, visible: false },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: '&Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: send('redo') },
      { type: 'separator' }, { role: 'cut' }, { role: 'copy' },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: paste }, { role: 'selectAll' },
      { type: 'separator' }, { label: 'Find and replace...', accelerator: 'CmdOrCtrl+F', click: send('find') },
      { label: 'Formatting', submenu: formattingShortcuts.map(item => ({
        label: item.label, accelerator: item.accelerator, registerAccelerator: false,
        click: send(`format:${item.command}`),
      })) },
      { type: 'separator' }, { label: 'Paragraph', submenu: paragraphItems() }, { label: 'Insert', submenu: insertItems() },
      { type: 'separator' }, ...blockItems(false),
    ] },
    { label: '&View', submenu: [
      { label: 'Command palette...', accelerator: 'CmdOrCtrl+Shift+P', click: send('command-palette') },
      { type: 'separator' },
      { id: 'view-visual', label: 'Visual', type: 'checkbox', checked: true, click: send('visual') },
      { id: 'view-source', label: 'Markdown', type: 'checkbox', click: send('source') },
      { id: 'view-split', label: 'Split (Visual and Markdown)', type: 'checkbox', click: send('edit-split') },
      { label: 'Switch Visual / Markdown', accelerator: 'CmdOrCtrl+/', click: send('mode') },
      { id: 'view-preview', label: 'Preview', click: send('preview') },
      { id: 'view-preview-source', label: 'Show Markdown beside preview', type: 'checkbox', enabled: false, click: send('preview-source') },
      { label: 'Writing assistance', click: send('writing-assistance') },
      { label: 'Learn checks', click: send('learn-checks') },
      { label: 'Include relationships', click: send('include-relationships') },
      { label: 'Toggle sidebar', accelerator: 'CmdOrCtrl+Shift+B', click: send('sidebar') },
      { label: 'Focus mode', accelerator: 'F9', click: send('focus') },
      { label: 'Split with...', click: send('split') },
      { label: 'Unsplit', click: send('unsplit') },
      { label: 'Color theme', submenu: themes.map(theme => ({
        id: `theme-${theme.id}`, label: theme.label, type: 'radio',
        checked: theme.id === 'light', click: send(`theme:${theme.id}`),
      })) },
      { label: 'Next tab', accelerator: 'Ctrl+Tab', click: send('next-tab') },
      { label: 'Previous tab', accelerator: 'Ctrl+Shift+Tab', click: send('previous-tab') },
      { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' },
    ] },
    { label: '&Help', submenu: [{ label: 'Getting started', click: send('help') }, { label: 'Keyboard shortcuts', accelerator: 'F1', click: send('shortcuts') }, { label: `About ${productName}`, click: () => { void dialog.showMessageBox(window, { message: productTitle, detail: `Version ${app.getVersion()}\nA local-first Markdown editor. Built with Electron and Tiptap.\nNo account or cloud connection required.` }); } }] },
  ]));
  void window.loadURL(entryURL);
}

if (primaryInstance) void app.whenReady().then(async () => {
  if (process.platform === 'win32') app.setAppUserModelId('com.lekh.desktop');
  try {
    const saved: unknown = JSON.parse(await readFile(recentPath(), 'utf8'));
    if (!Array.isArray(saved) || !saved.every(item => typeof item === 'string')) throw new Error('Invalid recent-file list.');
    recentFiles = saved.slice(0, RECENT_FILE_LIMIT);
    if (saved.length > RECENT_FILE_LIMIT) {
      try { await atomicWrite(recentPath(), JSON.stringify(recentFiles)); }
      catch (error) {
        console.error('Could not shorten recent-file history:', error);
        dialog.showErrorBox('Recent-file history could not be updated', String(error));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Could not load recent files:', error);
      dialog.showErrorBox('Recent files could not be loaded', String(error));
    }
  }
  try {
    const saved: unknown = JSON.parse(await readFile(variantAssociationsPath(), 'utf8'));
    if (!Array.isArray(saved) || !saved.every(item => Array.isArray(item) && item.length === 2 &&
      typeof item[0] === 'string' && path.isAbsolute(item[0]) &&
      typeof item[1] === 'string' && path.isAbsolute(item[1]) && /\.ya?ml$/i.test(item[1]))) {
      throw new Error('Invalid shared selector file associations.');
    }
    for (const [documentPath, configPath] of saved as [string, string][]) {
      sharedVariantAssociations.set(variantAssociationKey(documentPath), configPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Could not load shared selector file associations:', error);
      dialog.showErrorBox('Shared selector files could not be remembered', String(error));
    }
  }
  protocol.handle('lekh-image', async request => {
    try {
      const parameters = new URL(request.url).searchParams;
      const source = parameters.get('source');
      if (!source) throw new Error('Missing image source.');
      const documentId = parameters.get('document');
      const grant = imageRoots.get(documentId ?? '');
      const includeGrant = includeRoots.get(documentId ?? '');
      const roots = [grant?.root, includeGrant?.root].filter((root): root is string => Boolean(root));
      const { data, mime } = await readImage(source, documentFor(documentId).path, roots);
      if (imageRoots.get(documentId ?? '') !== grant || includeRoots.get(documentId ?? '') !== includeGrant) throw new Error('Local image access changed. Refresh the preview.');
      return new Response(new Uint8Array(data), { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
    } catch (error) {
      console.error('Image could not be displayed:', error);
      return new Response('Image unavailable. Use Insert image to embed it.', { status: 404 });
    }
  });
  installIPC();
  createWindow();
}).catch(error => {
  console.error('Application startup failed:', error);
  dialog.showErrorBox(`${productName} could not start`, String(error));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
