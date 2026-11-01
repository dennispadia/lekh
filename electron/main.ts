import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, protocol, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { readFile, realpath, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicWrite, readMarkdown } from '../lib/files.js';
import { readImage, imageMime, embeddedImage, storeImage, MAX_IMAGE_BYTES } from '../lib/images.js';
import { isSafeLink, parser, requiresInteractiveExport } from '../lib/markdown.js';
import { toDocx, toOfflineHTML, toPrintHTML, type DiagramImageLoader } from '../lib/export.js';
import { diagramLimits, isMermaidLanguage, prepareMermaid } from '../lib/diagrams.js';
import { themes } from '../lib/themes.js';
import { formattingShortcuts } from '../lib/shortcuts.js';
import { fileArguments } from '../lib/launch.js';
import { productName, productTitle, userDataDirectory } from '../lib/branding.js';
import { prepareVariantConfiguration } from '../lib/variant-config.js';
import { publishingTemplates, variantInsertionTemplate } from '../lib/publishing-templates.js';
import { interactiveExportMessage } from '../lib/publishing.js';
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
let dirty = false;
let allowClose = false;
let recentFiles: string[] = [];
const RECENT_FILE_LIMIT = 5;
let editorContext: EditorContext = { mode: 'visual', active: [], heading: 0, inTable: false };
let contextMenu: { id: string; native: Menu; x: number; y: number; commands: Map<string, () => void> } | null = null;
const entryURL = pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).href;
const recentPath = () => path.join(app.getPath('userData'), 'recent-files.json');
const samePath = (left: string, right: string) => path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();

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
  await remember(file);
  return { id, path: file, content };
}

function paste(): void {
  if (!clipboard.readImage().isEmpty()) action('paste-image');
  else window.webContents.paste();
}

function showContextMenu(items: MenuItemConstructorOptions[], x: number, y: number): void {
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
      icon: publishingTemplates.find(template => template.id === item.id)?.icon,
      description: item.id === 'publishing-selector' ? variantInsertionTemplate(Boolean(editorContext.hasVariantSelector)).description :
        publishingTemplates.find(template => template.id === item.id)?.description,
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
    { label: 'Alerts', submenu: publishingTemplates.filter(item => item.category === 'alerts').map(item => ({ id: item.id, label: item.label, click: () => action(`insert:${item.id}`) })) },
    { label: 'Publishing blocks', submenu: [
      ...publishingTemplates.filter(item => item.category === 'content').map(item => ({
        id: item.id, label: item.id === 'publishing-selector' ? variantInsertionTemplate(Boolean(editorContext.hasVariantSelector)).label : item.label,
        click: () => action(`insert:${item.id}`),
      })),
    ] },
    { label: 'Footnote (Source)', click: () => action('insert:footnote') },
    { label: 'Link...', accelerator: 'CmdOrCtrl+K', click: () => action('link') },
    { label: 'Link reference (Source)', click: () => action('insert:reference') },
    { label: 'Horizontal line', click: () => action('format:rule') },
    { label: 'Table', accelerator: 'CmdOrCtrl+T', click: () => action('table') },
    { label: 'Code fence', accelerator: 'CmdOrCtrl+Shift+K', click: () => action('format:codeblock') },
    { label: 'Math block (Source)', accelerator: 'CmdOrCtrl+Shift+M', click: () => action('insert:math') },
    { label: 'Table of contents', click: () => action('insert:toc') },
    { label: 'Mermaid diagram (Source)', click: () => action('insert:mermaid') },
    { label: 'YAML front matter (Source)', click: () => action('insert:frontmatter') },
    { type: 'separator' },
    { label: 'Paragraph before', click: () => action('insert:before') },
    { label: 'Paragraph after', click: () => action('insert:after') },
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

async function exportPDF(content: string, documentPath: string | null, loadDiagram?: DiagramImageLoader, imageRoot?: string | null): Promise<Buffer> {
  const html = await toPrintHTML(content, documentPath, loadDiagram, imageRoot);
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

async function exportWithDiagrams(content: string, currentPath: string | null, format: 'pdf' | 'docx' | 'html', imageRoot?: string | null): Promise<Buffer> {
  const diagrams = parser.parse(content, {}).filter(token => token.type === 'fence' && isMermaidLanguage(token.info));
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
    if (format === 'pdf') return await exportPDF(content, currentPath, loadDiagram, imageRoot);
    if (format === 'html') return Buffer.from(await toOfflineHTML(content, currentPath, loadDiagram, imageRoot, validateRaster), 'utf8');
    return await toDocx(content, source => readImage(source, currentPath, imageRoot), loadDiagram);
  } finally { if (renderer && !renderer.isDestroyed()) renderer.destroy(); }
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
    const { data } = await readImage(source, documentFor(id).path, grant?.root);
    if (imageRoots.get(String(id)) !== grant) throw new Error('Local image access changed. Try copying the image again.');
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
      || context.formField !== undefined && typeof context.formField !== 'boolean') {
      console.error('Invalid editor context.');
      return;
    }
    editorContext = context;
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
  });
  handle('images:allow-folder', async (id: unknown) => {
    const document = documentFor(id);
    if (!document.path) throw new Error('Save this document before allowing access to a project image folder.');
    const selected = await dialog.showOpenDialog(window, {
      title: 'Allow project images for this document', buttonLabel: 'Allow this folder',
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
    const prepared = await prepareVariantConfiguration(content, document.path, grant?.root ?? null);
    if (imageRoots.get(String(id)) !== grant) throw new Error('Local asset access changed. Refresh the preview.');
    return prepared;
  });
  handle('images:revoke-folder', async (id: unknown) => {
    documentFor(id);
    imageRoots.delete(String(id));
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
    document.path = file;
    document.diskContent = content;
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
    const grant = imageRoots.get(String(id));
    const imageRoot = grant?.root ?? null;
    const assertAssetAccess = () => {
      if (imageRoots.get(String(id)) !== grant) throw new Error('Local asset access changed. Retry the export.');
    };
    const prepared = await prepareVariantConfiguration(content, currentPath, imageRoot);
    assertAssetAccess();
    if (format !== 'html' && requiresInteractiveExport(prepared)) throw new Error(interactiveExportMessage);
    const selection = await dialog.showSaveDialog(window, {
      title: `Export ${format.toUpperCase()}`,
      defaultPath: currentPath ? path.join(path.dirname(currentPath), `${path.parse(currentPath).name}.${format}`) : `Untitled.${format}`,
      filters: [{ name: format === 'pdf' ? 'PDF document' : format === 'docx' ? 'Word document' : 'HTML document', extensions: [format] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    if ([...documents.values()].some(document => document.path && samePath(selection.filePath!, document.path))) {
      throw new Error('Export cannot replace an open Markdown source file.');
    }
    assertAssetAccess();
    const data = await exportWithDiagrams(prepared, currentPath, format, imageRoot);
    assertAssetAccess();
    await atomicWrite(selection.filePath, data);
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
      for (const suggestion of parameters.dictionarySuggestions) {
        items.push({ label: suggestion, click: () => window.webContents.replaceMisspelling(suggestion) });
      }
      if (!parameters.dictionarySuggestions.length) items.push({ label: 'No spelling suggestions', enabled: false });
      items.push({ type: 'separator' });
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
        { label: 'Undo', click: () => action('undo') }, { label: 'Redo', click: () => action('redo') },
        { type: 'separator' }, { role: 'cut', enabled: parameters.editFlags.canCut },
        { role: 'copy', enabled: parameters.editFlags.canCopy || parameters.mediaType === 'image' },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: paste }, { role: 'selectAll' },
      );
      items.push(
        { label: 'Delete selection', enabled: Boolean(parameters.selectionText), click: () => window.webContents.delete() },
        { label: 'Copy / Paste As', submenu: [
          { label: 'Copy selection as Markdown', enabled: Boolean(parameters.selectionText), click: () => action('copy-markdown') },
          { label: 'Copy document as Markdown', click: () => action('copy-document') },
          { type: 'separator' }, { role: 'pasteAndMatchStyle', label: 'Paste as plain text' },
          { label: 'Paste as Markdown', click: () => action('paste-markdown') },
          { label: 'Paste image', enabled: !clipboard.readImage().isEmpty(), click: () => action('paste-image') },
        ] },
        { type: 'separator' },
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
        { label: 'View and tools', submenu: [
          { label: 'Visual + Source', click: () => action('side-by-side') },
          { label: 'Visual only', click: () => action('visual') },
          { label: 'Source only', click: () => action('source') },
          { label: 'Source + Preview', click: () => action('preview') },
          { label: 'Split / Unsplit', click: () => action('split') },
          { type: 'separator' },
          { label: 'Writing assistance', click: () => action('writing-assistance') },
          { label: 'Allow local image folder...', click: () => action('allow-image-folder') },
          { label: 'Stop local image folder access', click: () => action('revoke-image-folder') },
          { label: 'Getting started', click: () => action('help') },
        ] },
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
    } else if (parameters.selectionText) items.push({ role: 'copy' });
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
    ] },
    { label: '&View', submenu: [
      { label: 'Visual + Source', click: send('side-by-side') },
      { label: 'Visual / source', accelerator: 'CmdOrCtrl+/', click: send('mode') },
      { label: 'Source + Preview', click: send('preview') },
      { label: 'Writing assistance', click: send('writing-assistance') },
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
  protocol.handle('lekh-image', async request => {
    try {
      const parameters = new URL(request.url).searchParams;
      const source = parameters.get('source');
      if (!source) throw new Error('Missing image source.');
      const documentId = parameters.get('document');
      const grant = imageRoots.get(documentId ?? '');
      const { data, mime } = await readImage(source, documentFor(documentId).path, grant?.root);
      if (imageRoots.get(documentId ?? '') !== grant) throw new Error('Local image access changed. Refresh the preview.');
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
