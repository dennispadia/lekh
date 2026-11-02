import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

function testPNG(width, height) {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, 255);
  for (let row = 0; row < height; row++) pixels[row * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), 'lekh-desktop-'));
const executable = process.argv[2] ?? createRequire(import.meta.url)('electron');
const packaged = Boolean(process.argv[2]);
const startupFile = path.join(temporary, 'Startup résumé 日本語.md');
await writeFile(startupFile, '# Opened from Explorer\n\nStartup document with spaces and Unicode.\n');
const legacyRecentFiles = Array.from({length:8}, (_, index) => path.join(temporary, `Earlier ${index}.md`));
await mkdir(path.join(temporary, 'profile'));
await writeFile(path.join(temporary, 'profile', 'recent-files.json'), JSON.stringify(legacyRecentFiles));
const child = spawn(executable, [
  ...(packaged ? [] : ['.']),
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  '--inspect=127.0.0.1:0', '--remote-debugging-port=0', `--user-data-dir=${path.join(temporary, 'profile')}`,
  startupFile,
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
let spawnError;
child.on('error', error => { spawnError = error; });
child.stdout.on('data', data => { log += data; });
child.stderr.on('data', data => { log += data; });
const clients = [];

async function waitFor(check, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const result = await check();
    if (result) return result;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Desktop exited (${child.exitCode ?? child.signalCode}): ${log}`);
    }
    await delay(100);
  }
  throw new Error(`Timed out: ${description}\n${log}`);
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.counter = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const request = this.pending.get(message.id);
        if (request) {
          this.pending.delete(message.id);
          if (message.error) request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`));
          else request.resolve(message.result);
        }
      }
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    const client = new CDP(socket);
    clients.push(client);
    return client;
  }
  call(method, params = {}, sessionId) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}${method === 'Runtime.evaluate' ? ` (${params.expression.slice(0, 160)})` : ''}`));
      }, 30000).unref();
    });
  }
  async evaluate(expression, sessionId) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}\nExpression: ${expression.slice(0, 300)}`);
    return result.result.value;
  }
}

async function runChecks() {
  const mainURL = await waitFor(() => /Debugger listening on (ws:\/\/[^\s]+)/.exec(log)?.[1], 'main inspector');
  const browserURL = await waitFor(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(log)?.[1], 'desktop renderer', 90000);
  const main = await CDP.connect(mainURL);
  const browser = await CDP.connect(browserURL);
  const target = await waitFor(async () => (await browser.call('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url.endsWith('index.html')), 'application page');
  const { sessionId } = await browser.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const ui = expression => browser.evaluate(expression, sessionId);
  const waitForReload = (check, description) => waitFor(async () => {
    try { return await check(); }
    catch (error) {
      if (error instanceof Error && /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id/.test(error.message)) return false;
      throw error;
    }
  }, description);
  try {
    await waitFor(async () => ui("Boolean(document.querySelector('.tiptap h1')) && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'"), 'rendered editor', 90000);
  } catch (error) {
    let state;
    try { state = await ui("({ready:document.readyState,title:document.title,filename:document.querySelector('#filename')?.textContent,busy:document.querySelector('#app')?.getAttribute('aria-busy'),editor:Boolean(document.querySelector('.tiptap')),heading:document.querySelector('.tiptap h1')?.textContent,notification:document.querySelector('#notification')?.textContent})"); }
    catch (diagnostic) { state = { unavailable: String(diagnostic) }; }
    throw new Error(`Startup editor state: ${JSON.stringify(state)}`, { cause: error });
  }
  const electron = "process.getBuiltinModule('module').createRequire(process.cwd() + '\\\\package.json')('electron')";
  await main.evaluate(`globalThis.smokeElectron = ${electron}`);
  await waitFor(async () => ui(`document.querySelector('#filename').textContent === ${JSON.stringify(path.basename(startupFile))}`), 'cold-launch file opens after renderer initialization');
  assert.match(await ui("document.querySelector('#visual-editor').textContent"), /Opened from Explorer/);
  assert.equal(await ui("document.querySelectorAll('.document-tab').length"), 1, 'Explorer launch has no redundant blank or welcome tab');
  const startupRecentFiles = [startupFile, ...legacyRecentFiles.slice(0, 4)];
  assert.deepEqual(await ui("[...document.querySelectorAll('#recent button')].map(button => button.title)"), startupRecentFiles);
  assert.deepEqual(JSON.parse(await readFile(path.join(temporary, 'profile', 'recent-files.json'), 'utf8')), startupRecentFiles, 'Existing eight-file history is limited to five and persisted');
  console.log('PASS: cold launch opens the requested file, including spaces and Unicode, after editor initialization');
  await ui("globalThis.smokeBeforeBlankReload = true");
  await browser.call('Page.reload', {}, sessionId);
  await waitForReload(async () => ui("!globalThis.smokeBeforeBlankReload && document.querySelector('#filename')?.textContent === 'Untitled.md' && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'"), 'blank startup without pending files');
  assert.equal(await ui("document.querySelectorAll('.document-tab').length"), 1);
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), '');
  assert.equal(await ui("document.querySelector('#source-editor').value"), '');
  assert.equal(await ui("document.querySelector('#view-visual').getAttribute('aria-pressed')"), 'true');
  await waitFor(async () => ui("document.querySelector('#tabs .tab-select')?.clientWidth > 0"), 'blank tab layout');
  const blankTab = await ui(`(() => {
    const button = document.querySelector('#tabs .tab-select');
    return { name: button.textContent, width: button.clientWidth, contentWidth: button.scrollWidth };
  })()`);
  assert.equal(blankTab.name, 'Untitled.md');
  assert.ok(blankTab.contentWidth <= blankTab.width, `A single document name is readable when the header has room: ${JSON.stringify(blankTab)}`);
  console.log('PASS: startup opens one pristine blank Untitled document, never a welcome document');
  const baseline = path.join(temporary, 'Smoke baseline.md');
  await writeFile(baseline, '# Desktop test\n\n## Writing\n\nA generic desktop regression fixture.\n\n## Tasks\n\n- [ ] First task\n- [x] Second task\n- [ ] Third task\n\n## Table\n\n| Name | Value |\n| --- | --- |\n| Example | One |\n\n## Finish\n\nEnd of fixture.\n');
  await main.evaluate(`smokeElectron.dialog.showOpenDialog = async () => ({canceled:false,filePaths:[${JSON.stringify(baseline)}]}); smokeElectron.BrowserWindow.getAllWindows()[0].webContents.send('app:action','open')`);
  await waitFor(async () => ui("document.querySelector('#filename').textContent === 'Smoke baseline.md' && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'generic regression fixture');
  await ui("document.querySelector('.document-tab:not(.selected) .tab-close').click()");
  await waitFor(async () => ui("document.querySelectorAll('.document-tab').length === 1 && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'pristine blank closes without prompting');
  const imageChoices = `(() => {
    window.smokeImageStorage = 'embedded';
    setInterval(() => {
      const dialog = document.querySelector('#image-storage-dialog');
      if (!dialog?.open || !window.smokeImageStorage) return;
      if (window.smokeImageStorage === 'cancel') { dialog.close('cancel'); return; }
      dialog.querySelector('input[value="' + window.smokeImageStorage + '"]').checked = true;
      dialog.querySelector('form').requestSubmit(dialog.querySelector('button[value=insert]'));
    }, 40);
  })()`;
  await ui(imageChoices);
  console.log('PASS: native desktop window loads rich editor, outline, table, and checklist');
  assert.equal(await ui("document.querySelectorAll('.tiptap table').length"), 1);
  assert.ok(await ui("document.querySelectorAll('#outline .outline-entry').length") > 3);
  assert.ok(await ui("document.querySelectorAll('.tiptap input[type=checkbox]').length") >= 3);
  const taskOffsets = () => ui(`Array.from(document.querySelectorAll('.tiptap ul[data-type="taskList"] li')).filter(item => item.querySelector(':scope > label > input[type=checkbox]')).map(item => {
    const checkbox = item.querySelector(':scope > label > input').getBoundingClientRect();
    const paragraph = item.querySelector(':scope > div > p');
    const text = paragraph.getBoundingClientRect();
    return Math.abs(checkbox.top + checkbox.height / 2 - text.top - parseFloat(getComputedStyle(paragraph).lineHeight) / 2);
  })`);
  const taskAlignment = await taskOffsets();
  assert.ok(taskAlignment.length >= 3 && taskAlignment.every(offset => offset <= 1), `Checkbox alignment must be within 1px of first text line: ${taskAlignment}`);
  console.log('PASS: task checkboxes align with the first line of their text within 1px');
  assert.equal(await ui("document.querySelector('#dirty-indicator').textContent"), '');
  await main.evaluate(`globalThis.smokeElectron = ${electron}; globalThis.smokeSavePath = null; globalThis.smokeSaveCalls = 0; globalThis.smokeOpenPath = null; globalThis.smokeChoice = 2; globalThis.smokeChoices = []; globalThis.smokeIncludeChoice = 0; globalThis.smokeIncludeQuestions = []; globalThis.smokeHoldInclude = false; globalThis.smokeResolveInclude = null;
    smokeElectron.dialog.showSaveDialog = async () => { smokeSaveCalls++; return smokeSavePath ? ({canceled:false,filePath:smokeSavePath}) : ({canceled:true}); };
    smokeElectron.dialog.showOpenDialog = async () => smokeOpenPath ? ({canceled:false,filePaths:[smokeOpenPath]}) : ({canceled:true,filePaths:[]});
    smokeElectron.dialog.showMessageBox = async (_window, options) => {
      if (options?.message === 'Allow this document to load shared files?') {
        smokeIncludeQuestions.push(options);
        if (smokeHoldInclude) return await new Promise(resolve => { smokeResolveInclude = resolve; });
        return {response:smokeIncludeChoice};
      }
      return {response:smokeChoices.length ? smokeChoices.shift() : smokeChoice};
    };`);
  if (process.env.LEKH_INCLUDE_SMOKE_ONLY === '1') {
    const project = path.join(temporary, 'include-project');
    const articleDirectory = path.join(project, 'articles', 'sap', 'workloads');
    const includeDirectory = path.join(project, 'includes');
    await mkdir(articleDirectory, { recursive: true });
    await mkdir(includeDirectory, { recursive: true });
    await mkdir(path.join(project, 'assets'));
    await writeFile(path.join(project, 'assets', 'pixel.png'), testPNG(1, 1));
    await writeFile(path.join(includeDirectory, 'shared.md'), '---\ntitle: Private metadata\n---\n\nShared Include body.\n\n![Shared image](../assets/pixel.png)\n\n[!INCLUDE [Nested](nested.md)]\n');
    await writeFile(path.join(includeDirectory, 'nested.md'), 'Nested Include body.\n');
    await writeFile(path.join(includeDirectory, 'interactive.md'), '# [One](#tab/one)\n\nFirst included example.\n\n# [Two](#tab/two)\n\nSecond included example.\n\n---\n');
    await writeFile(path.join(articleDirectory, 'local.md'), 'Document-folder include.');
    const articleSource = [
      '# Include permission fixture', '', '[!INCLUDE [Shared](../../../includes/shared.md)]', '',
      '# [First example](#tab/first)', '', '[!INCLUDE [Shared in tab](../../../includes/shared.md)]', '',
      '# [Second example](#tab/second)', '', 'Another example.', '', '---', '',
    ].join('\n');
    const article = path.join(articleDirectory, 'first.md');
    const second = path.join(articleDirectory, 'second.md');
    const third = path.join(articleDirectory, 'third.md');
    for (const file of [article, second, third]) await writeFile(file, articleSource);
    const send = async name => {
      await main.evaluate(`smokeElectron.BrowserWindow.getAllWindows()[0].webContents.send('app:action', ${JSON.stringify(name)})`);
      await delay(100);
      await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), name);
    };
    const activeId = () => ui("document.querySelector('.document-tab.selected').dataset.documentId");
    const openFile = async file => {
      await main.evaluate(`smokeOpenPath=${JSON.stringify(file)}`);
      await send('open');
      await waitFor(async () => ui(`document.querySelector('#filename').textContent === ${JSON.stringify(path.basename(file))}`), `open ${file}`);
      return activeId();
    };
    const expression = (id, method, content = articleSource) => `window.lekh.${method}(${JSON.stringify(id)},${JSON.stringify(content)})`;

    await main.evaluate('smokeIncludeQuestions=[]; smokeIncludeChoice=0; smokeHoldInclude=true; smokeResolveInclude=null');
    const firstId = await openFile(article);
    await waitFor(() => main.evaluate('smokeIncludeQuestions.length === 1 && typeof smokeResolveInclude === "function"'), 'one pending include permission');
    const question = await main.evaluate('smokeIncludeQuestions[0]');
    assert.ok(question.detail.includes(await realpath(project)), 'The prompt suggests the containing project folder');
    assert.ok(question.detail.includes('shared.md') && question.detail.includes('ends when it is closed'), 'The prompt explains the requested file and session scope');
    assert.equal(await ui("document.body.textContent.includes('Shared Include body.')"), false, 'External content is not displayed before consent');
    await ui(`globalThis.includeResults=null; Promise.all([
      ${expression(firstId, 'previewIncludes')},
      ${expression(firstId, 'includesRequireInteractiveExport')},
      ${expression(firstId, 'previewIncludes')}
    ]).then(results => { globalThis.includeResults=results; }); true`);
    await delay(800);
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 1, 'Simultaneous preview and export checks share one prompt');
    await main.evaluate('smokeHoldInclude=false; smokeResolveInclude({response:0}); smokeResolveInclude=null');
    await waitFor(async () => ui("globalThis.includeResults?.length === 3"), 'concurrent include requests complete');
    const results = await ui('globalThis.includeResults');
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    assert.equal(results[1].value, true, 'An included or parent tab remains interactive');
    const includedTabs = '[!INCLUDE [Examples](../../../includes/interactive.md)]\n';
    const interactive = await ui(expression(firstId, 'includesRequireInteractiveExport', includedTabs));
    assert.deepEqual(interactive, { ok: true, value: true }, 'Tabs inside an include restrict static export');
    const word = await ui(`window.lekh.exportDocument(${JSON.stringify(firstId)},${JSON.stringify(includedTabs)},'docx')`);
    assert.equal(word.ok, false);
    assert.match(word.error, /HTML/i);
    await waitFor(async () => ui("[...document.querySelectorAll('[data-lekh-include] .publishing-include-preview')].filter(item=>item.textContent.includes('Nested Include body.')).length >= 2"), 'Visual refreshes standalone and tabbed includes');
    await waitFor(async () => ui("[...document.querySelectorAll('[data-lekh-include] img')].some(image=>image.complete && image.naturalWidth===1)"), 'included relative image loads after consent');
    await send('preview');
    await waitFor(async () => ui("document.querySelector('.document-preview').textContent.includes('Shared Include body.') && document.querySelector('.document-preview').textContent.includes('Nested Include body.')"), 'Preview refreshes included content');
    await waitFor(async () => ui("document.querySelector('.document-preview img')?.naturalWidth === 1"), 'Preview displays the included image');
    const output = path.join(temporary, 'include-export.html');
    await main.evaluate(`smokeSavePath=${JSON.stringify(output)}`);
    const exported = await ui(`window.lekh.exportDocument(${JSON.stringify(firstId)},${JSON.stringify(articleSource)},'html')`);
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const html = await readFile(output, 'utf8');
    assert.match(html, /Shared Include body/);
    assert.match(html, /Nested Include body/);
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /Private metadata/);
    assert.equal(await readFile(article, 'utf8'), articleSource, 'Rendering and export do not rewrite the parent document');
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 1);
    await send('close-tab');

    await main.evaluate('smokeIncludeChoice=1; smokeHoldInclude=false');
    const secondId = await openFile(second);
    await waitFor(() => main.evaluate('smokeIncludeQuestions.length === 2'), 'separate document requests its own access');
    await waitFor(async () => ui("Boolean(document.querySelector('[data-lekh-include] .publishing-include-access'))"), 'declined access shows contextual recovery');
    assert.equal(await ui("document.body.textContent.includes('Shared Include body.')"), false, 'The previous document grant is not inherited');
    const local = await ui(expression(secondId, 'previewIncludes', '[!INCLUDE [Local](local.md)]\n'));
    assert.equal(local.ok, true);
    assert.match(local.value, /Document-folder include/);
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 2, 'Includes in the document folder need no permission prompt');
    for (let attempt = 0; attempt < 3; attempt++) {
      const blocked = await ui(expression(secondId, 'previewIncludes'));
      assert.equal(blocked.ok, true);
      assert.doesNotMatch(blocked.value, /Shared Include body/);
      const interactive = await ui(expression(secondId, 'includesRequireInteractiveExport'));
      assert.equal(interactive.ok, false);
      assert.match(interactive.error, /outside the allowed folder/);
    }
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 2, 'A declined request does not reappear on refresh');
    assert.equal(await ui("Boolean(document.querySelector('[data-action=allow-include-folder], [data-action=revoke-include-folder]'))"), false);
    const menuLabels = await main.evaluate(`(() => { const labels=[]; const walk=menu=>{for(const item of menu.items){labels.push(item.label);if(item.submenu)walk(item.submenu)}}; walk(smokeElectron.Menu.getApplicationMenu()); return labels; })()`);
    assert.ok(!menuLabels.some(label => /Allow local include folder|Stop local include folder access/.test(label)), 'Native and context-menu permission entries are removed');
    const blockedExport = await ui(`window.lekh.exportDocument(${JSON.stringify(secondId)},${JSON.stringify(articleSource)},'html')`);
    assert.equal(blockedExport.ok, false);
    assert.match(blockedExport.error, /outside the allowed folder/);
    await main.evaluate(`smokeOpenPath=${JSON.stringify(project)}`);
    await ui("document.querySelector('[data-lekh-include] .publishing-include-access').click()");
    await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-include-preview')?.textContent.includes('Shared Include body.')"), 'contextual folder selection retries the denied include');
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 2);
    const revoked = await ui(`window.lekh.revokeIncludeFolder(${JSON.stringify(secondId)})`);
    assert.equal(revoked.ok, true);
    await waitFor(async () => ui("Boolean(document.querySelector('[data-lekh-include] .publishing-include-access'))"), 'revocation refreshes the visible include');
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 2, 'Revocation does not immediately trigger another prompt');
    await ui("document.querySelector('[data-lekh-include] .publishing-include-access').click()");
    await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-include-preview')?.textContent.includes('Shared Include body.')"), 'contextual recovery can grant access again');

    const rootTarget = path.join(path.parse(project).root, 'lekh-unavailable.md');
    const rootRelative = path.relative(articleDirectory, rootTarget).split(path.sep).join('/');
    const rootRequest = `[!INCLUDE [Outside](${rootRelative})]\n`;
    const rootResult = await ui(expression(secondId, 'previewIncludes', rootRequest));
    assert.equal(rootResult.ok, true);
    assert.match(rootResult.value, /outside the allowed folder/);
    assert.match(rootResult.value, /Choose project folder/);
    assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 2, 'A filesystem root is never suggested automatically');
    const outside = path.join(temporary, 'outside-project');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.md'), 'Outside content must remain private.');
    try {
      await symlink(outside, path.join(includeDirectory, 'linked-outside'), process.platform === 'win32' ? 'junction' : 'dir');
      const junction = '[!INCLUDE [Escape](../../../includes/linked-outside/secret.md)]\n';
      const junctionResult = await ui(expression(secondId, 'previewIncludes', junction));
      assert.equal(junctionResult.ok, true);
      assert.match(junctionResult.value, /symlink or junction escape/);
      assert.doesNotMatch(junctionResult.value, /Outside content must remain private/);
      assert.equal(await main.evaluate('smokeIncludeQuestions.length'), 2, 'A junction escape does not trigger an automatic grant');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
      console.log('SKIP: directory-junction check is unavailable to this account');
    }

    await main.evaluate('smokeHoldInclude=true; smokeResolveInclude=null');
    const staleId = await openFile(third);
    await waitFor(() => main.evaluate('smokeIncludeQuestions.length === 3 && typeof smokeResolveInclude === "function"'), 'third document permission waits');
    await ui(`globalThis.staleIncludeResult=null; ${expression(staleId, 'previewIncludes')}.then(result=>{globalThis.staleIncludeResult=result}); true`);
    await send('close-tab');
    await waitFor(async () => (await activeId()) !== staleId, 'close document while consent is pending');
    await main.evaluate('smokeHoldInclude=false; smokeResolveInclude({response:0}); smokeResolveInclude=null');
    await waitFor(async () => ui('globalThis.staleIncludeResult !== null'), 'closed document rejects pending access');
    assert.equal(await ui('globalThis.staleIncludeResult.ok'), false);
    assert.match(await ui('globalThis.staleIncludeResult.error'), /no longer open|changed/);
    await main.evaluate('smokeIncludeChoice=1');
    const reopenedId = await openFile(third);
    assert.notEqual(reopenedId, staleId);
    await waitFor(() => main.evaluate('smokeIncludeQuestions.length === 4'), 'reopening requires a new per-document grant');
    await waitFor(async () => ui("Boolean(document.querySelector('[data-lekh-include] .publishing-include-access'))"), 'reopened document remains unapproved');
    await main.evaluate(`smokeOpenPath=${JSON.stringify(project)}`);
    await ui("document.querySelector('[data-lekh-include] .publishing-include-access').click()");
    await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-include-preview')?.textContent.includes('Shared Include body.')"), 'reopened document explicitly grants access');
    const movedRoot = path.join(temporary, 'moved-project');
    const moved = path.join(movedRoot, 'articles', 'sap', 'workloads', 'moved.md');
    await mkdir(path.dirname(moved), { recursive: true });
    await mkdir(path.join(movedRoot, 'includes'), { recursive: true });
    await writeFile(path.join(movedRoot, 'includes', 'shared.md'), 'Moved project Include body.\n');
    await main.evaluate(`smokeSavePath=${JSON.stringify(moved)}`);
    await send('save-as');
    await waitFor(async () => ui("document.querySelector('#filename').textContent === 'moved.md'"), 'Save As changes the document path');
    await waitFor(() => main.evaluate('smokeIncludeQuestions.length === 5'), 'Save As requires new folder consent');
    await waitFor(async () => ui("Boolean(document.querySelector('[data-lekh-include] .publishing-include-access'))"), 'moved document does not retain the old project grant');
    assert.ok((await main.evaluate('smokeIncludeQuestions[4].detail')).includes(await realpath(movedRoot)));
    assert.equal(await ui("document.body.textContent.includes('Moved project Include body.')"), false);
    console.log('PASS: three-level relative Includes, one-time consent, concurrent requests, Visual/Preview/images/export, denial and retry, document isolation, Save As, stale prompts, and junction protection');
    return;
  }
  assert.equal(await main.evaluate("smokeElectron.app.getPath('userData')"), path.join(temporary, 'profile'), 'Test profile is isolated from real user data');
  assert.equal(await main.evaluate("smokeElectron.app.getPath('sessionData')"), path.join(temporary, 'profile'), 'Chromium storage is isolated in the same preserved profile');
  assert.equal(await main.evaluate("smokeElectron.app.getName()"), 'Lekh');
  assert.equal(await ui("document.querySelector('.latin-name').textContent"), 'Lekh');
  assert.equal(await ui("document.querySelector('.devanagari').textContent"), 'लेख');
  assert.equal(await ui("document.querySelector('.brand-descriptor').textContent"), 'Markdown editor');
  assert.equal(await ui("getComputedStyle(document.querySelector('.latin-name')).fontWeight"), '300');
  assert.ok((await ui('document.title')).endsWith(' - Lekh'));
  const brandingLayouts = await ui(`(() => {
    const sidebar = document.querySelector('#sidebar');
    const previous = sidebar.style.width;
    try {
      return [200, 220, 320].map(width => {
        sidebar.style.width = width + 'px';
        const edge = sidebar.getBoundingClientRect().right;
        const name = document.querySelector('.brand-name').getBoundingClientRect();
        const descriptor = document.querySelector('.brand-descriptor').getBoundingClientRect();
        return {width, fits: Math.max(name.right, descriptor.right) <= edge - 15,
          iconWidth: document.querySelector('.brand-mark').getBoundingClientRect().width};
      });
    } finally { sidebar.style.width = previous; }
  })()`);
  for (const layout of brandingLayouts) {
    assert.ok(layout.fits, `The complete bilingual wordmark fits at sidebar width ${layout.width}`);
    assert.equal(layout.iconWidth, 52);
  }
  await browser.call('DOM.enable', {}, sessionId);
  await browser.call('CSS.enable', {}, sessionId);
  const brandDocument = await browser.call('DOM.getDocument', {}, sessionId);
  const brandNode = await browser.call('DOM.querySelector', {nodeId:brandDocument.root.nodeId,selector:'.latin-name'}, sessionId);
  const brandFonts = await browser.call('CSS.getPlatformFontsForNode', {nodeId:brandNode.nodeId}, sessionId);
  assert.ok(brandFonts.fonts.some(font => font.postScriptName === 'SegoeUI-Light' && font.glyphCount > 0), 'The wordmark uses the actual Windows Segoe UI Light font');
  console.log('PASS: Lekh branding, genuine Segoe UI Light, minimum-width wordmark, and isolated preserved Chromium storage');
  assert.equal(await main.evaluate("smokeElectron.app.getVersion()"), JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, 'The executable matches the current release version');
  await waitFor(async () => ui("document.querySelector('.brand-mark img')?.naturalWidth === 512"), 'original wizard sidebar artwork');
  const brandSource = async () => {
    await waitFor(async () => ui("document.querySelector('#brand-icon')?.complete && document.querySelector('#brand-icon').naturalWidth === 512"), 'theme-aware sidebar artwork');
    return ui("document.querySelector('#brand-icon').currentSrc");
  };
  const lightBrandIcon = await brandSource();
  assert.deepEqual(await main.evaluate("smokeElectron.nativeImage.createFromPath(process.getBuiltinModule('path').join(smokeElectron.app.getAppPath(), 'assets', 'icon.png')).getSize()"), {width:256,height:256});
  if (packaged) {
    const application = await readFile(path.resolve(executable));
    const icon = await readFile(path.join(root, 'assets', 'icon.ico'));
    const resources = NtExecutableResource.from(NtExecutable.from(application));
    const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
    const count = icon.readUInt16LE(4);
    assert.equal(groups.length, 1, 'No old/default icon groups remain in the executable');
    assert.equal(resources.entries.filter(entry => entry.type === 3).length, count, 'No orphaned old icon resources remain');
    assert.equal(groups[0].icons.length, count);
    for (const [index, item] of groups[0].icons.entries()) {
      const directory = 6 + index * 16;
      assert.equal(item.width || 256, icon[directory] || 256);
      assert.equal(item.height || 256, icon[directory + 1] || 256);
      const entry = resources.entries.find(entry => entry.type === 3 && entry.id === item.iconID && entry.lang === groups[0].lang);
      assert.ok(entry, 'Each Windows icon resolution has its matching resource');
      const offset = icon.readUInt32LE(directory + 12);
      const length = icon.readUInt32LE(directory + 8);
      assert.deepEqual(Buffer.from(entry.bin), icon.subarray(offset, offset + length), 'Every Windows icon size uses the approved quill');
    }
  }
  console.log('PASS: original wizard sidebar/window artwork and packaged executable icon resources');
  const action = async name => {
    await ui(`document.querySelector('[data-action=${JSON.stringify(name)}]').click()`);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), name);
  };
  const clickControl = async selector => {
    const point = await ui(`(() => {const control=document.querySelector(${JSON.stringify(selector)});const bounds=control.getBoundingClientRect();return {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2,visible:bounds.width>0 && bounds.height>0}})()`);
    assert.ok(point.visible, `Control must be visible before clicking: ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await browser.call('Input.dispatchMouseEvent', {type,x:point.x,y:point.y,button:'left',buttons:type === 'mousePressed' ? 1 : 0,clickCount:1}, sessionId);
    }
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'control action');
  };
  const clickMermaid = async () => {
    await clickControl('[data-action="structure-menu"]');
    await clickControl('#structure-menu [data-action="insert:mermaid"]');
  };
  const menuAction = async name => {
    await main.evaluate(`smokeElectron.BrowserWindow.getAllWindows()[0].webContents.send('app:action', ${JSON.stringify(name)})`);
    await delay(100);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), name);
  };
  const nativeShortcut = async (key, modifiers = ['control'], focusEditor = true) => {
    await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].focus(); smokeElectron.BrowserWindow.getAllWindows()[0].webContents.focus()");
    await waitFor(async () => main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].isFocused()"), 'native window activation');
    await waitFor(async () => ui("document.hasFocus()"), 'native keyboard focus');
    if (focusEditor) await ui("document.querySelector('#source-editor').hidden ? document.querySelector('#visual-editor .tiptap').focus() : document.querySelector('#source-editor').focus()");
    await ui("new Promise(resolve => requestAnimationFrame(() => resolve(true)))");
    await main.evaluate(`(() => {
      const contents = smokeElectron.BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({type:'keyDown',keyCode:${JSON.stringify(key)},modifiers:${JSON.stringify(modifiers)}});
      contents.sendInputEvent({type:'keyUp',keyCode:${JSON.stringify(key)},modifiers:${JSON.stringify(modifiers)}});
    })()`);
  };
  const activeTab = () => ui("document.querySelector('.document-tab.selected').dataset.documentId");
  const tabCount = () => ui("document.querySelectorAll('.document-tab').length");
  const selectTab = async id => {
    await ui(`document.querySelector('[data-document-id=${JSON.stringify(id)}] .tab-select').click()`);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'tab switch');
  };
  const exportGeometry = await ui("(() => {const button=document.querySelector('[data-action=export-menu]');const bounds=button.getBoundingClientRect();const label=button.querySelector('span').getBoundingClientRect();return {width:bounds.width,height:bounds.height,x:Math.abs(label.left+label.width/2-bounds.left-bounds.width/2),y:Math.abs(label.top+label.height/2-bounds.top-bounds.height/2),icons:button.querySelectorAll('svg').length};})()");
  assert.equal(exportGeometry.width, 80);
  assert.equal(exportGeometry.height, 31);
  assert.equal(exportGeometry.icons, 0);
  assert.ok(exportGeometry.x <= 1 && exportGeometry.y <= 1, JSON.stringify(exportGeometry));
  await action('export-menu');
  assert.equal(await ui("document.querySelector('#export-menu').hidden"), false);
  await action('export-menu');
  assert.equal(await ui("document.querySelector('#zoom-reset').textContent"), '100%');
  const beforeZoomText = await ui("document.querySelector('#visual-editor').textContent");
  await action('zoom-in');
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent !== '100%'"), 'zoom-in percentage');
  const zoomedFactor = await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()");
  assert.ok(zoomedFactor > 1);
  assert.equal(await ui("document.querySelector('#zoom-reset').textContent"), `${Math.round(zoomedFactor * 100)}%`);
  await action('zoom-out');
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent === '100%'"), 'zoom-out percentage');
  await main.evaluate("(() => {const view=smokeElectron.Menu.getApplicationMenu().items.find(item=>item.label.includes('View'));const window=smokeElectron.BrowserWindow.getAllWindows()[0];view.submenu.items.find(item=>item.role?.toLowerCase()==='zoomin').click({},window,window.webContents);})()");
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent !== '100%'"), 'native menu zoom synchronization');
  await nativeShortcut('-', ['control'], false);
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent === '100%'"), 'native keyboard zoom synchronization');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(0.5)");
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent === '50%'"), 'minimum zoom percentage');
  assert.equal(await ui("document.querySelector('#zoom-out').disabled"), true);
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,600);smokeElectron.BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(3)");
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent === '300%'"), 'maximum zoom percentage');
  assert.equal(await ui("document.querySelector('#zoom-in').disabled"), true);
  assert.ok(await ui("(() => {const controls=document.querySelector('.zoom-controls').getBoundingClientRect();return controls.left >= 0 && controls.right <= innerWidth;})()"), 'Reset remains reachable at maximum zoom in the minimum window');
  await action('zoom-reset');
  await waitFor(async () => ui("document.querySelector('#zoom-reset').textContent === '100%'"), 'reset percentage');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  assert.equal(await ui("document.querySelector('#visual-editor').textContent"), beforeZoomText, 'Zoom does not modify document text');
  assert.equal(await ui("window.lekh.zoom('invalid').then(result => result.ok)"), false, 'Invalid zoom commands are rejected');
  console.log('PASS: zoom controls and percentage, native menu/keyboard synchronization, 50%-300% bounds, visible reset, and unchanged document text');
  const raw = '# Exact source\r\n\r\nUnusual   spacing & Unicode: \u4f60\u597d\r\n\r\n- [ ] A task\r\n';
  const file = path.join(temporary, 'original.md');
  await writeFile(file, raw);
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(file)}`);
  await action('open');
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'original.md');
  await action('save');
  assert.equal(await ui("document.querySelector('#notification').textContent"), 'original.md saved');
  assert.equal(await readFile(file, 'utf8'), raw);
  await action('source');
  assert.equal(await ui("document.querySelector('#source-editor').value"), raw.replace(/\r\n/g, '\n'));
  await action('visual');
  await action('save');
  assert.equal(await readFile(file, 'utf8'), raw, 'Mode switching and saving without edits preserve exact source bytes');
  console.log('PASS: native Open/Save and mode switching preserve unedited Markdown exactly');

  await action('source');
  const sourceEdit = async text => ui(`(() => { const source = document.querySelector('#source-editor'); source.value = ${JSON.stringify(text)}; source.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const beforeDualTab = await activeTab();
  await action('new');
  await sourceEdit('one');
  await sourceEdit('one two');
  await ui("document.querySelector('#source-editor').focus()");
  await action('edit-split');
  assert.equal(await ui("document.activeElement === document.querySelector('#source-editor')"), true, 'Enabling dual view retains Source focus');
  await nativeShortcut('Z', ['control'], false);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'one', 'Undo after enabling dual view uses the still-focused Source history');
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), 'one');
  await nativeShortcut('Z', ['control','shift'], false);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'one two');
  await sourceEdit('');
  assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'true');
  assert.equal(await ui("document.querySelector('#source-editor').hidden || document.querySelector('#visual-editor').hidden"), false);
  const dualLayout = await ui("(() => {const visual=document.querySelector('.visual-surface').getBoundingClientRect();const source=document.querySelector('.source-surface').getBoundingClientRect();return {left:visual.left,right:visual.right,sourceLeft:source.left,sourceWidth:source.width};})()");
  assert.ok(dualLayout.right <= dualLayout.sourceLeft && dualLayout.sourceWidth > 200, JSON.stringify(dualLayout));
  const dualRaw = '# Dual view\n\nUnusual   spacing stays in source.\n\n## Last section\n\nKeep editing here.\n';
  await sourceEdit(dualRaw);
  assert.equal(await ui("document.querySelector('#visual-editor h1').textContent"), 'Dual view');
  assert.equal(await ui("document.querySelector('#source-editor').value"), dualRaw, 'Rendering does not normalize raw Source');
  await action('undo');
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), '');
  await action('redo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), dualRaw);
  await ui("(() => {const editor=document.querySelector('.tiptap');editor.focus();const text=editor.querySelector('p').firstChild;const range=document.createRange();range.setStart(text,0);range.setEnd(text,7);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);})()");
  await ui("document.querySelector('.toolbar [data-command=bold]').click()");
  await waitFor(async () => ui("document.querySelector('#source-editor').value.includes('**Unusual**')"), 'Visual toolbar edits synchronize Source');
  assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'true', 'Formatting leaves both panes visible');
  await ui("document.querySelector('.tiptap').focus()");
  await browser.call('Input.insertText', {text:'Typed visually '}, sessionId);
  await waitFor(async () => ui("document.querySelector('#source-editor').value.includes('Typed visually')"), 'Visual typing synchronizes Source');
  await sourceEdit(dualRaw.replace('Keep editing here.', 'A **source edit** appears visually.'));
  assert.equal(await ui("document.querySelector('#visual-editor strong').textContent"), 'source edit');
  if (process.env.LEKH_APPROVED_SCREENSHOT) {
    await menuAction('theme:dark');
    await ui("document.querySelector('#notification').click();document.activeElement.blur()");
    const screenshot = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(process.env.LEKH_APPROVED_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    await action('sidebar');
    const collapsed = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_APPROVED_SCREENSHOT), 'approved-interface-collapsed.png'), Buffer.from(collapsed.data, 'base64'));
    await action('sidebar');
    await menuAction('theme:light');
  }
  await ui("document.querySelector('#view-visual').focus()");
  await nativeShortcut('Space', [], false);
  await waitFor(async () => ui("document.querySelector('#view-visual').getAttribute('aria-pressed') === 'true'"), 'keyboard selects Visual');
  assert.equal(await ui("document.querySelector('#source-editor').hidden"), true);
  await ui("document.querySelector('#view-split').focus()");
  await nativeShortcut('Space', [], false);
  await waitFor(async () => ui("document.querySelector('#view-split').getAttribute('aria-pressed') === 'true'"), 'keyboard selects Split');
  const longDual = Array.from({length:60}, (_, index) => `## Section ${index}\n\nParagraph ${index} with enough content for scrolling.`).join('\n\n');
  await sourceEdit(longDual);
  await ui("document.querySelector('#source-editor').focus();document.querySelector('.visual-surface').scrollTop=1500");
  await waitFor(async () => ui("document.querySelector('#source-editor').scrollTop > 100"), 'Visual scrolling synchronizes Source by default');
  await ui("(() => {const view=document.querySelector('.visual-surface');const heading=[...view.querySelectorAll('h2')].find(h=>h.textContent==='Section 30');view.scrollTop+=heading.getBoundingClientRect().top-view.getBoundingClientRect().top})()");
  await waitFor(async () => ui("(() => {const text=document.querySelector('#source-editor'),measure=document.querySelector('.source-scroll-measure');const pos=text.value.indexOf('## Section 30');const range=document.createRange();range.setStart(measure.firstChild,pos);range.setEnd(measure.firstChild,pos+1);return Math.abs(text.scrollTop-(range.getBoundingClientRect().top-measure.getBoundingClientRect().top))<2})()"), 'Visual heading and wrapped Source line align within two pixels');
  await ui("(() => {const text=document.querySelector('#source-editor'),measure=document.querySelector('.source-scroll-measure');const pos=text.value.indexOf('## Section 45');const range=document.createRange();range.setStart(measure.firstChild,pos);range.setEnd(measure.firstChild,pos+1);text.scrollTop=range.getBoundingClientRect().top-measure.getBoundingClientRect().top})()");
  await waitFor(async () => ui("(() => {const view=document.querySelector('.visual-surface');const heading=[...view.querySelectorAll('h2')].find(h=>h.textContent==='Section 45');return Math.abs(heading.getBoundingClientRect().top-view.getBoundingClientRect().top)<2})()"), 'Source heading aligns the Visual document within two pixels');
  await ui("document.querySelector('.visual-surface').scrollTop=1500");
  await delay(100);
  const dualVisualBefore = await ui("document.querySelector('.visual-surface').scrollTop");
  const dualSourceBefore = await ui("document.querySelector('#source-editor').scrollTop");
  await action('visual');
  assert.equal(await ui("document.activeElement === document.querySelector('.tiptap')"), true, 'Hiding focused Source transfers focus to Visual');
  assert.ok(await ui("document.querySelector('.pane-content').scrollTop") > 1000, 'Disabling Source retains the Visual scroll position');
  await action('edit-split');
  assert.ok(await ui("document.querySelector('.visual-surface').scrollTop") > 1000, 'Enabling Source retains the Visual scroll position');
  assert.ok(Math.abs(await ui("document.querySelector('#source-editor').scrollTop") - dualSourceBefore) < 3);
  assert.ok(Math.abs(await ui("document.querySelector('.visual-surface').scrollTop") - dualVisualBefore) < 3);
  await ui("document.querySelector('#source-editor').scrollTop=700");
  await waitFor(async () => Math.abs(await ui("document.querySelector('.visual-surface').scrollTop") - dualVisualBefore) > 30, 'Source scrolling synchronizes Visual by default');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1280,900)");
  await delay(150);
  assert.ok(await ui("document.querySelector('.toolbar').scrollWidth <= document.querySelector('.toolbar').clientWidth"), 'Every editing command fits on one row at 1280px');
  assert.equal(await ui("document.querySelector('.toolbar [data-action=edit-split]').textContent"), 'Split', 'Split edits both views of the active file');
  assert.ok(await ui("Boolean(document.querySelector('#format-menu [data-action=split]'))"), 'Pairing files remains available separately');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,600)");
  await delay(200);
  assert.equal(await ui("getComputedStyle(document.querySelector('.toolbar')).flexWrap"), 'nowrap', 'Editable dual-view toolbar stays on one row at minimum width');
  assert.ok(await ui("document.querySelector('.toolbar').scrollWidth <= document.querySelector('.toolbar').clientWidth"), 'Toolbar fits without horizontal scrolling');
  assert.ok(await ui("document.querySelector('#toolbar-overflow').children.length > 0"), 'Narrow toolbar moves commands into More');
  await action('format-menu');
  assert.ok(await ui("document.querySelector('#toolbar-overflow [data-action=redo]').getClientRects().length > 0"), 'The last command is visible in More');
  assert.equal(await ui("document.querySelector('#toolbar-overflow [data-action=redo] span').textContent"), 'Redo');
  await nativeShortcut('Escape', [], false);
  assert.ok(await ui("document.querySelector('.source-surface').getBoundingClientRect().right <= innerWidth"), 'Source remains beside Visual at minimum window width');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await menuAction('visual');
  assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'false');
  await menuAction('edit-split');
  await action('new');
  await selectTab(await ui("Array.from(document.querySelectorAll('.document-tab')).at(-2).dataset.documentId"));
  assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'true', 'Dual view survives tab activation');
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  await menuAction('close-tab');
  await selectTab(beforeDualTab);
  await action('source');
  console.log('PASS: editable Visual left / Source right, two-way synchronization, raw-source preservation, toolbar, undo/redo, mouse/Space switch, tab state, and retained scroll offsets');
  await main.evaluate("globalThis.smokeSecondInstances = 0; smokeElectron.app.on('second-instance', () => { smokeSecondInstances++; })");
  const launch = async files => {
    const process = spawn(executable, [
      ...(packaged ? [] : [root]), `--user-data-dir=${path.join(temporary, 'profile')}`, ...files,
    ], { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error;
    process.on('error', value => { error = value; });
    process.stdout.on('data', data => { output += data; });
    process.stderr.on('data', data => { output += data; });
    try {
      await waitFor(() => {
        if (error) throw error;
        return process.exitCode !== null || process.signalCode !== null;
      }, 'second process forwards files and exits', 60000);
      assert.equal(process.signalCode, null, `Second process terminated by ${process.signalCode}. ${output}`);
      assert.equal(process.exitCode, 0, output);
    } catch (error) {
      let primaryState;
      try {
        primaryState = await main.evaluate(`({received:smokeSecondInstances, windows:smokeElectron.BrowserWindow.getAllWindows().length, minimized:smokeElectron.BrowserWindow.getAllWindows()[0]?.isMinimized()})`);
      } catch (diagnostic) {
        primaryState = `unavailable: ${String(diagnostic)}`;
      }
      throw new Error(`Second process ${process.pid} failed to forward files (exit ${process.exitCode}, signal ${process.signalCode}); primary: ${JSON.stringify(primaryState)}. Output:\n${output}`, { cause: error });
    } finally {
      if (process.exitCode === null && process.signalCode === null) {
        process.kill();
        await new Promise(resolve => {
          if (process.exitCode !== null || process.signalCode !== null) resolve();
          else { process.once('exit', resolve); setTimeout(resolve, 5000).unref(); }
        });
      }
    }
  };
  await sourceEdit(raw.replace(/\r\n/g, '\n') + '\nUnsaved Explorer edits');
  const explorerEdits = await ui("document.querySelector('#source-editor').value");
  const originalTabs = await tabCount();
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].minimize()");
  await launch([file]);
  await waitFor(async () => main.evaluate("!smokeElectron.BrowserWindow.getAllWindows()[0].isMinimized()"), 'existing window restored');
  assert.equal(await main.evaluate("smokeElectron.BrowserWindow.getAllWindows().length"), 1);
  assert.equal(await tabCount(), originalTabs);
  assert.equal(await ui("document.querySelector('#source-editor').value"), explorerEdits);
  const warmFile = path.join(temporary, 'Warm résumé 日本語.md');
  await writeFile(warmFile, '# Another Explorer document\n');
  await launch([path.basename(warmFile)]);
  await waitFor(async () => ui(`document.querySelector('#filename').textContent === ${JSON.stringify(path.basename(warmFile))} && document.querySelector('#app').getAttribute('aria-busy') === 'false'`), 'relative second-launch file opens in a tab');
  assert.equal(await tabCount(), originalTabs + 1);
  assert.equal(await main.evaluate("smokeElectron.BrowserWindow.getAllWindows().length"), 1);
  await menuAction('close-tab');
  assert.equal(await ui("document.querySelector('#source-editor').value"), explorerEdits);
  await main.evaluate("globalThis.smokeSaveDialog = smokeElectron.dialog.showSaveDialog; smokeElectron.dialog.showSaveDialog = () => new Promise(resolve => { globalThis.smokeResumeSave = resolve; })");
  await ui("document.querySelector('[data-action=save-as]').click()");
  await waitFor(async () => main.evaluate("typeof smokeResumeSave === 'function'"), 'Save As holds the renderer busy');
  const queuedFile = path.join(temporary, 'Queued file.md');
  await writeFile(queuedFile, '# Queued while busy\n');
  await launch(['missing.md', path.basename(queuedFile)]);
  assert.equal(await tabCount(), originalTabs, 'Busy editor has not switched tabs');
  await main.evaluate("smokeElectron.dialog.showSaveDialog = smokeSaveDialog; smokeResumeSave({canceled:true})");
  await waitFor(async () => ui("document.querySelector('#filename').textContent === 'Queued file.md' && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'queued file opens after Save As completes');
  assert.match(await ui("document.querySelector('#notification').textContent"), /Could not open.*missing\.md/);
  assert.equal(await tabCount(), originalTabs + 1, 'A failed file does not prevent the next file from opening');
  await menuAction('close-tab');
  assert.equal(await ui("document.querySelector('#source-editor').value"), explorerEdits);
  console.log('PASS: real second-process launches reuse one window, restore minimized windows, open relative Unicode paths in tabs, preserve duplicate-file edits, and queue busy-time requests with visible per-file errors');
  const content = '# Desktop export test\n\n**Bold** and *italic*.\n\n| Item | Value |\n| --- | --- |\n| A | B |\n\n- [x] Tested\n\n> A quote\n\n```js\nconst answer = 42;\n```\n';
  await sourceEdit(content);
  assert.match(await ui("document.querySelector('#save-status').textContent"), /Unsaved/);
  await action('save');
  assert.equal(await readFile(file, 'utf8'), content);
  await sourceEdit(content + '\nUndo this');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), content);
  await menuAction('redo');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Undo this/);
  await menuAction('undo');
  console.log('PASS: source editing, dirty state, undo, and redo');

  await action('find');
  assert.equal(await ui("document.querySelector('#find-panel').hidden"), false);
  assert.equal(await ui("document.querySelector('[data-action=find]').getAttribute('aria-expanded')"), 'true');
  assert.equal(await ui("document.activeElement.id"), 'find-text');
  await ui("document.querySelector('#find-text').value='answer'; document.querySelector('#replace-text').value='result'");
  await action('find');
  assert.equal(await ui("document.querySelector('#find-panel').hidden"), true);
  assert.equal(await ui("document.querySelector('[data-action=find]').getAttribute('aria-expanded')"), 'false');
  await action('find');
  assert.equal(await ui("document.querySelector('#find-text').value"), 'answer');
  assert.equal(await ui("document.querySelector('#replace-text').value"), 'result');
  await action('replace-all');
  assert.match(await ui("document.querySelector('#source-editor').value"), /const result = 42/);
  await menuAction('undo');
  await action('find-close');
  assert.equal(await ui("document.querySelector('#find-panel').hidden"), true);
  await nativeShortcut('F');
  await waitFor(async () => ui("!document.querySelector('#find-panel').hidden"), 'native Find opens');
  await nativeShortcut('F', ['control'], false);
  await waitFor(async () => ui("document.querySelector('#find-panel').hidden"), 'native Find toggles closed');
  await action('find');
  await nativeShortcut('Escape', [], false);
  await waitFor(async () => ui("document.querySelector('#find-panel').hidden"), 'Escape closes Find');
  assert.equal(await ui("document.activeElement.id"), 'source-editor');
  await action('visual');
  assert.equal(await ui("document.querySelector('.tiptap h1').textContent"), 'Desktop export test');
  console.log('PASS: Find button/shortcut toggling, retained query, Close/Escape, focus restoration, find/replace, and visual rendering of edited source');
  await action('source');
  await sourceEdit('# Preview test\n\nCat cat scatter cat_\n\n## Same\n\n## Same\n');
  await action('preview');
  await waitFor(async () => ui("document.querySelector('.live-preview:not([hidden]) h1')?.textContent === 'Preview test'"), 'same-document live preview');
  assert.equal(await ui("document.querySelector('.live-preview [contenteditable=true]') === null"), true);
  assert.equal(await ui("document.querySelector('#preview-toggle').textContent"), 'Back to editing');
  assert.equal(await ui("document.querySelector('#preview-source').checked"), true);
  assert.ok(await ui("(() => {const preview=document.querySelector('.live-preview').getBoundingClientRect(), source=document.querySelector('.source-surface').getBoundingClientRect();return preview.right <= source.left + 1 && source.width > 0})()"), 'Reader Preview is left of editable Markdown');
  await ui("document.querySelector('#preview-source').click()");
  assert.equal(await ui("document.querySelector('#source-editor').hidden"), true, 'Markdown beside Preview is optional');
  assert.equal(await ui("document.querySelector('[data-command=bold]').disabled"), true, 'Reader-only Preview cannot edit hidden content');
  const readerSnapshot = await ui("document.querySelector('#source-editor').value");
  await menuAction('format:bold');
  assert.equal(await ui("document.querySelector('#source-editor').value"), readerSnapshot, 'Native editing commands cannot modify the reader-only view');
  const rejectPreviewImage = async type => {
    const prevented = await ui(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(testPNG(2,2).toString('base64'))}), c => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], 'preview.png', {type:'image/png'}));
      const event = ${type === 'paste'
        ? "new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true})"
        : "new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true})"};
      document.querySelector('.live-preview:not([hidden])').dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    assert.equal(prevented, true);
    assert.equal(await ui("document.querySelector('#app').getAttribute('aria-busy')"), 'false');
    assert.equal(await ui("document.querySelector('#image-storage-dialog').open"), false);
    assert.equal(await ui("document.querySelector('#source-editor').value"), readerSnapshot, `${type} cannot edit Preview`);
    assert.match(await ui("document.querySelector('#notification').textContent"), /Preview is read-only/);
  };
  await rejectPreviewImage('paste');
  await rejectPreviewImage('drop');
  await ui("document.querySelector('#preview-source').click()");
  assert.equal(await ui("document.querySelector('#source-editor').hidden"), false);
  await rejectPreviewImage('paste');
  await rejectPreviewImage('drop');
  await ui(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(testPNG(2,2).toString('base64'))}), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'editable.png', {type:'image/png'}));
    const source = document.querySelector('#source-editor');
    source.setSelectionRange(source.value.length, source.value.length);
    source.dispatchEvent(new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true}));
  })()`);
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false' && document.querySelector('#source-editor').value.includes('data:image/png;base64,')"), 'Markdown beside Preview accepts image drops');
  await action('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), readerSnapshot, 'Undo removes an image dropped into Markdown beside Preview');
  await action('preview');
  assert.equal(await ui("document.querySelector('#view-markdown').getAttribute('aria-pressed')"), 'true', 'Back to editing restores the previous Markdown view');
  await action('preview');
  await sourceEdit('# Preview changed\n\nCat cat scatter cat_\n\n## Same\n\n## Same\n');
  await waitFor(async () => ui("document.querySelector('.live-preview:not([hidden]) h1')?.textContent === 'Preview changed'"), 'live preview follows source edits');
  await action('undo');
  assert.match(await ui("document.querySelector('#source-editor').value"), /^# Preview test/);
  await action('find');
  await ui("document.querySelector('#find-text').value='cat'; document.querySelector('#find-case').checked=false; document.querySelector('#find-word').checked=true;");
  await action('find-next');
  assert.equal(await ui("document.querySelector('#find-result').textContent"), '1 of 2 matches');
  assert.equal(await ui("document.querySelectorAll('.source-highlights mark').length"), 2);
  await action('find-previous');
  assert.equal(await ui("document.querySelector('#find-result').textContent"), '2 of 2 matches');
  await ui("document.querySelector('#replace-text').value='dog'");
  await action('replace-one');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Cat dog scatter cat_/);
  await action('undo');
  await ui("document.querySelector('#find-word').checked=false; document.querySelector('#find-regex').checked=true; document.querySelector('#find-text').value='(C|c)at'; document.querySelector('#replace-text').value='$1ow';");
  await action('replace-all');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Cow cow scowter cow_/);
  await action('undo');
  await ui("document.querySelector('#find-text').value='['");
  await action('find-next');
  assert.match(await ui("document.querySelector('#notification').textContent"), /Invalid regular expression/);
  await sourceEdit('# Regex budget\n\n' + 'a'.repeat(300) + '!');
  await ui("document.querySelector('#find-text').value='(a+)+$'");
  const searchStarted = Date.now();
  await action('find-next');
  const searchElapsed = Date.now() - searchStarted;
  assert.ok(searchElapsed >= 1800 && searchElapsed < 10000, 'Pathological regex is terminated within a bounded interval');
  assert.match(await ui("document.querySelector('#notification').textContent"), /exceeded two seconds/);
  assert.match(await ui("document.querySelector('#source-editor').value"), /^# Regex budget/);
  await sourceEdit('# Preview test\n\nCat cat scatter cat_\n\n## Same\n\n## Same\n');
  await ui("document.querySelector('#find-case').checked=true; document.querySelector('#find-word').checked=false; document.querySelector('#find-regex').checked=false;");
  await action('find-close');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,0)");
  await menuAction('insert:toc');
  await sourceEdit((await ui("document.querySelector('#source-editor').value")) + '\n## Added later\n');
  await menuAction('insert:toc');
  assert.match(await ui("document.querySelector('#source-editor').value"), /\[Added later\]\(#added-later\)/);
  await action('visual');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-contents]').length"), 1);
  const contentsSource = await ui("document.querySelector('#source-editor').value.match(/<!-- lekh:toc -->[\\s\\S]*?<!-- \\/lekh:toc -->/)[0]");
  assert.equal(await ui(`(() => {
    const target = document.querySelector('.tiptap');
    const wrapper = new DOMParser().parseFromString(target.editor.getHTML(), 'text/html').querySelector('[data-lekh-contents]');
    const clipboard = new DataTransfer();
    clipboard.setData('text/html', wrapper.outerHTML);
    clipboard.setData('text/plain', wrapper.textContent);
    target.editor.commands.setTextSelection(target.editor.state.doc.content.size);
    const event = new ClipboardEvent('paste', {clipboardData:clipboard,bubbles:true,cancelable:true});
    target.dispatchEvent(event);
    return event.defaultPrevented;
  })()`), true, 'the editor handles the HTML clipboard paste');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-contents]').length"), 2, 'contents HTML clipboard paste inserts another TOC');
  assert.equal(await ui("Array.from(document.querySelectorAll('[data-lekh-contents]')).every(node => node.querySelector('a[href=\"#added-later\"]'))"), true, 'TOC clipboard parsing retains the Markdown payload and links');
  await action('undo');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-contents]').length"), 1);
  await ui("document.querySelector('.tiptap').focus()");
  await nativeShortcut('End', ['control']);
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].webContents.insertText('Visual edit')");
  await action('source');
  assert.match(await ui("document.querySelector('#source-editor').value"), /<!-- lekh:toc -->/);
  await menuAction('insert:toc');
  const contentsPrefix = '\n\n# Padded   heading\n\n\n';
  const contentsSuffix = '\n\nparagraph   with   spaces  \n\n';
  await sourceEdit(contentsPrefix + contentsSource + contentsSuffix);
  await action('visual');
  await menuAction('insert:toc');
  await action('source');
  const refreshedContents = await ui("document.querySelector('#source-editor').value");
  assert.ok(refreshedContents.startsWith(contentsPrefix), 'Visual TOC update preserves preceding source bytes');
  assert.ok(refreshedContents.endsWith(contentsSuffix), 'Visual TOC update preserves following source bytes');
  assert.match(refreshedContents, /\[Padded {3}heading\]\(#padded---heading\)/);
  await sourceEdit(content);
  await action('visual');
  console.log('PASS: same-document live preview/undo, enhanced search/highlights/regex, and refreshable TOC through Visual edits');

  await writeFile(file, '# External change');
  await action('save');
  assert.match(await ui("document.querySelector('#notification').textContent"), /changed or was removed outside/);
  assert.equal(await readFile(file, 'utf8'), '# External change');
  console.log('PASS: outside edits are detected and never silently overwritten');
  const copied = path.join(temporary, 'saved-as.md');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(copied)}`);
  await menuAction('save-as');
  assert.equal(await ui("document.querySelector('#notification').textContent"), 'saved-as.md saved', 'Save As confirms the new filename');
  assert.equal(await readFile(copied, 'utf8'), content);
  assert.equal(await readFile(file, 'utf8'), '# External change');
  console.log('PASS: native Save As preserves both versions');

  const docx = path.join(temporary, 'export.docx');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(docx)}`);
  await menuAction('export-docx');
  const word = await readFile(docx);
  assert.equal(word.subarray(0, 2).toString(), 'PK');
  assert.ok(word.length > 7000);
  console.log(`PASS: native Word export (${word.length} bytes)`);

  const pdf = path.join(temporary, 'export.pdf');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(pdf)}`);
  await menuAction('export-pdf');
  const pdfData = await readFile(pdf);
  assert.equal(pdfData.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdfData.length > 10000);
  assert.match(pdfData.toString('latin1'), /\/Type\s*\/Page\b/);
  console.log(`PASS: native PDF export (${pdfData.length} bytes, valid page objects)`);

  const imagePath = path.join(temporary, 'pixel.png');
  await writeFile(imagePath, testPNG(1, 1));
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(imagePath)}`);
  await action('image');
  await waitFor(async () => ui("Array.from(document.querySelectorAll('.tiptap img')).some(image => image.complete && image.naturalWidth === 1)"), 'embedded image display');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(path.join(temporary, 'with-image.pdf'))}`);
  await menuAction('export-pdf');
  assert.match((await readFile(path.join(temporary, 'with-image.pdf'))).toString('latin1'), /\/Subtype\s*\/Image\b/);
  await main.evaluate(`smokeSavePath = ${JSON.stringify(path.join(temporary, 'with-image.docx'))}`);
  await menuAction('export-docx');
  assert.ok((await readFile(path.join(temporary, 'with-image.docx'))).length > word.length);
  console.log('PASS: native image picker embeds an image that displays and exports to both formats');
  await ui("window.smokeImageStorage='assets'");
  await action('image');
  await action('source');
  const assetMarkdown = await ui("document.querySelector('#source-editor').value");
  const assetPath = /!\[Image\]\((assets\/[^)]+\.png)\)/.exec(assetMarkdown)?.[1];
  assert.ok(assetPath, 'Assets choice writes a relative Markdown image');
  assert.deepEqual(await readFile(path.join(path.dirname(copied), assetPath)), testPNG(1,1));
  await action('visual');
  await waitFor(async () => ui("Array.from(document.querySelectorAll('.tiptap img')).some(image => image.complete && image.naturalWidth === 1 && image.getAttribute('data-lekh-source')?.startsWith('assets/'))"), 'new asset displays through scoped protocol');
  await ui("window.smokeImageStorage='cancel'");
  await action('image');
  await action('source');
  assert.equal(await ui("document.querySelector('#source-editor').value"), assetMarkdown);
  await ui("window.smokeImageStorage='assets'");
  await ui("(() => {const source=document.querySelector('#source-editor');source.focus();source.setSelectionRange(source.value.length,source.value.length)})()");
  const beforeDrop = await ui("(() => {const source=document.querySelector('#source-editor');return {start:source.selectionStart,end:source.selectionEnd,assets:(source.value.match(/assets\\//g)||[]).length,context:source.value.slice(source.selectionStart-40,source.selectionEnd+80)}})()");
  await ui(`(() => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(testPNG(2,2).toString('base64'))}), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'dropped.png', {type:'image/png'}));
    document.querySelector('#source-editor').dispatchEvent(new DragEvent('drop', {dataTransfer:transfer,bubbles:true,cancelable:true}));
  })()`);
  try {
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false' && (document.querySelector('#source-editor').value.match(/assets\\//g)||[]).length === 2"), 'dropped image uses assets storage');
  } catch (error) {
    const afterDrop = await ui("(() => {const source=document.querySelector('#source-editor');return {start:source.selectionStart,end:source.selectionEnd,assets:(source.value.match(/assets\\//g)||[]).length,context:source.value.slice(source.selectionStart-100,source.selectionEnd+80),notification:document.querySelector('#notification').textContent,dialog:document.querySelector('#image-storage-dialog').open,busy:document.querySelector('#app').getAttribute('aria-busy')}})()");
    throw new Error(`Image drop state: ${JSON.stringify({ beforeDrop, afterDrop })}`, { cause: error });
  }
  assert.ok((await ui("document.querySelector('#source-editor').value")).startsWith(assetMarkdown), 'Dropping after the document preserves the existing image');
  await ui("window.smokeImageStorage='embedded'");
  const insertionFixture = '# Before diagram\n\nAlpha middle omega.\n\n## After diagram\n\nTail remains.\n';
  for (const width of [1320, 850]) {
    await main.evaluate(`smokeElectron.BrowserWindow.getAllWindows()[0].setSize(${width},900)`);
    await delay(150);
    await sourceEdit(insertionFixture);
    await action('visual');
    await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].focus(); smokeElectron.BrowserWindow.getAllWindows()[0].webContents.focus()");
    await waitFor(async () => ui("document.hasFocus()"), 'keyboard focus before setting the Visual caret');
    const diagramCaret = await ui(`(() => {
      const editor=document.querySelector('#visual-editor .tiptap');editor.focus();
      const text=editor.querySelector('p').firstChild,position=editor.editor.view.posAtDOM(text,6);
      editor.editor.commands.setTextSelection(position);
      return position;
    })()`);
    await waitFor(async () => ui(`(() => {const editor=document.querySelector('#visual-editor .tiptap').editor,selection=window.getSelection();return editor.state.selection.from === ${diagramCaret} && selection.anchorNode && editor.view.posAtDOM(selection.anchorNode,selection.anchorOffset) === ${diagramCaret}})()`), 'middle caret synchronizes with the editor and DOM');
    await clickMermaid();
    assert.equal(await ui("document.querySelector('#source-editor').hidden"), true, 'Visual Mermaid insertion keeps Visual mode');
    await waitFor(async () => ui("document.querySelector('#visual-editor .mermaid-preview img')?.naturalWidth > 0"), 'inserted Mermaid renders at caret');
    const diagramPlacement = await ui(`(() => {
      const block=document.querySelector('#visual-editor .code-block');
      return {previous:block?.previousElementSibling?.textContent ?? null,next:block?.nextElementSibling?.textContent ?? null,
        children:[...document.querySelector('#visual-editor .tiptap').children].map(node=>({tag:node.tagName,text:node.textContent}))};
    })()`);
    assert.deepEqual([diagramPlacement.previous, diagramPlacement.next], ['Alpha ', 'middle omega.'], `Mermaid must be inserted at the middle caret: ${JSON.stringify(diagramPlacement)}`);
    assert.equal(await ui("document.querySelector('#visual-editor .tiptap').lastElementChild.textContent"), 'Tail remains.');
    await menuAction('undo');
    assert.equal(await ui("document.querySelector('#visual-editor .code-block')"), null, 'One undo removes diagram insertion');
    assert.equal(await ui("document.querySelector('#visual-editor .tiptap p').textContent"), 'Alpha middle omega.');
    await action('source');
  }
  await sourceEdit(insertionFixture);
  const insertionCaret = insertionFixture.indexOf('middle');
  await ui(`document.querySelector('#source-editor').setSelectionRange(${insertionCaret},${insertionCaret})`);
  await clickMermaid();
  const insertedSource = await ui("document.querySelector('#source-editor').value");
  assert.ok(insertedSource.indexOf('```mermaid') > insertedSource.indexOf('Alpha '));
  assert.ok(insertedSource.indexOf('```mermaid') < insertedSource.indexOf('middle omega.'));
  assert.ok(insertedSource.endsWith('Tail remains.\n'), 'Source Mermaid insertion preserves following content');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), insertionFixture, 'Source Mermaid insertion is one undo step');
  await action('source');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  console.log('PASS: real toolbar and overflow-menu Mermaid insertion at a middle Visual caret, rendered position, preserved trailing content/mode, Source caret insertion, and single-step undo');
  await sourceEdit('# Diagrams\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n');
  await action('preview');
  await waitFor(async () => ui("document.querySelector('.live-preview .mermaid-preview img')?.complete && document.querySelector('.live-preview .mermaid-preview img')?.naturalWidth > 0"), 'offline Mermaid live preview');
  await action('visual');
  await waitFor(async () => ui("document.querySelector('#visual-editor .mermaid-preview img')?.naturalWidth > 0"), 'offline Mermaid Visual rendering');
  for (const format of ['pdf', 'docx']) {
    const output = path.join(temporary, `mermaid-export.${format}`);
    await main.evaluate(`smokeSavePath = ${JSON.stringify(output)}`);
    await menuAction(`export-${format}`);
    const bytes = await readFile(output);
    assert.ok(bytes.length > 1000, 'Mermaid native export produces a document');
    if (format === 'pdf') assert.match(bytes.toString('latin1'), /\/Subtype\s*\/Image\b/);
    else assert.equal(bytes.subarray(0,2).toString(), 'PK');
  }
  await action('source');
  await sourceEdit('# Invalid diagram\n\n```mermaid\nflowchart LR\n A[broken\n```\n');
  await action('preview');
  await waitFor(async () => ui("document.querySelector('.live-preview .mermaid-error')?.textContent.includes('could not be rendered')"), 'invalid Mermaid has explicit error');
  await action('source');
  await sourceEdit(content);
  await action('visual');
  console.log('PASS: relative image asset storage/cancel, offline Mermaid Visual/live preview, invalid-diagram errors, and native PDF/Word diagram exports');
  await action('source');
  await sourceEdit(content + '\n![Local image](pixel.png)\n');
  await action('visual');
  await waitFor(async () => ui("Array.from(document.querySelectorAll('.tiptap img')).some(image => image.complete && image.naturalWidth === 1 && image.src.startsWith('lekh-image:'))"), 'relative image protocol');
  console.log('PASS: relative local images display through the scoped image protocol');
  const imageTab = await activeTab();
  const otherFolder = path.join(temporary, 'other');
  await mkdir(otherFolder);
  await writeFile(path.join(otherFolder, 'pixel.png'), testPNG(2, 2));
  const otherDocument = path.join(otherFolder, 'other.md');
  await writeFile(otherDocument, '# Other image\n\n![Different image](pixel.png)\n');
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(otherDocument)}`);
  await action('open');
  const otherTab = await activeTab();
  await waitFor(async () => ui("document.querySelector('.tiptap img')?.naturalWidth === 2"), 'second tab relative image');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(path.join(temporary, 'other-image.pdf'))}`);
  await menuAction('export-pdf');
  assert.match((await readFile(path.join(temporary, 'other-image.pdf'))).toString('latin1'), /\/Width 2\b/);
  await selectTab(imageTab);
  assert.equal(await ui("document.querySelector('.tiptap img').naturalWidth"), 1);
  await main.evaluate(`smokeSavePath = ${JSON.stringify(path.join(temporary, 'first-image.pdf'))}`);
  await menuAction('export-pdf');
  assert.match((await readFile(path.join(temporary, 'first-image.pdf'))).toString('latin1'), /\/Width 1\b/);
  await selectTab(otherTab);
  await menuAction('close-tab');
  await selectTab(imageTab);
  console.log('PASS: identically named relative images display and export from each tab\'s own folder');
  await action('source');
  await sourceEdit(content);
  await sourceEdit(content + '\nUnsaved writing');
  await main.evaluate('smokeChoice = 2');
  await main.evaluate('smokeElectron.BrowserWindow.getAllWindows()[0].close()');
  await delay(200);
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'cancel window close');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Unsaved writing/);
  console.log('PASS: cancelling native window close preserves unsaved work');
  const firstTab = await activeTab();
  const beforeNew = await tabCount();
  await action('new');
  assert.match(await ui("document.querySelector('#filename').textContent"), /^Untitled(?: \d+)?\.md$/);
  assert.equal(await tabCount(), beforeNew + 1);
  const secondTab = await activeTab();
  const secondContent = '# Second document\n\nIndependent words.';
  await sourceEdit(secondContent);
  await selectTab(firstTab);
  assert.equal(await ui("document.querySelector('#source-editor').value"), content + '\nUnsaved writing');
  await ui("document.querySelector('#source-editor').setSelectionRange(5, 12)");
  await selectTab(secondTab);
  assert.equal(await ui("document.querySelector('#source-editor').value"), secondContent);
  await selectTab(firstTab);
  assert.deepEqual(await ui("(() => { const s = document.querySelector('#source-editor'); return [s.selectionStart, s.selectionEnd]; })()"), [5, 12]);
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), content);
  await menuAction('redo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), content + '\nUnsaved writing');
  console.log('PASS: New keeps unsaved tabs open; source edits, selections, and undo are independent');

  await main.evaluate(`smokeOpenPath = ${JSON.stringify(copied)}`);
  await action('open');
  assert.equal(await tabCount(), beforeNew + 1);
  assert.equal(await activeTab(), firstTab);
  assert.match(await ui("document.querySelector('#source-editor').value"), /Unsaved writing/);
  console.log('PASS: opening an already-open file focuses its existing tab without losing edits');

  await selectTab(secondTab);
  await main.evaluate(`smokeSavePath = ${JSON.stringify(copied)}`);
  await menuAction('save-as');
  assert.match(await ui("document.querySelector('#notification').textContent"), /already open in another tab/);
  assert.equal(await readFile(copied, 'utf8'), content);
  const secondPath = path.join(temporary, 'second.md');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(secondPath)}`);
  await menuAction('save-all');
  assert.equal(await readFile(copied, 'utf8'), content + '\nUnsaved writing');
  assert.equal(await readFile(secondPath, 'utf8'), secondContent);
  assert.equal(await activeTab(), secondTab);
  console.log('PASS: Save As cannot overwrite another tab; Save All writes each document to its own file');

  await selectTab(firstTab);
  await sourceEdit(content + '\nFirst dirty tab');
  await selectTab(secondTab);
  await sourceEdit(secondContent + '\nSecond dirty tab');
  await main.evaluate('smokeChoices = [1,2]; smokeElectron.BrowserWindow.getAllWindows()[0].close()');
  await delay(200);
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'cancel after discard');
  assert.equal(await activeTab(), secondTab);
  await selectTab(firstTab);
  assert.match(await ui("document.querySelector('#source-editor').value"), /First dirty tab/);
  await selectTab(secondTab);
  assert.match(await ui("document.querySelector('#source-editor').value"), /Second dirty tab/);
  await sourceEdit(secondContent);
  console.log('PASS: canceling exit after discarding an earlier tab retains all unsaved edits');

  await selectTab(firstTab);
  await sourceEdit(content + '\nSaved from the first tab');
  await selectTab(secondTab);
  await main.evaluate('smokeChoice = 2; smokeElectron.BrowserWindow.getAllWindows()[0].close()');
  await delay(200);
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'inactive dirty close protection');
  assert.equal(await activeTab(), firstTab, 'Window close checks unsaved inactive tabs');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Saved from the first tab/);
  await menuAction('close-tab');
  assert.equal(await tabCount(), beforeNew + 1, 'Cancel keeps a dirty tab open');
  await main.evaluate('smokeChoice = 0');
  await menuAction('close-tab');
  assert.equal(await tabCount(), beforeNew);
  assert.equal(await readFile(copied, 'utf8'), content + '\nSaved from the first tab');
  assert.equal(await activeTab(), secondTab);
  console.log('PASS: inactive unsaved files prevent app exit; tab close supports Cancel and Save');

  await menuAction('next-tab');
  assert.notEqual(await activeTab(), secondTab);
  await menuAction('previous-tab');
  assert.equal(await activeTab(), secondTab);
  await action('new');
  await action('visual');
  const plusPlacement = await ui(`(() => {
    const tab=[...document.querySelectorAll('#tabs .document-tab')].filter(tab=>tab.getClientRects().length).at(-1).getBoundingClientRect();
    const plus=document.querySelector('.tabs-bar > [data-action="new"]').getBoundingClientRect();
    return {gap:plus.left-tab.right,right:plus.right,width:innerWidth};
  })()`);
  assert.ok(plusPlacement.gap >= 0 && plusPlacement.gap <= 8, 'New-tab plus follows the rightmost document without unused space');
  assert.ok(plusPlacement.right <= plusPlacement.width, 'New-tab plus stays visible');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), '', 'Undo cannot resurrect a previous document');
  console.log('PASS: undo history is isolated between documents');
  await ui("document.querySelector('.tiptap').focus()");
  await browser.call('Input.insertText', { text: 'Visual writing ' }, sessionId);
  await ui("document.querySelector('[data-command=bold]').click()");
  await browser.call('Input.insertText', { text: 'bold words' }, sessionId);
  const richTab = await activeTab();
  await selectTab(secondTab);
  await selectTab(richTab);
  await menuAction('undo');
  assert.doesNotMatch(await ui("document.querySelector('.tiptap').textContent"), /bold words/);
  await menuAction('redo');
  await action('source');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Visual writing \*\*bold words\*\*/);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  console.log('PASS: new tabs have isolated undo; real visual typing and formatting still work');
  await menuAction('theme');
  assert.equal(await ui("document.documentElement.dataset.theme"), 'dark');
  const darkBrandIcon = await brandSource();
  assert.notEqual(darkBrandIcon, lightBrandIcon);
  if (darkBrandIcon.startsWith('data:image/svg+xml')) {
    const comma = darkBrandIcon.indexOf(',');
    const payload = darkBrandIcon.slice(comma + 1);
    const svg = darkBrandIcon.slice(0, comma).endsWith(';base64') ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
    for (const color of ['#356f68', '#275950', '#80bfb8', '#e6eee4']) assert.ok(svg.includes(color), `The embedded dark artwork includes ${color}`);
  } else {
    assert.match(darkBrandIcon, /\/icon-dark(?:-[\w-]+)?\.svg$/);
  }
  await main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('theme-light').click()");
  await waitFor(async () => ui("document.documentElement.dataset.theme === 'light' && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'native Light menu');
  await main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('theme-dark').click()");
  await waitFor(async () => ui("document.documentElement.dataset.theme === 'dark' && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'native Dark menu');
  assert.equal(await ui("getComputedStyle(document.body).backgroundColor"), 'rgb(11, 17, 21)');
  assert.equal(await ui("getComputedStyle(document.querySelector('.paper')).backgroundColor"), 'rgb(23, 25, 25)');
  assert.equal(await ui("getComputedStyle(document.body).getPropertyValue('--accent').trim()"), '#80bfb8');
  await waitFor(async () => (await ui("getComputedStyle(document.querySelector('.primary')).backgroundColor")) === 'rgb(128, 191, 184)', 'Primary button settles on the Dark accent');
  assert.equal(await ui("document.querySelector('#theme-toggle span').textContent"), 'Dark');
  assert.equal(await ui("document.querySelector('#theme-toggle').getAttribute('aria-label')"), 'Switch to light theme');
  assert.equal(await ui("localStorage.getItem('lekh-theme')"), 'dark');
  assert.equal(await main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('theme-dark').checked"), true);
  assert.equal(await main.evaluate("Boolean(smokeElectron.Menu.getApplicationMenu().getMenuItemById('theme-github-dark'))"), false);
  assert.equal(await main.evaluate("smokeElectron.nativeTheme.themeSource"), 'dark');
  assert.equal(await brandSource(), darkBrandIcon);
  await action('theme');
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'light theme selector');
  assert.equal(await ui("getComputedStyle(document.body).backgroundColor"), 'rgb(247, 249, 248)');
  assert.equal(await main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('theme-light').checked"), true);
  assert.equal(await main.evaluate("smokeElectron.nativeTheme.themeSource"), 'light');
  assert.equal(await brandSource(), lightBrandIcon);
  await menuAction('theme');
  await menuAction('focus');
  assert.equal(await ui("document.body.classList.contains('focus-mode')"), true);
  await menuAction('focus');
  assert.equal(await ui("Boolean(document.querySelector('[data-action=focus]'))"), false);
  const workspaceSpacing = await ui("(() => {const bar=document.querySelector('.toolbar').getBoundingClientRect();const tabs=document.querySelector('.tabs-bar').getBoundingClientRect();return {gap:bar.top-tabs.bottom,height:bar.height};})()");
  assert.equal(workspaceSpacing.gap, 0);
  assert.ok(workspaceSpacing.height <= 82, JSON.stringify(workspaceSpacing));
  await action('sidebar');
  assert.equal(await ui("document.querySelector('#sidebar').hidden"), false);
  assert.equal(await ui("document.querySelector('#sidebar').getBoundingClientRect().width"), 40);
  assert.equal(await ui("document.querySelector('#sidebar-toggle').getAttribute('aria-expanded')"), 'false');
  for (const selector of ['.file-actions [data-action=new]', '.file-actions [data-action=open]', '#theme-toggle', '.sidebar-bottom [data-action=shortcuts]']) {
    assert.ok(await ui(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().width > 0`), `${selector} stays available in collapsed rail`);
  }
  await action('shortcuts');
  assert.equal(await ui("document.querySelector('#shortcuts-dialog').open"), true);
  await ui("document.querySelector('#shortcuts-dialog').close()");
  await menuAction('focus');
  await menuAction('focus');
  assert.equal(await ui("document.querySelector('#sidebar').getBoundingClientRect().width"), 40, 'Leaving Focus mode restores collapsed rail');
  await action('sidebar');
  assert.equal(await ui("document.querySelector('#sidebar').hidden"), false);
  assert.ok(await ui("document.querySelector('#sidebar-resizer').getBoundingClientRect().width") >= 8);
  const sidebarDrag = await ui("(() => {const handle=document.querySelector('#sidebar-resizer').getBoundingClientRect();return {x:handle.x+handle.width/2,y:handle.y+handle.height/2};})()");
  await browser.call('Input.dispatchMouseEvent', {type:'mousePressed',x:sidebarDrag.x,y:sidebarDrag.y,button:'left',buttons:1,clickCount:1}, sessionId);
  await browser.call('Input.dispatchMouseEvent', {type:'mouseMoved',x:sidebarDrag.x+100,y:sidebarDrag.y,button:'left',buttons:1}, sessionId);
  await browser.call('Input.dispatchMouseEvent', {type:'mouseReleased',x:sidebarDrag.x+100,y:sidebarDrag.y,button:'left',buttons:0,clickCount:1}, sessionId);
  await waitFor(async () => ui("localStorage.getItem('lekh-sidebar-width') === '320'"), 'sidebar drag remembered');
  assert.equal(await ui("document.querySelector('#sidebar').getBoundingClientRect().width"), 320);
  assert.equal(await ui("document.body.classList.contains('resizing-sidebar')"), false);
  await ui("document.querySelector('#sidebar-resizer').focus()");
  await nativeShortcut('Right', [], false);
  await waitFor(async () => ui("document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow') === '330'"), 'keyboard sidebar resize');
  await nativeShortcut('Home', [], false);
  await waitFor(async () => (await ui("document.querySelector('#sidebar').getBoundingClientRect().width")) === 200, 'sidebar width 200');
  await nativeShortcut('End', [], false);
  await waitFor(async () => (await ui("document.querySelector('#sidebar').getBoundingClientRect().width")) === 480, 'sidebar width 480');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,600)");
  await waitFor(async () => ui("document.querySelector('#sidebar').getBoundingClientRect().width <= window.innerWidth - 480"), 'sidebar constrained in narrow window');
  assert.equal(await ui("localStorage.getItem('lekh-sidebar-width')"), '480', 'Window resizing retains preferred width');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await waitFor(async () => ui("document.querySelector('#sidebar').getBoundingClientRect().width === 480"), 'sidebar preferred width restored');
  await ui("document.querySelector('#sidebar-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
  assert.equal(await ui("document.querySelector('#sidebar').getBoundingClientRect().width"), 220);
  await ui("document.querySelector('#sidebar-resizer').focus()");
  await nativeShortcut('Right', [], false);
  await waitFor(async () => ui("localStorage.getItem('lekh-sidebar-width') === '230'"), 'sidebar reset and subsequent resize');
  await menuAction('focus');
  await action('sidebar');
  assert.equal(await ui("document.body.classList.contains('focus-mode')"), false);
  assert.equal(await ui("document.querySelector('#sidebar').hidden"), false);
  console.log('PASS: compact header, collapsed action rail, shortcuts, accessible state, and focus-mode restoration');
  await nativeShortcut('B', ['control', 'shift']);
  await waitFor(async () => ui("document.body.classList.contains('sidebar-hidden')"), 'native sidebar shortcut');
  assert.equal(await ui("localStorage.getItem('lekh-sidebar-hidden')"), 'true');
  await action('help');
  assert.equal(await ui("document.querySelector('#help-dialog').open"), true);
  await ui("document.querySelector('#help-dialog').close()");
  console.log('PASS: theme, focus mode, and getting-started dialog');

  await action('new');
  await action('source');
  await sourceEdit(`- [ ] ${'A long task that wraps onto another line. '.repeat(5)}\n  - [x] Nested checked task\n- [x] Checked task`);
  await action('visual');
  await ui("document.querySelector('.paper').style.width='360px'");
  assert.ok(await ui("(() => { const p = document.querySelector('.tiptap ul[data-type=taskList] li > div > p'); return p.getBoundingClientRect().height > parseFloat(getComputedStyle(p).lineHeight) * 2; })()"));
  const wrappedAlignment = await taskOffsets();
  assert.ok(wrappedAlignment.length >= 3 && wrappedAlignment.every(offset => offset <= 1), `Wrapped and nested dark-mode tasks must align within 1px: ${wrappedAlignment}`);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  console.log('PASS: wrapped, nested, checked, and unchecked tasks align in dark mode');
  await menuAction('theme:dark');
  assert.equal(await ui("document.documentElement.dataset.theme"), 'dark');
  assert.equal(await brandSource(), darkBrandIcon);
  console.log('PASS: Light and Graphite + Teal Dark, theme toggle, native title-bar mode, synchronized menu, and saved preference');
  console.log('PASS: sidebar artwork switches through all theme controls, restores the original in Light, and uses the brighter variant in Dark');

  await selectTab(secondTab);
  await action('source');
  await sourceEdit('# Recoverable first draft\n\nFirst unsaved words');
  await action('new');
  await sourceEdit('# Recoverable second draft\n\nSecond unsaved words');
  const recoveredName = await ui("document.querySelector('#filename').textContent");
  await waitFor(async () => ui("JSON.parse(localStorage.getItem('lekh-draft-v1'))?.documents.length === 2"), 'both recovery drafts persisted');
  await ui("localStorage.setItem('lekh-sidebar-width','invalid')");
  await browser.call('Page.reload', {}, sessionId);
  await waitForReload(async () => ui("document.querySelector('#recovery-banner') && !document.querySelector('#recovery-banner').hidden && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'draft recovery');
  assert.equal(await ui("document.body.classList.contains('sidebar-hidden')"), true, 'Sidebar preference survives reload');
  await action('sidebar');
  assert.equal(await ui("document.querySelector('#sidebar').getBoundingClientRect().width"), 220, 'Invalid sidebar width uses the default without blocking draft recovery');
  assert.match(await ui("document.querySelector('#notification').textContent"), /Sidebar width could not be read/);
  await ui("document.querySelector('#sidebar-resizer').focus()");
  await nativeShortcut('Right', [], false);
  await waitFor(async () => ui("localStorage.getItem('lekh-sidebar-width') === '230'"), 'valid sidebar width saved');
  await ui("globalThis.smokeBeforeWidthReload = true");
  await browser.call('Page.reload', {}, sessionId);
  await waitForReload(async () => ui("!globalThis.smokeBeforeWidthReload && document.querySelector('#sidebar-resizer') && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'"), 'sidebar width reload');
  assert.equal(await ui("document.querySelector('#sidebar').getBoundingClientRect().width"), 230, 'Sidebar width survives reload');
  assert.equal(await ui("document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow')"), '230');
  await ui(imageChoices);
  console.log('PASS: sidebar drag/keyboard limits, reset, narrow-window constraint, preferred-width restoration, persistence across reload, and recovery despite invalid width');
  await action('recover');
  assert.equal(await tabCount(), 3);
  assert.match(await ui("document.querySelector('.tiptap').textContent"), /Second unsaved words/);
  assert.match(await ui("document.querySelector('#save-status').textContent"), /Unsaved/);
  assert.equal(await ui("document.querySelector('#filename').textContent"), `Recovered - ${recoveredName}`);
  await main.evaluate(`smokeSavePath = ${JSON.stringify(path.join(temporary, 'recovered.md'))}`);
  await action('save');
  assert.match(await readFile(path.join(temporary, 'recovered.md'), 'utf8'), /Second unsaved words/);
  assert.equal(await ui("JSON.parse(localStorage.getItem('lekh-draft-v1')).documents.length"), 1);
  await menuAction('previous-tab');
  assert.match(await ui("document.querySelector('.tiptap').textContent"), /First unsaved words/);
  await main.evaluate(`smokeSavePath = ${JSON.stringify(path.join(temporary, 'recovered-first.md'))}`);
  await action('save');
  assert.equal(await ui("localStorage.getItem('lekh-draft-v1')"), null);
  console.log('PASS: all unsaved tabs recover separately, and saving one retains the other draft');

  await main.evaluate(`
    globalThis.smokeContextMenu = null;
    globalThis.smokeClipboard = '';
    globalThis.smokeClipboardImage = smokeElectron.nativeImage.createEmpty();
    const buildMenu = smokeElectron.Menu.buildFromTemplate;
    smokeElectron.Menu.buildFromTemplate = function (...args) {
      const menu = buildMenu.apply(this, args);
      smokeContextMenu = menu;
      return menu;
    };
    smokeElectron.Menu.prototype.popup = function () { smokeContextMenu = this; };
    smokeElectron.clipboard.readText = () => smokeClipboard;
    smokeElectron.clipboard.writeText = text => { smokeClipboard = text; };
    globalThis.smokeImageReads = 0;
    smokeElectron.clipboard.readImage = () => { smokeImageReads++; return smokeClipboardImage; };
    smokeElectron.clipboard.writeImage = image => { smokeClipboardImage = image; };
    globalThis.smokeMenuItem = labels => {
      let menu = smokeContextMenu;
      let item;
      for (const label of labels) {
        item = menu.items.find(entry => entry.label === label);
        if (!item) throw new Error('Missing context item: ' + label);
        menu = item.submenu;
      }
      return item;
    };
  `);
  let contextSelector = '.tiptap p';
  const showContext = async (selector = contextSelector, corner = false) => {
    contextSelector = selector;
    await main.evaluate('smokeContextMenu = null');
    const point = await ui(`(() => {
      const requested = document.querySelector(${JSON.stringify(selector)});
      const element = requested?.getClientRects().length ? requested : document.querySelector('.active-pane .tiptap > :first-child');
      element.scrollIntoView({block:'center'});
      const box = element.getBoundingClientRect();
      if (${corner}) return {x:Math.min(box.right-12,innerWidth-24),y:Math.min(box.bottom-12,innerHeight-65)};
      const x = box.x + 12;
      for (const y of [box.y + 12, Math.max(1, Math.min((box.top + box.bottom) / 2, innerHeight - 2)), Math.min(box.bottom - 12, innerHeight - 65)]) {
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === element || element.contains(hit))) return {x,y};
      }
      throw new Error('The context-menu target is not visible at the selected point.');
    })()`);
    await browser.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', buttons: 2, clickCount: 1 }, sessionId);
    await browser.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', buttons: 0, clickCount: 1 }, sessionId);
    try {
      await waitFor(async () => ui("document.querySelector('#editor-context-menu').matches(':popover-open')"), 'compact right-click menu in the actual application');
    } catch (error) {
      const state = await ui(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        const hit = document.elementFromPoint(${point.x}, ${point.y});
        const box = element?.getBoundingClientRect();
        return {point:${JSON.stringify(point)},box:box && {left:box.left,top:box.top,right:box.right,bottom:box.bottom},
          viewport:[innerWidth,innerHeight],hit:hit && {tag:hit.tagName,id:hit.id,className:hit.className},
          active:document.activeElement?.id,notification:document.querySelector('#notification').textContent};
      })()`);
      const nativeMenu = await main.evaluate('Boolean(smokeContextMenu)');
      throw new Error(`Context-menu state: ${JSON.stringify({ state, nativeMenu })}`, { cause: error });
    }
  };
  const contextAction = async labels => {
    if (!await ui("document.querySelector('#editor-context-menu').matches(':popover-open')")) await showContext();
    await ui(`(() => {
      let menu = document.querySelector('#editor-context-menu');
      for (const label of ${JSON.stringify(labels)}) {
        const control = [...menu.querySelectorAll('button')].find(button => button.dataset.contextLabel === label && button.closest('[role=menu]') === menu);
        if (!control || control.disabled) throw new Error('Unavailable compact context action: ' + label);
        control.click();
        if (control.hasAttribute('aria-controls')) menu = document.getElementById(control.getAttribute('aria-controls'));
      }
    })()`);
    await delay(100);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), labels.join(' / '));
  };
  const selectParagraph = async () => {
    await ui(`(() => {
    const paragraph = document.querySelector('.tiptap p');
    paragraph.closest('.tiptap').focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    })()`);
    await delay(80);
  };

  await action('new');
  await action('visual');
  await ui("document.querySelector('.tiptap').focus()");
  await browser.call('Input.insertText', { text: 'Menu words' }, sessionId);
  await selectParagraph();
  await showContext();
  assert.equal(await ui("document.querySelectorAll('#editor-context-menu .context-tools button').length"), 8, 'Eight common editing commands stay directly accessible');
  assert.deepEqual(await ui("[...document.querySelectorAll('#editor-context-menu .context-tools button')].map(button => button.textContent)"), ['Cut', 'Copy', 'Paste', 'Delete', 'Bold', 'Italic', 'Code', 'Link']);
  assert.equal((await ui("window.lekh.contextMenuCommand('invalid-menu', 'invalid-command')")).ok, false, 'Invalid native context commands are rejected');
  if (process.env.LEKH_SCREENSHOT) {
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'compact-context-menu-desktop.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.equal(await main.evaluate("smokeMenuItem(['Table']).enabled"), true, 'Table menu is available before a table exists');
  assert.equal(await main.evaluate("smokeMenuItem(['Table', 'Insert table...']).enabled"), true);
  assert.equal(await main.evaluate("smokeMenuItem(['Table', 'Add row after']).enabled"), false);
  assert.equal(await main.evaluate("smokeMenuItem(['Edit', 'Copy / Paste As', 'Copy selection as Markdown']).enabled"), true, 'Right-click preserves the selected text');
  assert.ok(await main.evaluate("smokeMenuItem(['Formatting']).submenu.items.length >= 9"));
  assert.equal(await main.evaluate("smokeMenuItem(['Paragraph']).submenu.items.filter(item => item.label.startsWith('Heading')).length"), 6);
  for (const label of ['Footnote (Markdown)', 'Link reference (Markdown)', 'Math block (Markdown)', 'YAML front matter (Markdown)', 'Paragraph before', 'Paragraph after']) {
    assert.ok(await main.evaluate(`Boolean(smokeMenuItem(['Insert', ${JSON.stringify(label)}]))`));
  }
  assert.ok(await main.evaluate("Boolean(smokeMenuItem(['Insert', 'Structure', 'Table of contents']))"));
  await contextAction(['Formatting', 'Bold']);
  assert.equal(await ui("document.querySelector('.tiptap strong').textContent"), 'Menu words');
  await contextAction(['Paragraph', 'Heading 2']);
  assert.equal(await ui("document.querySelector('.tiptap h2').textContent"), 'Menu words');
  await showContext('.tiptap h2');
  assert.equal(await main.evaluate("smokeMenuItem(['Paragraph', 'Heading 2']).checked"), true);
  await contextAction(['Paragraph', 'Paragraph']);
  await selectParagraph();
  await showContext();
  await contextAction(['Edit', 'Copy / Paste As', 'Copy selection as Markdown']);
  assert.match(await main.evaluate('smokeClipboard'), /\*\*Menu words\*\*/);
  await contextAction(['Edit', 'Copy / Paste As', 'Copy document as Markdown']);
  assert.match(await main.evaluate('smokeClipboard'), /Menu words/);
  await contextAction(['Insert', 'Paragraph before']);
  await contextAction(['Insert', 'Paragraph after']);
  assert.ok(await ui("document.querySelectorAll('.tiptap p').length") >= 3);
  await contextAction(['Insert', 'Table']);
  assert.equal(await ui("document.querySelector('#table-dialog').open"), true);
  assert.equal(await ui("document.querySelector('#table-columns').value"), '3');
  assert.equal(await ui("document.querySelector('#table-rows').value"), '4');
  if (process.env.LEKH_SCREENSHOT) {
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'insert-table-dialog.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await ui("document.querySelector('#table-columns').value='5'; document.querySelector('#table-rows').value='7'; document.querySelector('#table-dialog button[value=insert]').click()");
  await waitFor(async () => ui("!document.querySelector('#table-dialog').open && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'chosen visual table dimensions');
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('.tiptap tr'), row => row.children.length)"), Array(7).fill(5));
  await showContext('.tiptap td p');
  assert.equal(await main.evaluate("smokeMenuItem(['Table']).enabled"), true);
  await contextAction(['Table', 'Add row after']);
  assert.equal(await ui("document.querySelectorAll('.tiptap tr').length"), 8);
  console.log('PASS: actual right-click menus format text, change headings, copy Markdown, insert paragraphs/tables, and edit table rows');
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');

  await action('new');
  await action('source');
  await sourceEdit('Before table\n\nAfter table');
  await ui("document.querySelector('#source-editor').setSelectionRange(14,14)");
  await showContext('#source-editor');
  assert.equal(await main.evaluate("smokeMenuItem(['Table']).enabled"), true);
  await contextAction(['Table', 'Insert table...']);
  await ui("document.querySelector('#table-dialog button[value=cancel]').click()");
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'Before table\n\nAfter table');
  await ui("document.querySelector('#source-editor').setSelectionRange(14,14)");
  await action('table');
  for (const [rows, columns] of [['0','3'], ['4','51'], ['101','3'], ['2.5','3'], ['','3']]) {
    await ui(`document.querySelector('#table-rows').value=${JSON.stringify(rows)}; document.querySelector('#table-columns').value=${JSON.stringify(columns)}; document.querySelector('#table-dialog button[value=insert]').click()`);
    assert.equal(await ui("document.querySelector('#table-dialog').open"), true);
    assert.equal(await ui("document.querySelector('#table-form').checkValidity()"), false);
    assert.equal(await ui("document.querySelector('#source-editor').value"), 'Before table\n\nAfter table');
  }
  await ui("document.querySelector('#table-rows').value='100'; document.querySelector('#table-columns').value='50'");
  assert.equal(await ui("document.querySelector('#table-form').checkValidity()"), true, 'Inclusive maximum table dimensions are accepted');
  await ui("document.querySelector('#table-rows').value='4'; document.querySelector('#table-columns').value='3'; document.querySelector('#table-dialog button[value=insert]').click()");
  await waitFor(async () => ui("!document.querySelector('#table-dialog').open && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'source table insertion');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Before table[\s\S]*\| Column 1 \| Column 2 \| Column 3 \|[\s\S]*After table/);
  await action('visual');
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('.tiptap tr'), row => row.children.length)"), [3,3,3,3]);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  await action('new');
  await action('visual');
  await nativeShortcut('T');
  await waitFor(async () => ui("document.querySelector('#table-dialog').open"), 'native Ctrl+T table dialog');
  await ui("document.querySelector('#table-rows').value='1'; document.querySelector('#table-columns').value='1'; document.querySelector('#table-columns').focus()");
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, sessionId);
  await waitFor(async () => ui("!document.querySelector('#table-dialog').open && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'minimum table size');
  assert.equal(await ui("document.querySelectorAll('.tiptap tr').length"), 1);
  assert.equal(await ui("document.querySelectorAll('.tiptap th').length"), 1);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  console.log('PASS: row/column dialog from context menus, toolbar and shortcut action; cancellation, invalid dimensions, exact Visual/Source table shapes, and 1x1 minimum');

  await action('new');
  await action('source');
  for (const [label, expected] of [
    ['Bold', '**menu** words'], ['Italic', '*menu* words'], ['Inline code', '`menu` words'],
    ['Block quote', '\n> menu words'], ['Numbered list', '\n1. menu words'],
    ['Bullet list', '\n- menu words'], ['Task list', '\n- [ ] menu words'],
  ]) {
    await sourceEdit('menu words');
    await ui("document.querySelector('#source-editor').setSelectionRange(0,4)");
    await showContext('#source-editor');
    await contextAction(['Bold', 'Italic', 'Inline code'].includes(label) ? [label] : ['Formatting', label]);
    assert.equal(await ui("document.querySelector('#source-editor').value"), expected, `Direct ${label} preserves and formats the Source selection`);
    await menuAction('undo');
    assert.equal(await ui("document.querySelector('#source-editor').value"), 'menu words', `Direct ${label} supports undo`);
  }
  await sourceEdit('remove keep');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,7)");
  await showContext('#source-editor');
  await contextAction(['Delete selection']);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'keep', 'Direct Delete really edits the focused Source selection');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'remove keep');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,0)");
  await showContext('#source-editor');
  assert.equal(await ui("document.querySelector('#editor-context-menu [data-context-label=Cut]').disabled"), true, 'Cut is disabled without a selection');
  assert.equal(await ui("document.querySelector('#editor-context-menu [data-context-label=Copy]').disabled"), true, 'Copy is disabled without a selection');
  await nativeShortcut('Escape', [], false);
  await ui("document.querySelector('#source-editor').setSelectionRange(0,6)");
  await showContext('#source-editor');
  await contextAction(['Link...']);
  assert.equal(await ui("document.querySelector('#link-dialog').open"), true);
  assert.equal(await ui("document.querySelector('#link-label').value"), 'remove');
  await ui("document.querySelector('#link-dialog button[value=cancel]').click()");
  await delay(100);
  await main.evaluate(`
    globalThis.smokeNativeEdits = [];
    globalThis.smokeEditMethods = {};
    for (const name of ['cut','copy','paste','pasteAndMatchStyle']) {
      const contents = smokeElectron.BrowserWindow.getAllWindows()[0].webContents;
      smokeEditMethods[name] = contents[name];
      contents[name] = () => smokeNativeEdits.push(name);
    }
    smokeClipboardImage = smokeElectron.nativeImage.createEmpty();
  `);
  for (const labels of [['Cut'], ['Copy'], ['Paste'], ['Edit', 'Copy / Paste As', 'Paste as plain text']]) {
    await showContext('#source-editor');
    await contextAction(labels);
    assert.equal(await ui("document.querySelector('#source-editor').readOnly"), false, 'Native editing is not blocked by the async-operation lock');
  }
  assert.deepEqual(await main.evaluate('smokeNativeEdits'), ['cut', 'copy', 'paste', 'pasteAndMatchStyle'], 'Compact clipboard buttons route to the native methods without touching the real user clipboard in this test');
  await main.evaluate("Object.assign(smokeElectron.BrowserWindow.getAllWindows()[0].webContents, smokeEditMethods)");
  await nativeShortcut('F10', ['shift']);
  await waitFor(async () => ui("document.querySelector('#editor-context-menu').matches(':popover-open')"), 'Shift+F10 opens the actual editor context menu');
  await ui("document.querySelector('#editor-context-menu > [data-context-label=Paragraph]').focus()");
  await nativeShortcut('Right', [], false);
  assert.match(await ui("document.activeElement.textContent"), /Heading/);
  await nativeShortcut('Escape', [], false);
  assert.equal(await ui("document.activeElement.dataset.contextLabel"), 'Paragraph');
  await nativeShortcut('Escape', [], false);
  assert.equal(await ui("document.activeElement === document.querySelector('#source-editor')"), true, 'Escape restores editing focus');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,600)");
  await delay(150);
  for (const label of ['Edit', 'Formatting', 'Paragraph', 'Insert', 'Table']) {
    await showContext('#source-editor', true);
    await ui(`(() => {const button=[...document.querySelectorAll('#editor-context-menu > button')].find(button=>button.dataset.contextLabel===${JSON.stringify(label)});button.scrollIntoView({block:'nearest'});button.click()})()`);
    assert.ok(await ui("[...document.querySelectorAll('.editor-context-menu:popover-open')].every(menu=>{const box=menu.getBoundingClientRect();return box.left>=7 && box.top>=7 && box.right<=innerWidth-7 && box.bottom<=innerHeight-7})"), `Root and ${label} submenu fit near the bottom-right viewport edge`);
    await nativeShortcut('Escape', [], false);
    await nativeShortcut('Escape', [], false);
  }
  await showContext('#source-editor');
  await browser.call('Input.dispatchMouseEvent', {type:'mousePressed',x:10,y:100,button:'left',buttons:1,clickCount:1}, sessionId);
  await browser.call('Input.dispatchMouseEvent', {type:'mouseReleased',x:10,y:100,button:'left',buttons:0,clickCount:1}, sessionId);
  assert.equal(await ui("document.querySelector('#editor-context-menu').matches(':popover-open')"), false, 'Outside click dismisses the menu');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  console.log('PASS: compact direct Source formatting and undo, real deletion, link dialog, native clipboard routing, Shift+F10, keyboard submenus, Escape focus, edge clamping, and outside dismissal');

  await action('new');
  await action('visual');
  await showContext();
  await main.evaluate("smokeClipboard = '**Pasted Markdown**\\n\\n- A list item'");
  await contextAction(['Edit', 'Copy / Paste As', 'Paste as Markdown']);
  assert.equal(await ui("document.querySelector('.tiptap strong').textContent"), 'Pasted Markdown');
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  await action('new');
  await action('source');
  await sourceEdit('Plain paragraph');
  await showContext('#source-editor');
  await contextAction(['Paragraph', 'Heading 1']);
  assert.match(await ui("document.querySelector('#source-editor').value"), /^# Plain paragraph/);
  await contextAction(['Paragraph', 'Paragraph']);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'Plain paragraph');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,5)");
  await main.evaluate("smokeClipboard = 'New'");
  await contextAction(['Edit', 'Copy / Paste As', 'Paste as Markdown']);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'New paragraph', 'Source paste replaces the selection');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,3)");
  await contextAction(['Insert', 'Footnote (Markdown)']);
  assert.match(await ui("document.querySelector('#source-editor').value"), /^New\[\^1\] paragraph/, 'Footnote insertion retains selected text');
  await contextAction(['Insert', 'Footnote (Markdown)']);
  assert.match(await ui("document.querySelector('#source-editor').value"), /\[\^1\]: Footnote text/);
  assert.match(await ui("document.querySelector('#source-editor').value"), /\[\^2\]: Footnote text/);
  await contextAction(['Insert', 'Link reference (Markdown)']);
  await contextAction(['Insert', 'Math block (Markdown)']);
  await contextAction(['Insert', 'YAML front matter (Markdown)']);
  const advanced = await ui("document.querySelector('#source-editor').value");
  assert.match(advanced, /^---\ntitle:/);
  assert.match(advanced, /\[link-1\]: https:\/\/example.com/);
  assert.match(advanced, /\$\$\nx\^2 \+ y\^2 = z\^2\n\$\$/);
  await contextAction(['Insert', 'YAML front matter (Markdown)']);
  assert.equal(await ui("document.querySelector('#source-editor').value"), advanced);
  assert.match(await ui("document.querySelector('#notification').textContent"), /already starts with/);
  console.log('PASS: source-mode menu headings and advanced inserts preserve Markdown, use unique references, and guard existing YAML');
  await sourceEdit('# Intro\n\n**Bold**\n\n## Next\n');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,0)");
  await showContext('#source-editor');
  await contextAction(['Insert', 'Structure', 'Table of contents']);
  assert.match(await ui("document.querySelector('#source-editor').value"), /\[Intro\]\(#intro\)/);
  await action('visual');
  assert.equal(await ui("document.querySelector('.tiptap h1').textContent"), 'Intro');
  await ui("document.querySelector('.tiptap a[href=\"#intro\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'contents navigation');
  assert.doesNotMatch(await ui("document.querySelector('#notification').textContent"), /That heading was not found/);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  console.log('PASS: Paste as Markdown renders formatted content, and generated table-of-contents links navigate to headings');

  await main.evaluate(`
    globalThis.smokeExternalURLs = [];
    globalThis.smokeExternalPrompts = [];
    globalThis.smokeMessageBox = smokeElectron.dialog.showMessageBox;
    smokeElectron.dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      if (options.message === 'Open this link in your default application?') smokeExternalPrompts.push(options.detail);
      return smokeMessageBox(...args);
    };
    smokeElectron.shell.openExternal = async url => { smokeExternalURLs.push(url); };
  `);
  const clickLink = async (selector = '.tiptap a', modifiers = 0) => {
    const point = await ui(`(() => {
      const link = document.querySelector(${JSON.stringify(selector)});
      link.scrollIntoView({block:'center'});
      const box = link.getBoundingClientRect();
      return {x:box.x + Math.min(box.width / 2, 15),y:box.y + box.height / 2};
    })()`);
    await browser.call('Input.dispatchMouseEvent', { type:'mousePressed', ...point, button:'left', buttons:1, clickCount:1, modifiers }, sessionId);
    await browser.call('Input.dispatchMouseEvent', { type:'mouseReleased', ...point, button:'left', buttons:0, clickCount:1, modifiers }, sessionId);
    if (!modifiers && !selector.includes('.document-preview')) {
      await waitFor(async () => ui("document.querySelector('#link-dialog').open"), 'clicked link editor');
    }
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'link click');
  };
  const linkField = id => ui(`document.querySelector('#link-${id}').value`);
  const submitLink = async (label, url, button = 'insert', expectError = false) => {
    await ui(`(() => {
      if (${label !== null}) document.querySelector('#link-label').value = ${JSON.stringify(label)};
      if (${url !== null}) document.querySelector('#link-url').value = ${JSON.stringify(url)};
      document.querySelector('#link-dialog form').requestSubmit(document.querySelector('#link-dialog button[value=${JSON.stringify(button)}]'));
    })()`);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'link submission');
    assert.equal(await ui("document.querySelector('#link-dialog').open"), expectError, await ui("document.querySelector('#link-error').textContent") || 'Successful link submission closes its dialog');
    if (expectError) assert.equal(await ui("document.querySelector('#link-error').hidden"), false);
  };
  await action('new');
  await action('source');
  await sourceEdit('Before [**Original** label](https://example.com/old) after.');
  await action('visual');
  const originalLinkHTML = await ui("document.querySelector('.tiptap').innerHTML");
  await clickLink('.tiptap a strong');
  assert.equal(await ui("document.querySelector('#link-dialog').open"), true);
  assert.equal(await ui("document.querySelector('#link-title').textContent"), 'Edit link');
  assert.equal(await linkField('label'), 'Original label', 'Clicking a formatted segment selects the complete link');
  assert.equal(await linkField('url'), 'https://example.com/old');
  assert.deepEqual(await main.evaluate('smokeExternalPrompts'), [], 'Plain click never requests external opening');
  await submitLink(null, null, 'cancel');
  assert.equal(await ui("document.querySelector('.tiptap').innerHTML"), originalLinkHTML, 'Cancel does not change content');
  await action('link');
  assert.equal(await linkField('url'), 'https://example.com/old', 'Toolbar edits the selected existing link');
  await ui(`(() => {
    const dialog = document.querySelector('#link-dialog');
    dialog.querySelector('button[value=cancel]').click();
    document.querySelector('[data-action=link]').click();
    dialog.dispatchEvent(new Event('close'));
  })()`);
  assert.equal(await ui("document.querySelector('#link-dialog').open"), true, 'An old close event cannot clear a newly reopened link editor');
  await submitLink(null, 'https://example.com/new');
  assert.equal(await ui("document.querySelector('.tiptap a').getAttribute('href')"), 'https://example.com/new');
  assert.equal(await ui("document.querySelector('.tiptap a strong').textContent"), 'Original', 'Address-only edits retain mixed label formatting');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('.tiptap').innerHTML"), originalLinkHTML, 'Address edit undoes in one step');
  await menuAction('redo');
  await nativeShortcut('k');
  await waitFor(async () => ui("document.querySelector('#link-dialog').open"), 'Ctrl+K edits existing link');
  assert.equal(await linkField('label'), 'Original label');
  await submitLink('Updated label', 'https://example.com/edited');
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), 'Before Updated label after.');
  assert.equal(await ui("document.querySelectorAll('.tiptap a').length"), 1, 'Editing replaces rather than duplicates the link');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('.tiptap a').textContent"), 'Original label', 'Text and address edit undoes together');
  assert.equal(await ui("document.querySelector('.tiptap a').getAttribute('href')"), 'https://example.com/new');
  await menuAction('redo');
  await showContext('.tiptap a');
  await contextAction(['Edit link...']);
  assert.equal(await linkField('label'), 'Updated label', 'Native right-click edits its target');
  await submitLink(null, 'javascript:alert(1)', 'insert', true);
  assert.equal(await ui("document.querySelector('#link-dialog').open"), true, 'Invalid address keeps the editor open');
  assert.match(await ui("document.querySelector('#link-error').textContent"), /http, https, mailto/);
  assert.equal(await ui("document.querySelector('.tiptap a').getAttribute('href')"), 'https://example.com/edited');
  await submitLink('Email us', 'mailto:writer@example.com');
  await main.evaluate('smokeChoice = 1');
  await clickLink('.tiptap a', 2);
  assert.equal(await ui("document.querySelector('#link-dialog').open"), false, 'Ctrl+click opens, not edits');
  assert.deepEqual(await main.evaluate('smokeExternalPrompts'), ['mailto:writer@example.com']);
  assert.deepEqual(await main.evaluate('smokeExternalURLs'), [], 'Canceling the confirmation does not launch another application');
  await main.evaluate('smokeChoice = 0');
  await clickLink('.tiptap a', 2);
  assert.deepEqual(await main.evaluate('smokeExternalURLs'), ['mailto:writer@example.com'], 'Ctrl+click opens via the confirmed main-process path');
  await clickLink();
  await submitLink(null, null, 'remove');
  assert.equal(await ui("document.querySelectorAll('.tiptap a').length"), 0);
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), 'Before Email us after.', 'Removing a link retains its text');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('.tiptap a').getAttribute('href')"), 'mailto:writer@example.com');
  await action('source');
  await sourceEdit('Before selected after.');
  await ui("document.querySelector('#source-editor').setSelectionRange(7,15)");
  await action('link');
  assert.equal(await linkField('label'), 'selected');
  await submitLink(null, 'https://example.com/a(b)');
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'Before [selected](https://example.com/a%28b%29) after.', 'Source insertion replaces its captured selection exactly once');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'Before selected after.');
  await sourceEdit('# Destination\n\nBefore [jump](#destination) after.');
  await action('visual');
  await clickLink();
  assert.equal(await linkField('url'), '#destination', 'Ordinary heading links can be edited');
  await ui("document.querySelector('#link-label').value='Jump now'; document.querySelector('#link-label').focus()");
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, sessionId);
  await waitFor(async () => ui("!document.querySelector('#link-dialog').open"), 'Enter saves rather than removes or cancels');
  assert.equal(await ui("document.querySelector('.tiptap a').textContent"), 'Jump now');
  const promptsBeforeAnchor = await main.evaluate('smokeExternalPrompts.length');
  await clickLink('.tiptap a', 2);
  assert.equal(await main.evaluate('smokeExternalPrompts.length'), promptsBeforeAnchor, 'Internal anchors navigate without an external-open request');
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  console.log('PASS: Visual link click/toolbar/Ctrl+K/context editing, whole-link replacement, formatting, undo/redo, validation, mailto, confirmed Ctrl+click, remove, and Source insertion');

  await action('new');
  await action('visual');
  await main.evaluate(`smokeClipboardImage = smokeElectron.nativeImage.createFromBuffer(Buffer.from(${JSON.stringify(testPNG(24,16).toString('base64'))}, 'base64'))`);
  await showContext();
  await contextAction(['Paste']);
  await waitFor(async () => ui("document.querySelector('.tiptap img')?.naturalWidth === 24"), 'right-click image paste');
  assert.ok(await ui("document.querySelector('.tiptap img').getAttribute('data-lekh-source').startsWith('data:image/png;base64,')"));
  await showContext('.tiptap img');
  await contextAction(['Copy image']);
  assert.deepEqual(await main.evaluate('smokeClipboardImage.getSize()'), { width: 24, height: 16 });
  await menuAction('insert:after');
  const imageCount = await ui("document.querySelectorAll('.tiptap img').length");
  await main.evaluate('smokeImageReads = 0');
  await nativeShortcut('V');
  await waitFor(async () => ui(`document.querySelectorAll('.tiptap img').length === ${imageCount + 1} && document.querySelector('#app').getAttribute('aria-busy') === 'false'`), 'Ctrl+V image paste').catch(async error => {
    console.error('Clipboard reads:', await main.evaluate('smokeImageReads'));
    console.error(await ui("JSON.stringify({activeTag:document.activeElement?.tagName,busy:document.querySelector('#app').getAttribute('aria-busy'),images:document.querySelectorAll('.tiptap img').length})"));
    throw error;
  });
  assert.ok(await main.evaluate('smokeImageReads') >= 2, 'Editor Ctrl+V uses the native image clipboard path');
  const clipboardFile = path.join(temporary, 'clipboard-images.md');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(clipboardFile)}`);
  await action('save');
  assert.match(await readFile(clipboardFile, 'utf8'), /data:image\/png;base64,/);
  for (const format of ['pdf', 'docx']) {
    const file = path.join(temporary, `clipboard-images.${format}`);
    await main.evaluate(`smokeSavePath = ${JSON.stringify(file)}`);
    await menuAction(`export-${format}`);
    const data = await readFile(file);
    assert.ok(data.length > 1000);
    if (format === 'pdf') assert.match(data.toString('latin1'), /\/Subtype\s*\/Image\b/);
    else assert.equal(data.subarray(0,2).toString(), 'PK');
  }
  await menuAction('close-tab');
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(clipboardFile)}`);
  await action('open');
  await waitFor(async () => ui("document.querySelector('.tiptap img')?.naturalWidth === 24"), 'saved pasted image reopens');
  await menuAction('close-tab');
  await action('new');
  await action('source');
  await showContext('#source-editor');
  await contextAction(['Edit', 'Copy / Paste As', 'Paste image']);
  assert.match(await ui("document.querySelector('#source-editor').value"), /!\[Image\]\(data:image\/png;base64,/);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  await action('new');
  await action('visual');
  await ui(`(() => {
    const data = Uint8Array.from(atob(${JSON.stringify(testPNG(12,8).toString('base64'))}), c => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], 'clipboard.png', {type:'image/png'}));
    document.querySelector('.tiptap').dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  await waitFor(async () => ui("document.querySelector('.tiptap img')?.naturalWidth === 12 && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'clipboard image-file paste event');
  await main.evaluate(`(() => {
    smokeClipboardImage = smokeElectron.nativeImage.createEmpty();
    globalThis.smokeNativePasteCalls = 0;
    const contents = smokeElectron.BrowserWindow.getAllWindows()[0].webContents;
    globalThis.smokeOriginalPaste = contents.paste;
    contents.paste = () => { smokeNativePasteCalls++; };
  })()`);
  await nativeShortcut('V');
  await waitFor(async () => main.evaluate('smokeNativePasteCalls === 1'), 'native rich-text paste fallback');
  await action('source');
  await nativeShortcut('V');
  await waitFor(async () => main.evaluate('smokeNativePasteCalls === 2'), 'native source paste fallback');
  await action('visual');
  await main.evaluate('smokeElectron.BrowserWindow.getAllWindows()[0].webContents.paste = smokeOriginalPaste');
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  console.log('PASS: image clipboard copy/paste, native Paste and source embedding, save/reopen, Word/PDF export, and image-file paste events');

  const codeBodies = [
    '$vmName = "demo"\n\n  # Keep indentation\nGet-AzVM -Name $vmName',
    '{\n  "enabled": true,\n  "count": 42\n}',
    'const leavePlain = 42;',
    '<script>window.__codeDidRun = true</script>\n  custom text',
  ];
  const languageFixture = '# Code language test\n\n' + codeBodies.map((body, index) =>
    `\`\`\`${['powershell', 'json', '', 'my-custom-language'][index]}\n${body}\n\`\`\``).join('\n\n');
  await action('new');
  await action('source');
  await sourceEdit(languageFixture);
  await action('visual');
  const codeText = () => ui("Array.from(document.querySelectorAll('.code-block pre code'), code => code.textContent)");
  assert.deepEqual(await codeText(), codeBodies);
  assert.equal(await ui("document.querySelectorAll('.code-block').length"), 4);
  assert.ok(await ui("document.querySelector('.code-block .hljs-variable') !== null"));
  assert.equal(await ui("document.querySelectorAll('.code-block')[2].querySelectorAll('[class*=hljs-]').length"), 0);
  assert.equal(await ui("document.querySelectorAll('.code-block')[3].querySelectorAll('[class*=hljs-]').length"), 0);
  assert.equal(await ui("typeof window.__codeDidRun"), 'undefined');
  await menuAction('focus');
  await ui("document.querySelector('.code-language').click()");
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27}, sessionId);
  assert.equal(await ui("document.querySelectorAll('.code-language-picker:popover-open').length"), 0);
  assert.equal(await ui("document.body.classList.contains('focus-mode')"), true, 'Closing a language picker does not leave Focus mode');
  await menuAction('focus');
  const chooseCodeLanguage = async (block, query, id) => {
    await ui(`document.querySelectorAll('.code-language')[${block}].click()`);
    await ui(`(() => {const search=document.querySelector('.code-language-picker:popover-open input');search.value=${JSON.stringify(query)};search.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await ui(`document.querySelector('.code-language-picker:popover-open [data-language=${JSON.stringify(id)}]').click()`);
  };
  await chooseCodeLanguage(0, 'javascript', 'javascript');
  assert.match(await ui("document.querySelector('.code-language').textContent"), /JavaScript/);
  assert.deepEqual(await codeText(), codeBodies);
  await menuAction('undo');
  assert.match(await ui("document.querySelector('.code-language').textContent"), /PowerShell/);
  await menuAction('redo');
  assert.match(await ui("document.querySelector('.code-language').textContent"), /JavaScript/);
  await ui("document.querySelector('.code-language').click(); const search=document.querySelector('.code-language-picker:popover-open input');search.value='ps1';search.dispatchEvent(new Event('input',{bubbles:true}));search.focus()");
  assert.equal(await ui("document.querySelectorAll('.code-language-picker:popover-open [role=option]').length"), 1);
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, sessionId);
  assert.match(await ui("document.querySelector('.code-language').textContent"), /PowerShell/);
  assert.deepEqual(await codeText(), codeBodies);
  await chooseCodeLanguage(1, 'plain', 'plaintext');
  assert.equal(await ui("document.querySelectorAll('.code-block')[1].querySelectorAll('[class*=hljs-]').length"), 0);
  await menuAction('theme:light');
  assert.equal(await ui("getComputedStyle(document.querySelector('.code-block .hljs-variable')).color"), 'rgb(5, 80, 174)');
  await menuAction('theme:dark');
  assert.equal(await ui("getComputedStyle(document.querySelector('.code-block .hljs-variable')).color"), 'rgb(121, 192, 255)');
  await ui(`(() => {
    const code=document.querySelector('.code-block pre code');
    const range=document.createRange();range.selectNodeContents(code);range.collapse(false);
    code.closest('.tiptap').focus();getSelection().removeAllRanges();getSelection().addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  })()`);
  await delay(80);
  await browser.call('Input.insertText', {text:'\n# Edited in Visual mode'}, sessionId);
  codeBodies[0] += '\n# Edited in Visual mode';
  assert.deepEqual(await codeText(), codeBodies);
  await ui("document.querySelector('.copy-code').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'copy raw code');
  assert.equal(await main.evaluate('smokeClipboard'), codeBodies[0]);
  const codeFile = path.join(temporary, 'code-languages.md');
  await main.evaluate(`smokeSavePath = ${JSON.stringify(codeFile)}`);
  await action('save');
  const savedCode = await readFile(codeFile, 'utf8');
  assert.match(savedCode, /```powershell/);
  assert.match(savedCode, /```my-custom-language/);
  assert.doesNotMatch(savedCode, /```json|Search languages|copy-code|code-language-picker/);
  for (const body of codeBodies) assert.ok(savedCode.includes(body), 'Code text is preserved in Markdown');
  await action('source');
  assert.equal(await ui("document.querySelector('#source-editor').value"), savedCode);
  await action('visual');
  assert.deepEqual(await codeText(), codeBodies);
  await action('new');
  await menuAction('previous-tab');
  assert.deepEqual(await codeText(), codeBodies);
  await menuAction('next-tab');
  await menuAction('close-tab');
  for (const format of ['pdf', 'docx']) {
    const output = path.join(temporary, `code-languages.${format}`);
    await main.evaluate(`smokeSavePath = ${JSON.stringify(output)}`);
    await menuAction(`export-${format}`);
    const bytes = await readFile(output);
    assert.ok(bytes.length > 1000);
    assert.equal(bytes.subarray(0, format === 'pdf' ? 5 : 2).toString(), format === 'pdf' ? '%PDF-' : 'PK');
  }
  if (process.env.LEKH_SCREENSHOT) {
    await ui("document.querySelector('.code-language').click()");
    const screenshot = await browser.call('Page.captureScreenshot', { format:'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'code-language-picker.png'), Buffer.from(screenshot.data, 'base64'));
    await ui("document.querySelector('.code-language-picker:popover-open').hidePopover()");
  }
  await menuAction('close-tab');
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(codeFile)}`);
  await action('open');
  assert.deepEqual(await codeText(), codeBodies);
  assert.match(await ui("document.querySelector('.code-language').textContent"), /PowerShell/);
  await menuAction('close-tab');
  console.log('PASS: searchable code languages, alias/keyboard selection, per-block colors, undo/redo, raw copy, real visual editing, safe unknown/plain fences, mode/tab isolation, save/reopen and native PDF/Word exports');

  const recentFixtures = Array.from({length:7}, (_, index) => path.join(temporary, `Recent ${index}.md`));
  for (const [index, fixture] of recentFixtures.entries()) {
    await writeFile(fixture, `# Recent fixture ${index}\n`);
    await main.evaluate(`smokeOpenPath = ${JSON.stringify(fixture)}`);
    await action('open');
    await menuAction('close-tab');
  }
  const expectedRecent = recentFixtures.slice(-5).reverse();
  assert.deepEqual(await ui("[...document.querySelectorAll('#recent button')].map(button => button.title)"), expectedRecent);
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(expectedRecent[3])}`);
  await action('open');
  await menuAction('close-tab');
  const reorderedRecent = [expectedRecent[3], ...expectedRecent.filter(file => file !== expectedRecent[3])];
  assert.deepEqual(await ui("[...document.querySelectorAll('#recent button')].map(button => button.title)"), reorderedRecent, 'Reopening moves an existing file to the front without duplicates');
  const historyPath = path.join(temporary, 'profile', 'recent-files.json');
  assert.deepEqual(JSON.parse(await readFile(historyPath, 'utf8')), reorderedRecent, 'The same five-file order is persisted');
  const historyBackup = path.join(temporary, 'profile', 'recent-files.backup');
  const recentCount = await ui("document.querySelectorAll('#recent button').length");
  assert.equal(recentCount, 5);
  assert.equal(await ui("document.querySelector('#recent').hidden"), true, 'Recent Files starts collapsed');
  assert.equal(await ui("document.querySelector('#recent-toggle').getAttribute('aria-expanded')"), 'false');
  assert.equal(await ui("document.querySelector('#recent-count').textContent"), `(${recentCount})`);
  const collapsedOutlineHeight = await ui("document.querySelector('#outline').getBoundingClientRect().height");
  await ui("document.querySelector('#recent-toggle').click()");
  assert.equal(await ui("document.querySelector('#recent').hidden"), false);
  assert.equal(await ui("localStorage.getItem('lekh-recent-expanded')"), 'true');
  assert.ok(await ui("document.querySelector('#outline').getBoundingClientRect().height") < collapsedOutlineHeight, 'Collapsing history gives space back to the outline');
  assert.equal(await ui("getComputedStyle(document.querySelector('#recent')).overflowY"), 'auto');
  assert.ok(await ui("document.querySelector('#recent').getBoundingClientRect().height") <= 180);
  assert.equal(await ui("document.querySelector('#clear-recent').hidden"), false);
  await rename(historyPath, historyBackup);
  await mkdir(historyPath);
  await action('clear-recent');
  assert.equal(await ui("document.querySelector('#notification').classList.contains('error')"), true);
  assert.equal(await ui("document.querySelectorAll('#recent button').length"), recentCount);
  assert.equal(await ui("window.lekh.recent().then(result => result.value.length)"), recentCount);
  await rmdir(historyPath);
  await rename(historyBackup, historyPath);
  const beforeClear = await ui("JSON.stringify({tabs:Array.from(document.querySelectorAll('.document-tab'), tab => tab.dataset.documentId),active:document.querySelector('.document-tab.selected').dataset.documentId,text:document.querySelector('.tiptap').textContent})");
  const documentBeforeClear = await readFile(copied, 'utf8');
  await action('clear-recent');
  assert.equal(await ui("document.querySelectorAll('#recent button').length"), 0);
  assert.equal(await ui("document.querySelector('#clear-recent').disabled"), true);
  assert.deepEqual(JSON.parse(await readFile(historyPath, 'utf8')), []);
  assert.equal(await ui("JSON.stringify({tabs:Array.from(document.querySelectorAll('.document-tab'), tab => tab.dataset.documentId),active:document.querySelector('.document-tab.selected').dataset.documentId,text:document.querySelector('.tiptap').textContent})"), beforeClear);
  assert.equal(await readFile(copied, 'utf8'), documentBeforeClear);
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(copied)}`);
  await action('open');
  assert.ok(await ui("document.querySelectorAll('#recent button').length") > 0);
  await menuAction('close-tab');
  await menuAction('clear-recent');
  console.log('PASS: clear recent history persists, preserves documents/tabs, repopulates on open, and reports write failures without clearing memory or UI');

  await ui("localStorage.setItem('lekh-theme', 'invalid-theme'); window.addEventListener('beforeunload', () => localStorage.setItem('lekh-draft-v1', JSON.stringify({content:'# Single draft recovery',name:'single-draft.md'})), {once:true})");
  await browser.call('Page.reload', {}, sessionId);
  await waitForReload(async () => ui("document.querySelector('#recovery-banner') && !document.querySelector('#recovery-banner').hidden && document.querySelector('#app')?.getAttribute('aria-busy') === 'false'"), 'single draft recovery banner');
  assert.equal(await ui("document.documentElement.dataset.theme"), 'light');
  assert.equal(await ui("document.querySelector('#theme-toggle span').textContent"), 'Light');
  assert.equal(await ui("document.querySelector('#recent-toggle').getAttribute('aria-expanded')"), 'true', 'Recent Files preference survives reload');
  await ui("document.querySelector('#recent-toggle').click()");
  assert.equal(await ui("localStorage.getItem('lekh-recent-expanded')"), 'false');
  assert.equal(await ui("localStorage.getItem('lekh-theme')"), 'light');
  assert.equal(await brandSource(), lightBrandIcon, 'An invalid stored theme restores the default light theme and icon');
  assert.equal(await ui("document.querySelectorAll('#recent button').length"), 0);
  await action('recover');
  assert.equal(await ui("document.querySelector('.tiptap h1').textContent"), 'Single draft recovery');
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  console.log('PASS: single-document recovery, invalid-theme fallback, and cleared recent history survive reload');

  const splitPaths = [];
  const splitIds = [];
  for (const [index, name] of ['left', 'right', 'third', 'fourth'].entries()) {
    const folder = path.join(temporary, `split-${name}`);
    await mkdir(folder);
    await writeFile(path.join(folder, 'asset.png'), testPNG(index + 2, 1));
    const file = path.join(folder, `${name}.md`);
    const body = `# Split ${name}\n\n${name} original paragraph.\n\n![Relative](asset.png)\n\n${Array.from({length:45}, (_, line) => `${name} paragraph ${line}: independently scrollable document content.`).join('\n\n')}\n`;
    await writeFile(file, body);
    splitPaths.push(file);
    await main.evaluate(`smokeOpenPath = ${JSON.stringify(file)}`);
    await action('open');
    splitIds.push(await activeTab());
  }
  assert.equal(await tabCount(), 5);
  const originalSplitOrder = await ui("Array.from(document.querySelectorAll('.document-tab'), tab => tab.dataset.documentId)");
  const pane = id => `.document-pane[data-document-id="${id}"]`;
  const paneSource = async id => ui(`document.querySelector(${JSON.stringify(pane(id) + ' .document-source')}).value`);
  const paneMode = async (id, mode) => {
    await ui(`(() => {const pane=document.querySelector(${JSON.stringify(pane(id))});(pane.querySelector('.document-source:not([hidden])') ?? pane.querySelector('.tiptap')).focus()})()`);
    await action(mode);
  };
  const confirmSplit = async (right, keyboard = false) => {
    const selector = `#split-documents button[data-document-id="${right}"]`;
    if (keyboard) {
      await ui(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      assert.equal(await ui(`document.activeElement.matches(${JSON.stringify(selector)})`), true);
      await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'}, sessionId);
      await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13}, sessionId);
    } else await ui(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await waitFor(async () => ui("!document.querySelector('#split-dialog').open && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'create split pair');
  };
  await selectTab(splitIds[0]);
  await action('split');
  assert.equal(await ui("document.querySelector('#split-dialog').open"), true);
  assert.equal(await ui("document.querySelectorAll('#split-documents .split-card').length"), 4);
  assert.equal(await ui(`Boolean(document.querySelector('#split-documents [data-document-id="${splitIds[0]}"]'))`), false, 'The current file is not offered');
  assert.match(await ui(`document.querySelector('#split-documents [data-document-id="${splitIds[1]}"] .split-preview').textContent`), /Split right/);
  await waitFor(async () => ui("Array.from(document.querySelectorAll('#split-documents img')).every(image => image.complete && image.naturalWidth > 0)"), 'thumbnail local images');
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('#split-documents img'), image => image.naturalWidth)"), [3,4,5]);
  assert.equal(await activeTab(), splitIds[0], 'Opening previews does not switch the active document');
  if (process.env.LEKH_SCREENSHOT) {
    const screenshot = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'split-preview-picker.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await ui("document.querySelector('#split-cancel').click()");
  assert.equal(await tabCount(), 5);
  await waitFor(async () => ui("!document.querySelector('#split-dialog').open && document.querySelectorAll('#split-documents .split-card').length === 0"), 'closing releases preview contents');
  await selectTab(splitIds[1]);
  await action('source');
  const previewOriginal = await ui("document.querySelector('#source-editor').value");
  await sourceEdit(previewOriginal.replace('right original paragraph.', '**Current unsaved preview.**'));
  await selectTab(splitIds[0]);
  await action('split');
  assert.match(await ui(`document.querySelector('#split-documents [data-document-id="${splitIds[1]}"] .split-preview strong').textContent`), /Current unsaved preview/);
  assert.match(await ui(`document.querySelector('#split-documents [data-document-id="${splitIds[1]}"]').getAttribute('aria-label')`), /unsaved changes/);
  await ui("document.querySelector('#split-cancel').click()");
  await selectTab(splitIds[1]);
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), previewOriginal, 'Previewing preserves source undo history');
  await action('visual');
  await selectTab(splitIds[0]);
  await action('split');
  await confirmSplit(splitIds[1]);
  assert.equal(await tabCount(), 4);
  assert.equal(await ui("document.querySelectorAll('.document-tab[data-paired=true]').length"), 1);
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 2);
  await selectTab(splitIds[2]);
  await action('split');
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('#split-documents .split-card'), card => card.dataset.documentId)"), [originalSplitOrder[0], splitIds[3]], 'Already-paired files and the current file are excluded');
  await nativeShortcut('Escape', [], false);
  await waitFor(async () => ui("!document.querySelector('#split-dialog').open"), 'Escape cancels the preview picker');
  assert.equal(await tabCount(), 4);
  await selectTab(splitIds[0]);
  assert.equal(await ui("document.querySelector('.global-modes').hidden"), false, 'Paired files retain the shared view controls');
  assert.equal(await ui("document.querySelectorAll('.global-modes button').length"), 3, 'One shared set of editing view controls applies to the active file');
  assert.equal(await ui("document.querySelectorAll('.pane-header button').length"), 0, 'Pane headers do not duplicate view controls');
  if (process.env.LEKH_SCREENSHOT) {
    const screenshot = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'responsive-split.png'), Buffer.from(screenshot.data, 'base64'));
  }
  assert.match(await ui("document.querySelector('.paired-tab .tab-select').textContent"), /left\.md.*right\.md/);
  await waitFor(async () => ui("Array.from(document.querySelectorAll('.document-pane .tiptap img')).every(image => image.complete && image.naturalWidth > 0)"), 'both split local images');
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('.document-pane .tiptap img'), image => image.naturalWidth)"), [2,3]);
  const visualAppend = async (id, text) => {
    await ui(`(() => {
      const editor=document.querySelector(${JSON.stringify(pane(id) + ' .tiptap')});
      editor.focus();
      const range=document.createRange();
      range.selectNodeContents(editor.querySelector('p'));
      range.collapse(false);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    })()`);
    await browser.call('Input.insertText', {text}, sessionId);
  };
  const beforePairedDual = await Promise.all(splitIds.slice(0, 2).map(paneSource));
  for (const id of splitIds.slice(0, 2)) {
    await ui(`document.querySelector(${JSON.stringify(pane(id) + ' .tiptap')}).focus()`);
    assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'false', 'Controls reflect the newly active pane');
    await action('edit-split');
    assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'true');
    assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(id) + ' .pane-content')}).classList.contains('side-by-side')`), true);
  }
  await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')}).focus()`);
  await sourceEdit(beforePairedDual[1] + '\nOnly the right dual view changes.');
  assert.match(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .tiptap')}).textContent`), /Only the right dual view changes/);
  assert.equal(await paneSource(splitIds[0]), beforePairedDual[0]);
  await menuAction('undo');
  assert.equal(await paneSource(splitIds[1]), beforePairedDual[1]);
  await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .document-source')}).focus()`);
  await sourceEdit(beforePairedDual[0] + '\nOnly the left dual view changes.');
  assert.equal(await paneSource(splitIds[1]), beforePairedDual[1]);
  await menuAction('undo');
  assert.equal(await paneSource(splitIds[0]), beforePairedDual[0]);
  await ui(`(() => {const source=document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')});source.focus();const caret=source.value.indexOf('right original paragraph.')+5;source.setSelectionRange(caret,caret)})()`);
  await clickMermaid();
  assert.equal(await ui("document.querySelector('#view-split').getAttribute('aria-pressed')"), 'true', 'Source-side Mermaid insertion preserves editable dual view');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .pane-content')}).classList.contains('side-by-side')`), true);
  const dualDiagramSource = await paneSource(splitIds[1]);
  assert.ok(dualDiagramSource.indexOf('```mermaid') < dualDiagramSource.indexOf(' original paragraph.'));
  assert.equal(await paneSource(splitIds[0]), beforePairedDual[0], 'Source-side diagram insertion leaves the other split document unchanged');
  await menuAction('undo');
  assert.equal(await paneSource(splitIds[1]), beforePairedDual[1], 'Source-side Mermaid insertion is undoable without leaving dual view');
  await paneMode(splitIds[1], 'preview');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .pane-content')}).classList.contains('side-by-side')`), false, 'Reader Preview replaces the active editing layout');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .pane-content')}).classList.contains('side-by-side')`), true, 'Other paired file keeps its editable dual view');
  await action('preview');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .pane-content')}).classList.contains('side-by-side')`), true, 'Back to editing restores Split for the active file');
  await paneMode(splitIds[1], 'visual');
  await paneMode(splitIds[0], 'visual');
  const leftBeforeDiagram = await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .tiptap')}).innerHTML`);
  await ui(`(() => {const editor=document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .tiptap')});editor.focus();const range=document.createRange();range.setStart(editor.querySelector('p').firstChild,5);range.collapse(true);window.getSelection().removeAllRanges();window.getSelection().addRange(range)})()`);
  await clickMermaid();
  await waitFor(async () => ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .mermaid-preview img')})?.naturalWidth > 0`), 'split Mermaid renders in active pane');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .tiptap')}).innerHTML`), leftBeforeDiagram, 'Mermaid insertion leaves the inactive document unchanged');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .code-block')}).previousElementSibling.textContent`), 'right');
  await menuAction('undo');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .code-block')})`), null);
  console.log('PASS: both files can independently use editable dual view, Source/Visual updates and undo stay scoped, and legacy Preview disables only its own dual view');
  const leftBeforeContext = await paneSource(splitIds[0]);
  await showContext(pane(splitIds[1]) + ' .tiptap p');
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'right.md', 'Right-click activates the clicked split pane');
  await contextAction(['Paragraph', 'Heading 2']);
  assert.ok(await ui(`Boolean(document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .tiptap h2')}))`));
  assert.equal(await paneSource(splitIds[0]), leftBeforeContext, 'Compact Visual menu leaves the other document unchanged');
  await menuAction('undo');
  await visualAppend(splitIds[1], ' RIGHT EDIT');
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'right.md');
  await menuAction('undo');
  assert.doesNotMatch(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .tiptap')}).textContent`), /RIGHT EDIT/);
  await menuAction('redo');
  await visualAppend(splitIds[0], ' LEFT EDIT');
  await menuAction('undo');
  assert.match(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .tiptap')}).textContent`), /RIGHT EDIT/);
  await menuAction('redo');
  await paneMode(splitIds[1], 'source');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .paper')}).hidden`), false);
  const rightBeforeSource = await paneSource(splitIds[1]);
  await sourceEdit(rightBeforeSource + '\nRight source edit.');
  await menuAction('undo');
  assert.equal(await paneSource(splitIds[1]), rightBeforeSource);
  await menuAction('redo');
  const rightBeforeContext = await paneSource(splitIds[1]);
  const leftBeforeSourceContext = await paneSource(splitIds[0]);
  await ui(`(() => {const source=document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')});source.focus();source.setSelectionRange(2,7)})()`);
  await nativeShortcut('F10', ['shift'], false);
  await waitFor(async () => ui("document.querySelector('#editor-context-menu').matches(':popover-open')"), 'Source split context menu preserves its keyboard selection');
  await contextAction(['Bold']);
  assert.equal(await paneSource(splitIds[1]), rightBeforeContext.slice(0,2) + '**' + rightBeforeContext.slice(2,7) + '**' + rightBeforeContext.slice(7));
  assert.equal(await paneSource(splitIds[0]), leftBeforeSourceContext, 'Compact Source menu leaves the other document unchanged');
  await menuAction('undo');
  assert.equal(await paneSource(splitIds[1]), rightBeforeContext);
  await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .tiptap')}).focus()`);
  await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .pane-content')}).scrollTop=220; const otherSource=document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')}); otherSource.setSelectionRange(7,12); otherSource.scrollTop=140`);
  await ui("document.querySelector('.split-divider').focus()");
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39}, sessionId);
  assert.equal(await ui("document.querySelector('.split-divider').getAttribute('aria-valuenow')"), '55');
  const drag = await ui("(() => {const root=document.querySelector('#canvas').getBoundingClientRect();const divider=document.querySelector('.split-divider').getBoundingClientRect();return {x:divider.x+divider.width/2,y:divider.y+divider.height/2,end:root.x+root.width*.62};})()");
  await browser.call('Input.dispatchMouseEvent', {type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1}, sessionId);
  await browser.call('Input.dispatchMouseEvent', {type:'mouseMoved',x:drag.end,y:drag.y,button:'left',buttons:1}, sessionId);
  await browser.call('Input.dispatchMouseEvent', {type:'mouseReleased',x:drag.end,y:drag.y,button:'left',buttons:0,clickCount:1}, sessionId);
  assert.equal(await ui("document.querySelector('.split-divider').getAttribute('aria-valuenow')"), '62');
  const scrollBefore = await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .pane-content')}).scrollTop`);
  const rightScrollBefore = await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')}).scrollTop`);
  await selectTab(splitIds[2]);
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 1);
  assert.equal(await ui("document.querySelector('.global-modes').hidden"), false);
  assert.equal(await ui("document.querySelector('#canvas').classList.contains('is-split')"), false);
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'third.md');
  await selectTab(splitIds[0]);
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 2);
  assert.equal(await ui("document.querySelector('.split-divider').getAttribute('aria-valuenow')"), '62');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[0]) + ' .pane-content')}).scrollTop`), scrollBefore);
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')}).scrollTop`), rightScrollBefore);
  assert.deepEqual(await ui(`(() => {const source=document.querySelector(${JSON.stringify(pane(splitIds[1]) + ' .document-source')});return [source.selectionStart,source.selectionEnd];})()`), [7,12]);
  await menuAction('next-tab');
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'third.md');
  await menuAction('previous-tab');
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 2);
  await main.evaluate(`smokeOpenPath = ${JSON.stringify(splitPaths[1])}`);
  await action('open');
  assert.equal(await tabCount(), 4);
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'right.md');
  assert.equal(await ui("document.querySelector('#source-editor').hidden"), false);
  await action('save');
  assert.match(await readFile(splitPaths[1], 'utf8'), /RIGHT EDIT[\s\S]*Right source edit/);
  assert.doesNotMatch(await readFile(splitPaths[1], 'utf8'), /LEFT EDIT/);
  await action('save-all');
  assert.match(await readFile(splitPaths[0], 'utf8'), /LEFT EDIT/);
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'right.md');
  for (const format of ['pdf', 'docx']) {
    const output = path.join(temporary, `split-active-right.${format}`);
    await main.evaluate(`smokeSavePath = ${JSON.stringify(output)}`);
    await menuAction(`export-${format}`);
    assert.ok((await readFile(output)).length > 1000, 'Active-pane exports include its scoped local image');
  }
  await menuAction('focus');
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 2);
  await menuAction('focus');
  if (process.env.LEKH_SCREENSHOT) {
    const screenshot = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'paired-split-desktop.png'), Buffer.from(screenshot.data,'base64'));
  }
  await menuAction('unsplit');
  assert.equal(await tabCount(), 5);
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('.document-tab'), tab => tab.dataset.documentId)"), originalSplitOrder);
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 1);
  console.log('PASS: thumbnail cards show live edits and scoped images, exclude current/paired files, preserve undo on Cancel/Escape, and create split pairs; both editable views, independent modes/undo/selection/scroll, keyboard/pointer resizing, normal-tab switching, group navigation, Save All, active-pane exports, and lossless unsplit');

  await selectTab(splitIds[0]);
  const tabPoint = await ui("(() => {const tab=document.querySelector('.document-tab.selected .tab-select').getBoundingClientRect();return {x:tab.x+15,y:tab.y+15};})()");
  await browser.call('Input.dispatchMouseEvent', {type:'mousePressed',...tabPoint,button:'right',buttons:2,clickCount:1}, sessionId);
  await browser.call('Input.dispatchMouseEvent', {type:'mouseReleased',...tabPoint,button:'right',buttons:0,clickCount:1}, sessionId);
  await waitFor(async () => ui("document.querySelector('#tab-context-menu').matches(':popover-open')"), 'actual tab right-click menu');
  await ui("document.querySelector('#tab-context-menu button').click()");
  await confirmSplit(splitIds[1], true);
  await paneMode(splitIds[0], 'source');
  await sourceEdit((await paneSource(splitIds[0])) + '\nPending left.');
  await paneMode(splitIds[1], 'source');
  await sourceEdit((await paneSource(splitIds[1])) + '\nPending right.');
  try {
    await waitFor(async () => ui(`(() => {
      const {documents = []} = JSON.parse(localStorage.getItem('lekh-draft-v1') || '{}');
      return documents.some(draft => draft.name === 'left.md' && draft.content.includes('Pending left.')) &&
        documents.some(draft => draft.name === 'right.md' && draft.content.includes('Pending right.'));
    })()`), 'recovery stores both dirty split files');
  } catch (error) {
    const snapshot = await ui(`({
      drafts: JSON.parse(localStorage.getItem('lekh-draft-v1') || '{}'),
      panes: [...document.querySelectorAll('.document-pane')].map(pane => ({
        id: pane.dataset.documentId, source: pane.querySelector('.document-source')?.value.slice(-100)
      })),
      notice: document.querySelector('#notification').textContent
    })`);
    throw new Error(`Split recovery did not retain both expected edits: ${JSON.stringify(snapshot)}`, { cause: error });
  }
  await main.evaluate('smokeChoices=[1,2]; smokeChoice=2');
  await ui("document.querySelector('.paired-tab .tab-close').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'cancel closing paired files');
  assert.equal(await tabCount(), 4);
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 2);
  assert.match(await paneSource(splitIds[0]), /Pending left/);
  assert.match(await paneSource(splitIds[1]), /Pending right/);
  await main.evaluate('smokeChoice=2');
  await menuAction('close-tab');
  assert.equal(await ui("document.querySelectorAll('#canvas > .document-pane').length"), 2);
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  assert.equal(await ui("document.querySelectorAll('.paired-tab').length"), 0);
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'left.md');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Pending left/);
  await menuAction('close-tab');
  await selectTab(splitIds[2]);
  await menuAction('close-tab');
  await selectTab(splitIds[3]);
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  for (const file of splitPaths.slice(0,2)) {
    await main.evaluate(`smokeOpenPath=${JSON.stringify(file)}`);
    await action('open');
  }
  const rightReopened = await activeTab();
  await menuAction('previous-tab');
  await action('split');
  await confirmSplit(rightReopened);
  await main.evaluate('smokeChoices=[]; smokeChoice=1');
  await ui("document.querySelector('.paired-tab .tab-close').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'close both paired files');
  assert.equal(await tabCount(), 1);
  console.log('PASS: actual tab context-menu pairing, both-side draft recovery, atomic Cancel after Discard, active-side Ctrl+W behavior, surviving partner, and closing a whole pair without closing unrelated files');

  await action('new');
  await action('source');
  const formattingKeys = [
    ['B', ['control'], '**Shortcut text**'],
    ['I', ['control'], '*Shortcut text*'],
    ['X', ['control', 'shift'], '~~Shortcut text~~'],
    ['E', ['control'], '`Shortcut text`'],
    ['8', ['control', 'shift'], '\n- Shortcut text'],
    ['7', ['control', 'shift'], '\n1. Shortcut text'],
    ['9', ['control', 'shift'], '\n- [ ] Shortcut text'],
    ['Q', ['control', 'shift'], '\n> Shortcut text'],
  ];
  for (const [key, modifiers, expected] of formattingKeys) {
    await sourceEdit('Shortcut text');
    await ui("document.querySelector('#source-editor').setSelectionRange(0,13)");
    await nativeShortcut(key, modifiers);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), `formatting shortcut ${key}`);
    assert.equal(await ui("document.querySelector('#source-editor').value"), expected, `Native ${modifiers.join('+')}+${key} formats Source exactly once`);
  }
  for (const [key, tag] of [['B', 'strong'], ['I', 'em']]) {
    await sourceEdit('Shortcut text');
    await action('visual');
    await nativeShortcut('A');
    await waitFor(async () => ui("getSelection()?.toString() === 'Shortcut text'"), 'native Visual selection');
    await nativeShortcut(key);
    await waitFor(async () => ui(`Boolean(document.querySelector('#visual-editor ${tag}'))`), `native Visual ${key}`);
    assert.equal(await ui(`document.querySelector('#visual-editor ${tag}').textContent`), 'Shortcut text');
    await action('source');
  }
  await sourceEdit('Protected document');
  await action('find');
  await ui("document.querySelector('#find-text').focus()");
  await nativeShortcut('B', ['control'], false);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'Protected document', 'Formatting does not edit the document from Find');
  await action('find-close');
  await action('link');
  await ui("document.querySelector('#link-url').focus()");
  await nativeShortcut('I', ['control'], false);
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'Protected document', 'Formatting does not edit the document from dialogs');
  await ui("document.querySelector('#link-dialog').close('cancel')");
  await sourceEdit('```python\nprint("Guarded code")\n```');
  await action('visual');
  await ui("document.querySelector('#visual-editor .code-language').click(); document.querySelector('.code-language-picker input').focus()");
  await nativeShortcut('B', ['control'], false);
  assert.equal(await ui("document.querySelector('#visual-editor pre code').textContent"), 'print("Guarded code")', 'Language search never formats document content');
  await ui("document.querySelector('.code-language-picker:popover-open').hidePopover()");
  await nativeShortcut('F1', []);
  await waitFor(async () => ui("document.querySelector('#shortcuts-dialog').open"), 'F1 keyboard reference');
  assert.match(await ui("document.querySelector('#shortcuts-dialog').textContent"), /Save all files.*Ctrl\+Alt\+S/s);
  await ui("document.querySelector('#shortcuts-dialog').close()");
  assert.match(await ui("document.querySelector('[data-command=bold]').title"), /Ctrl\+B/);
  assert.match(await ui("document.querySelector('[data-action=save]').title"), /Ctrl\+S/);
  assert.equal(await main.evaluate("smokeElectron.Menu.getApplicationMenu().items.find(item => item.label.includes('Edit')).submenu.items.find(item => item.label==='Formatting').submenu.items[0].accelerator"), 'CmdOrCtrl+B');
  const shortcutLeft = await activeTab();
  await action('new');
  const shortcutRight = await activeTab();
  await action('split');
  await confirmSplit(shortcutLeft);
  await paneMode(shortcutRight, 'source');
  await sourceEdit('Right independent');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,5)");
  await nativeShortcut('B');
  assert.equal(await paneSource(shortcutRight), '**Right** independent');
  await paneMode(shortcutLeft, 'source');
  assert.equal(await paneSource(shortcutLeft), '```python\nprint("Guarded code")\n```', 'Shortcut in one pane leaves its partner unchanged');
  await ui("document.querySelector('#source-editor').setSelectionRange(0,0)");
  await nativeShortcut('I');
  assert.match(await paneSource(shortcutLeft), /^\*\*/);
  assert.equal(await paneSource(shortcutRight), '**Right** independent');
  await main.evaluate('smokeChoice=1; smokeChoices=[]');
  await ui("document.querySelector('.paired-tab .tab-close').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'close keyboard test pair');
  assert.equal(await tabCount(), 1);
  console.log('PASS: native formatting shortcuts in Source and Visual, exactly-once dispatch, isolated split-side routing, protected Find/dialog/language inputs, menu hints, tooltips and F1 reference');

  await action('new');
  await action('source');
  const linkedOutlineMarkdown = '# Overview\n\n## Scenario 1: [Deployment **guide**](https://example.com/guide)\n\n## [Reference label][guide]\n\n[guide]: https://example.com/reference\n';
  await sourceEdit(linkedOutlineMarkdown);
  const linkedOutlineLabels = ['Overview', 'Scenario 1: Deployment guide', 'Reference label'];
  assert.deepEqual(await ui("[...document.querySelectorAll('#outline .outline-entry')].map(button => button.textContent)"), linkedOutlineLabels);
  assert.deepEqual(await ui("[...document.querySelectorAll('#outline .outline-entry')].map(button => button.title)"), linkedOutlineLabels);
  await ui("document.querySelectorAll('#outline .outline-entry')[1].click()");
  assert.equal(await ui("document.querySelector('#source-editor').selectionStart"), linkedOutlineMarkdown.indexOf('## Scenario 1:'));
  assert.equal(await ui("document.querySelector('#source-editor').value"), linkedOutlineMarkdown, 'Outline navigation never modifies the heading link');
  await action('visual');
  assert.deepEqual(await ui("[...document.querySelectorAll('#outline .outline-entry')].map(button => button.textContent)"), linkedOutlineLabels);
  assert.equal(await ui("document.querySelector('#visual-editor h2 a').getAttribute('href')"), 'https://example.com/guide');
  assert.equal(await ui("document.querySelector('#visual-editor h2 a').textContent"), 'Deployment guide');
  await ui("document.querySelectorAll('#outline .outline-entry')[1].click()");
  assert.equal(await ui("document.querySelector('#link-dialog').open"), false, 'Outline labels navigate instead of opening the linked address');
  await action('source');
  assert.equal(await ui("document.querySelector('#source-editor').value"), linkedOutlineMarkdown, 'Rendering readable outline labels preserves original Markdown');
  console.log('PASS: readable linked-heading outline labels and tooltips, reference links, unchanged document links, and Source/Visual navigation');
  await sourceEdit(Array.from({length:45}, (_, index) => `## Heading ${index}\n\nSome outline content.`).join('\n\n'));
  await action('visual');
  await action('sidebar');
  if (await ui("document.body.classList.contains('sidebar-hidden')")) await action('sidebar');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,600)");
  await delay(250);
  assert.equal(await ui("getComputedStyle(document.querySelector('.toolbar-more')).display"), 'block');
  assert.equal(await ui("getComputedStyle(document.querySelector('.toolbar')).flexWrap"), 'nowrap');
  assert.equal(await ui("getComputedStyle(document.querySelector('.toolbar')).overflowX"), 'hidden', 'Narrow windows use an overflow menu, not a scrollbar');
  assert.ok(await ui("document.querySelector('.toolbar').scrollWidth <= document.querySelector('.toolbar').clientWidth"), 'Toolbar fits available width');
  assert.ok(await ui("(() => {const toolbar=document.querySelector('.toolbar');const controls=[...toolbar.querySelectorAll('button,select')].filter(control=>control.getClientRects().length);return controls.every(control=>Math.abs(control.getBoundingClientRect().top-controls[0].getBoundingClientRect().top)<8)})()"), 'All controls remain on one row');
  assert.ok(await ui("document.querySelector('.workspace-actions').getBoundingClientRect().right <= innerWidth"), 'File actions fit the minimum supported window');
  assert.ok(await ui("document.querySelector('#outline').clientHeight > 30 && document.querySelector('#outline').scrollHeight > document.querySelector('#outline').clientHeight"), 'Long outline has independently scrollable room');
  assert.ok(await ui("document.querySelector('#theme-toggle').getBoundingClientRect().bottom < innerHeight"), 'Theme toggle remains anchored and visible');
  await action('format-menu');
  assert.equal(await ui("document.querySelector('#format-menu').hidden"), false);
  await ui("document.querySelector('[data-command=quote]').click()");
  assert.equal(await ui("document.querySelector('#format-menu').hidden"), true);
  assert.equal(await ui("Boolean(document.querySelector('#visual-editor blockquote'))"), true);
  await menuAction('undo');
  await action('format-menu');
  await ui("document.querySelector('#toolbar-overflow [data-action=redo]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'overflow command completes');
  assert.equal(await ui("Boolean(document.querySelector('#visual-editor blockquote'))"), true, 'Actual overflow Redo restores the edit in the active document');
  await action('save-menu');
  assert.equal(await ui("document.querySelector('#save-menu').hidden"), false);
  assert.equal(await ui("document.querySelectorAll('.workspace-actions > [data-action=save-all]').length"), 0);
  const refinedSave = path.join(temporary, 'refined-save.md');
  await main.evaluate(`smokeSavePath=${JSON.stringify(refinedSave)}`);
  await action('save-all');
  assert.equal(await ui("document.querySelector('#save-menu').hidden"), true);
  assert.match(await readFile(refinedSave, 'utf8'), /Heading 0/);
  await ui("document.querySelector('[data-action=save-menu]').focus()");
  await nativeShortcut('Down', [], false);
  assert.equal(await ui("document.activeElement.dataset.action"), 'save-all');
  await nativeShortcut('Escape', [], false);
  assert.equal(await ui("document.querySelector('#save-menu').hidden"), true);
  assert.equal(await ui("document.activeElement.dataset.action"), 'save-menu');
  const beforeCompactTabs = await activeTab();
  const compactIds = [];
  for (let index = 0; index < 12; index++) {
    await action('new');
    compactIds.push(await activeTab());
  }
  await delay(150);
  assert.ok(await ui("document.querySelector('#tabs').scrollWidth <= document.querySelector('#tabs').clientWidth"), 'Many tabs fit without horizontal scrolling');
  assert.ok(await ui("document.querySelectorAll('.document-tab[hidden]').length > 0"), 'Excess tabs are available through the document list');
  assert.ok(await ui("[...document.querySelectorAll('.document-tab:not([hidden])')].every(tab => tab.getBoundingClientRect().width <= 80)"), 'Visible tabs shrink to browser-style compact tabs');
  await action('tabs-menu');
  assert.equal(await ui("document.querySelectorAll('#tabs-menu button').length"), await tabCount(), 'Document dropdown lists every tab');
  if (process.env.LEKH_SCREENSHOT) {
    const screenshot = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'responsive-tabs.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await ui("document.querySelector('#tabs-menu button').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'document list activation');
  await delay(100);
  assert.ok(await ui("document.querySelector('.document-tab.selected').getClientRects().length > 0"), 'Selecting an overflow tab makes it visible');
  assert.ok(await ui("document.querySelector('#tabs').scrollWidth <= document.querySelector('#tabs').clientWidth"));
  await ui("document.querySelector('#tabs [aria-selected=true]').focus()");
  await nativeShortcut('End', [], false);
  await delay(150);
  assert.equal(await activeTab(), compactIds.at(-1), 'End can activate a tab hidden in overflow');
  assert.ok(await ui("document.querySelector('.document-tab.selected').getClientRects().length > 0"));
  assert.equal(await ui("document.querySelector('#tabs').scrollLeft"), 0, 'Keyboard activation does not leave the compact strip horizontally scrolled');
  await ui("document.querySelector('[aria-controls=tabs-menu]').focus()");
  await nativeShortcut('Down', [], false);
  assert.equal(await ui("document.activeElement.closest('#tabs-menu') !== null"), true, 'Keyboard opens document list');
  await nativeShortcut('Escape', [], false);
  await waitFor(async () => ui("document.activeElement.dataset.action === 'tabs-menu'"), 'Escape restores focus to the document-list trigger', 5000);
  for (const id of compactIds) {
    await selectTab(id);
    await menuAction('close-tab');
  }
  await selectTab(beforeCompactTabs);
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1600,900)");
  await delay(150);
  assert.equal(await ui("document.querySelector('#toolbar-overflow').children.length"), 0, 'Widening restores all original controls');
  assert.ok(await ui("document.querySelector('.toolbar [data-command=quote]') !== null"), 'Restored toolbar command is not duplicated');
  assert.equal(await ui("document.querySelectorAll('[data-command=quote]').length"), 1);
  await menuAction('theme:light');
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'sidebar Light theme');
  if (process.env.LEKH_SCREENSHOT) {
    await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
    await delay(250);
    const screenshot = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'apple-interface-light-desktop.png'), Buffer.from(screenshot.data, 'base64'));
  }
  await menuAction('theme:dark');
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'sidebar Dark theme');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  console.log('PASS: minimum-window layout, independent long-outline scrolling, anchored sidebar themes, adaptive overflow commands, actual Save All dropdown, and keyboard menu navigation');

  const linkPairIds = [];
  for (const side of ['left', 'right']) {
    const file = path.join(temporary, `link-${side}.md`);
    await writeFile(file, `# Link ${side}\n\n${side} [${side} label](https://example.com/${side}) text.`);
    await main.evaluate(`smokeOpenPath=${JSON.stringify(file)}`);
    await action('open');
    linkPairIds.push(await activeTab());
  }
  await selectTab(linkPairIds[0]);
  await action('split');
  await confirmSplit(linkPairIds[1]);
  const leftLinkSelector = pane(linkPairIds[0]) + ' .tiptap a';
  const rightLinkSelector = pane(linkPairIds[1]) + ' .tiptap a';
  const leftLinkHTML = await ui(`document.querySelector(${JSON.stringify(pane(linkPairIds[0]) + ' .tiptap')}).innerHTML`);
  await clickLink(rightLinkSelector);
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'link-right.md', 'Link click activates its split pane');
  assert.equal(await linkField('label'), 'right label');
  await submitLink(null, null, 'cancel');
  assert.equal(await ui("document.querySelector('#dirty-indicator').textContent"), '', 'Cancel leaves a saved document clean');
  await clickLink(rightLinkSelector);
  await submitLink('Right changed', 'https://example.com/right-updated');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(rightLinkSelector)}).textContent`), 'Right changed');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(linkPairIds[0]) + ' .tiptap')}).innerHTML`), leftLinkHTML, 'Editing the right link never alters the left document');
  await showContext(leftLinkSelector);
  await contextAction(['Edit link...']);
  assert.equal(await ui("document.querySelector('#filename').textContent"), 'link-left.md', 'Right-click activates its own pane');
  assert.equal(await linkField('url'), 'https://example.com/left');
  await nativeShortcut('Escape', [], false);
  await waitFor(async () => ui("!document.querySelector('#link-dialog').open"), 'Escape cancels link editing');
  await clickLink(rightLinkSelector);
  await menuAction('new');
  await submitLink('Must not replace another document', 'https://example.com/wrong', 'insert', true);
  assert.equal(await ui("document.querySelector('#link-dialog').open"), true);
  assert.match(await ui("document.querySelector('#link-error').textContent"), /active document changed/);
  assert.equal(await ui("document.querySelector('.tiptap').textContent"), '', 'Stale dialog cannot change a newly activated document');
  await submitLink(null, null, 'cancel');
  await menuAction('close-tab');
  await selectTab(linkPairIds[0]);
  await paneMode(linkPairIds[1], 'preview');
  const previewSelector = pane(linkPairIds[1]) + ' .document-preview a';
  await waitFor(async () => ui(`Boolean(document.querySelector(${JSON.stringify(previewSelector)}))`), 'split read-only link preview');
  await clickLink(previewSelector);
  assert.equal(await ui("document.querySelector('#link-dialog').open"), false, 'Read-only Preview never edits links');
  const promptsBeforePreview = await main.evaluate('smokeExternalPrompts.length');
  await clickLink(previewSelector, 2);
  assert.equal(await main.evaluate('smokeExternalPrompts.length'), promptsBeforePreview + 1, 'Ctrl+click also works in a split read-only Preview');
  assert.equal(await main.evaluate('smokeExternalPrompts.at(-1)'), 'https://example.com/right-updated');
  assert.match(await paneSource(linkPairIds[1]), /Right changed/);
  assert.equal(await ui(`document.querySelector(${JSON.stringify(pane(linkPairIds[0]) + ' .tiptap')}).innerHTML`), leftLinkHTML);
  await main.evaluate('smokeChoice=1');
  await ui("document.querySelector('.paired-tab .tab-close').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'close link test pair');
  assert.equal(await tabCount(), 1);
  console.log('PASS: split-pane link targeting, clean cancellation, Escape, stale-document protection, and read-only Preview Ctrl+click');

  if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
    const images = path.join(root, 'docs', 'images');
    await mkdir(images, {recursive:true});
    if (await ui("document.body.classList.contains('sidebar-hidden')")) await action('sidebar');
    if (await ui("document.querySelector('#recent-toggle').getAttribute('aria-expanded') === 'true'")) await ui("document.querySelector('#recent-toggle').click()");
    await action('visual');
    await menuAction('theme:light');
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'README Light theme');
    await ui("document.querySelector('#notification').click(); document.activeElement.blur()");
    let capture = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(images, 'lekh-light.png'), Buffer.from(capture.data, 'base64'));
    const examples = [
      ['Project Plan.md', '# Project plan\n\nAn uncluttered place to think, write, and share.\n\n## A little structure. A lot of possibility.\n\nTurn a rough idea into a clear, shareable document.\n\n- [x] Shape the first draft\n- [ ] Add details and examples\n- [ ] Export a polished document\n\n> Good writing starts with a little breathing room.\n\n## Next steps\n\nKeep notes nearby without losing your writing flow.'],
      ['Notes.md', '# Keep the good ideas.\n\nA second document, right where you need it.\n\n## Keep the essentials close.\n\n- Edit both files without switching windows.\n- Return to this pair from its combined tab.\n\n```python\ndef write_something_good():\n    idea = "Start with a little curiosity"\n    return idea\n```\n\nPaired, not merged. Each file stays independent.'],
    ];
    const ids = [];
    for (const [name, text] of examples) {
      const file = path.join(temporary, name);
      await writeFile(file, text);
      await main.evaluate(`smokeOpenPath=${JSON.stringify(file)}`);
      await action('open');
      ids.push(await activeTab());
    }
    await selectTab(ids[0]);
    await action('split');
    await confirmSplit(ids[1]);
    await menuAction('theme:dark');
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'README Dark theme');
    await ui("document.querySelector('#notification').click(); document.activeElement.blur()");
    capture = await browser.call('Page.captureScreenshot', {format:'png'}, sessionId);
    await writeFile(path.join(images, 'lekh-dark-split.png'), Buffer.from(capture.data, 'base64'));
    await ui("document.querySelector('.paired-tab .tab-close').click()");
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'close README example pair');
    console.log('PASS: README screenshots captured from the actual Light and Dark split application with sample content');
  }
  if (process.env.LEKH_SCREENSHOT) {
    await action('visual');
    await main.evaluate(`smokeOpenPath = ${JSON.stringify(copied)}`);
    await action('open');
    const screenshot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(process.env.LEKH_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    await menuAction('close-tab');
  }
  const { unzipEntries } = await import(new URL('../build/tests/zip.js', import.meta.url));
  const { publishingBlockRanges } = await import(new URL('../build/lib/publishing.js', import.meta.url));
  const publishingRoot = path.join(temporary, 'publishing-project');
  for (const directory of ['docs', 'includes', 'assets']) await mkdir(path.join(publishingRoot, directory), { recursive: true });
  await writeFile(path.join(publishingRoot, 'assets', 'pixel.png'), testPNG(1, 1));
  await writeFile(path.join(publishingRoot, 'zone-pivot-groups.yml'), 'groups:\n- id: operating-system\n  title: Operating system\n  pivots:\n    - id: windows\n      title: Microsoft Windows\n    - id: linux\n      title: Linux distribution\n');
  const variantLabelsFile = path.join(publishingRoot, 'docs', 'variant-labels.md');
  await writeFile(path.join(publishingRoot, 'includes', 'labels-shared.md'), '<!-- Hidden included comment -->\n\nShared content for label refresh.\n');
  await writeFile(variantLabelsFile, '---\nzone_pivot_groups: operating-system\n---\n\n<!-- Hidden article comment -->\n\n# Variant labels\n\n:::zone pivot="windows"\nWindows content.\n:::zone-end\n\n:::zone pivot="linux"\nLinux content.\n:::zone-end\n\n[!INCLUDE [Shared content](../includes/labels-shared.md)]\n');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(variantLabelsFile)}`);
  await action('open');
  await action('visual');
  await waitFor(async () => ui("Boolean(document.querySelector('.visual-surface .publishing-choose-shared-file'))"), 'Visual offers the shared-file chooser');
  assert.equal(await ui("document.querySelector('.pane-content').textContent.includes('Load variant labels')"), false);
  assert.equal(await ui("document.querySelector('.visual-surface [data-publishing-choice=windows]').textContent"), 'windows');
  await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-include-preview')?.textContent.includes('Shared content for label refresh.')"), 'include access for the label fixture');
  assert.equal(await ui("document.querySelector('.visual-surface [data-publishing-choice=windows]').textContent"), 'windows', 'An Include grant does not authorize project variant configuration');
  await main.evaluate('smokeOpenPath=null');
  await ui("document.querySelector('.visual-surface .publishing-choose-shared-file').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'cancel shared-file choice');
  assert.equal(await ui("document.querySelector('.visual-surface [data-publishing-choice=windows]').textContent"), 'windows', 'Cancel leaves the document-scoped grant unchanged');
  await action('preview');
  await waitFor(async () => ui("Boolean(document.querySelector('.document-preview .publishing-choose-shared-file'))"), 'Preview offers the unresolved shared-file choice');
  assert.doesNotMatch(await ui("document.querySelector('.document-preview').textContent"), /Hidden article comment|Hidden included comment|<!--/);
  await main.evaluate(`smokeOpenPath=${JSON.stringify(path.join(publishingRoot, 'zone-pivot-groups.yml'))}`);
  await ui("document.querySelector('.document-preview .publishing-choose-shared-file').click()");
  await waitFor(async () => ui("document.querySelector('.document-preview [data-publishing-variant=linux]')?.textContent === 'Linux distribution' && document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'chosen shared labels appear in Preview');
  await ui("document.querySelector('.document-preview [data-publishing-variant=linux]').click()");
  await main.evaluate('smokeOpenPath=null');
  await action('visual');
  await waitFor(async () => ui("document.querySelector('.visual-surface [data-publishing-choice=windows]')?.textContent === 'Microsoft Windows'"), 'project labels refresh in Visual');
  assert.equal(await ui("document.querySelector('.visual-surface .publishing-document-selector > strong').textContent"), 'Operating system');
  assert.equal(await ui("Boolean(document.querySelector('.visual-surface .publishing-choose-shared-file'))"), false);
  assert.equal(await ui("document.querySelector('.visual-surface [data-publishing-choice=linux]').getAttribute('aria-pressed')"), 'true');
  const assertSelectorAlignment = async () => {
    const offsets = await ui("(() => {const bar=document.querySelector('.visual-surface .publishing-document-selector').getBoundingClientRect(), body=document.querySelector('.tiptap').getBoundingClientRect();return [Math.abs(bar.left-body.left),Math.abs(bar.right-body.right)];})()");
    assert.ok(offsets.every(offset => offset <= 1), `Shared selector aligns with document content within 1px: ${offsets}`);
  };
  await assertSelectorAlignment();
  const dragDocumentDivider = async (ratio, leftSelector) => {
    const drag = await ui(`(() => {const root=document.querySelector('.pane-content').getBoundingClientRect(), divider=document.querySelector('.pane-divider').getBoundingClientRect();return {x:divider.x+divider.width/2,y:divider.y+divider.height/2,end:root.x+root.width*${ratio}};})()`);
    await browser.call('Input.dispatchMouseEvent', {type:'mousePressed',x:drag.x,y:drag.y,button:'left',buttons:1,clickCount:1}, sessionId);
    await browser.call('Input.dispatchMouseEvent', {type:'mouseMoved',x:drag.end,y:drag.y,button:'left',buttons:1}, sessionId);
    await browser.call('Input.dispatchMouseEvent', {type:'mouseReleased',x:drag.end,y:drag.y,button:'left',buttons:0,clickCount:1}, sessionId);
    assert.equal(await ui("document.querySelector('.pane-divider').getAttribute('aria-valuenow')"), String(Math.round(ratio * 100)));
    const actual = await ui(`(() => {const root=document.querySelector('.pane-content').getBoundingClientRect(), left=document.querySelector(${JSON.stringify(leftSelector)}).getBoundingClientRect();return left.width/(root.width-8);})()`);
    assert.ok(Math.abs(actual - ratio) < 0.01, `Actual pane ratio ${actual} matches requested ${ratio}`);
  };
  await action('edit-split');
  await dragDocumentDivider(0.62, '.visual-surface');
  await assertSelectorAlignment();
  await action('preview');
  await waitFor(async () => ui("document.querySelector('.document-preview [data-publishing-variant=linux]')?.textContent === 'Linux distribution'"), 'shared file retained when opening Preview from Split');
  assert.equal(await ui("document.querySelector('.pane-divider').getAttribute('aria-valuenow')"), '62');
  await dragDocumentDivider(0.38, '.live-preview');
  await ui("document.querySelector('.pane-divider').focus()");
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36}, sessionId);
  assert.equal(await ui("document.querySelector('.pane-divider').getAttribute('aria-valuenow')"), '25');
  await browser.call('Input.dispatchKeyEvent', {type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35}, sessionId);
  await browser.call('Input.dispatchKeyEvent', {type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35}, sessionId);
  assert.equal(await ui("document.querySelector('.pane-divider').getAttribute('aria-valuenow')"), '75');
  await ui("document.querySelector('#preview-source').click()");
  assert.equal(await ui("document.querySelector('.pane-divider').hidden"), true);
  await ui("document.querySelector('#preview-source').click()");
  assert.equal(await ui("document.querySelector('.pane-divider').getAttribute('aria-valuenow')"), '75');
  await action('preview');
  assert.equal(await ui("document.querySelector('.pane-divider').getAttribute('aria-valuenow')"), '75');
  await assertSelectorAlignment();
  assert.equal(await ui("document.querySelector('.visual-surface .publishing-document-selector > strong').textContent"), 'Operating system');
  await action('visual');
  assert.equal(await ui("document.querySelector('.pane-divider').hidden"), true);
  await ui("document.querySelector('[data-action=\"insert:publishing-selector\"]').click()");
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Add variant content reuses the chosen shared file without another dialog');
  await ui("document.querySelector('#variant-content-dialog button[value=cancel]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'cancel retained shared variant insertion');
  await writeFile(path.join(publishingRoot, 'zone-pivot-groups.yml'), 'groups:\n- id: operating-system\n  title: Operating system\n  pivots:\n    - id: windows\n      title: Updated Windows\n    - id: linux\n      title: Updated Linux\n');
  await ui("[...document.querySelectorAll('[data-lekh-include] button')].find(button=>button.textContent==='Refresh content').click()");
  await waitFor(async () => ui("document.querySelector('.visual-surface [data-publishing-choice=windows]')?.textContent === 'Updated Windows'"), 'Refresh content reloads external Visual labels');
  await action('preview');
  await waitFor(async () => ui("document.querySelector('.document-preview [data-publishing-variant=linux]')?.textContent === 'Updated Linux'"), 'project labels refresh in Preview');
  assert.doesNotMatch(await ui("document.querySelector('.document-preview').textContent"), /Hidden article comment|Hidden included comment/);
  await action('preview');
  assert.equal(await ui("document.querySelector('.visual-surface .publishing-document-selector > strong').textContent"), 'Operating system');
  console.log('PASS: shared file/heading/selection survive Preview, Visual and Split; comments hidden; selector alignment and actual pointer/keyboard document resizing');
  await menuAction('close-tab');
  const sharedVariantsFile = path.join(publishingRoot, 'shared-variant-groups.yml');
  await writeFile(sharedVariantsFile, 'groups: []\n');
  await action('new');
  await action('visual');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(sharedVariantsFile)}`);
  await ui("document.querySelector('[data-action=\"insert:publishing-selector\"]').click()");
  await waitFor(async () => ui("document.querySelector('#variant-storage-dialog').open"), 'shared selector storage choice');
  await ui("document.querySelector('#variant-storage-dialog button[value=shared]').click()");
  await waitFor(async () => ui("document.querySelector('#shared-variant-details-dialog').open"), 'shared selector file and entry details');
  await main.evaluate('smokeOpenPath=null');
  await ui(`(() => {
    document.querySelector('#shared-variant-owner').value = 'smoke-owner';
    document.querySelector('#shared-variant-id').value = 'smoke-platform';
    document.querySelector('#shared-variant-title').value = 'Platform';
    document.querySelector('#shared-variant-prompt').value = 'Choose a platform';
    document.querySelector('#shared-variant-details-form button[value=review]').click();
  })()`);
  await waitFor(async () => ui("document.querySelector('#shared-variant-review-dialog').open"), 'review shared selector entry and article metadata');
  assert.match(await ui("document.querySelector('#shared-variant-review-entry').textContent"), /# Owner: smoke-owner[\s\S]*- id: smoke-platform/);
  assert.match(await ui("document.querySelector('#shared-variant-review-metadata').textContent"), /zone_pivot_groups: smoke-platform/);
  await ui("document.querySelector('#shared-variant-review-dialog button[value=confirm]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false' && document.querySelector('.visual-surface .publishing-document-selector > strong')?.textContent === 'Choose a platform'"), 'shared selector appears in the Visual document');
  const sharedVariantEntry = await readFile(sharedVariantsFile, 'utf8');
  assert.match(sharedVariantEntry, /# Owner: smoke-owner[\s\S]*- id: smoke-platform/);
  await action('source');
  assert.match(await ui("document.querySelector('#source-editor').value"), /zone_pivot_groups: smoke-platform/);
  await action('visual');
  await ui("document.querySelector('[data-action=\"insert:publishing-selector\"]').click()");
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'shared choices are available for Add variant content');
  assert.deepEqual(await ui("Array.from(document.querySelectorAll('#variant-content-options input'), input => input.value)"), ['option-1', 'option-2']);
  await ui("document.querySelector('#variant-content-dialog button[value=cancel]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'cancel shared variant content insertion');
  console.log('PASS: shared selector mode, existing-file entry review/write, article metadata, Visual choices, and Add variant content options');
  await main.evaluate('smokeOpenPath=null');
  await menuAction('close-tab');
  const imageAccessFile = path.join(publishingRoot, 'docs', 'image-access.md');
  await writeFile(imageAccessFile, '# Local image\n\n![Pixel](../assets/pixel.png)\n');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(imageAccessFile)}`);
  await action('open');
  await action('visual');
  await waitFor(async () => ui("Boolean(document.querySelector('#notification .notification-action'))"), 'image failure offers contextual project-folder access');
  assert.equal(await ui("document.querySelector('.tiptap img').naturalWidth"), 0, 'Another document does not inherit the previous grant');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(publishingRoot)}`);
  await ui("document.querySelector('#notification .notification-action').click()");
  await waitFor(async () => ui("document.querySelector('.tiptap img')?.naturalWidth === 1"), 'project image refreshes after its own explicit grant');
  await menuAction('close-tab');
  assert.equal(await ui("Boolean(document.querySelector('[data-action=allow-image-folder], [data-action=revoke-image-folder]'))"), false, 'Image permission commands are absent from toolbar menus');
  const sharedPublishing = '---\ntitle: Include metadata is not article content\n---\n\nShared included prose.\n\n![Shared pixel](../assets/pixel.png)\n';
  await writeFile(path.join(publishingRoot, 'includes', 'shared.md'), sharedPublishing);
  const publishingFixture = [
    '---', 'title: Publishing fixture', '---', '',
    '# Publishing fixture', '', 'Unrelated prose.', '',
    '> [!NOTE]', '> A purple note.', '', '> [!TIP]', '> A helpful green tip.', '',
    '> [!IMPORTANT]', '> Essential blue information.', '', '> [!CAUTION]', '> Red caution.', '',
    '> [!WARNING]', '> Orange warning.', '',
    '#### [Managed identity](#tab/msi)', '', '```bash', 'printf "identity"', '```', '',
    '#### [Service principal](#tab/spn)', '', '```bash', 'printf "principal"', '```', '', '---', '',
    ':::selector title="Choose an approach"', '- [First approach](#variant/first)', '- [Second approach](#variant/second)', ':::selector-end', '',
    ':::zone pivot="first"', 'First variant body.', ':::zone-end', '',
    ':::zone pivot="second"', 'Second variant body.', ':::zone-end', '',
    '[!INCLUDE [Shared content](../includes/shared.md)]', '',
    ':::custom-widget', '<script>window.smokePublishingExecuted=true</script>', ':::custom-widget-end', '',
  ].join('\n');
  const publishingFile = path.join(publishingRoot, 'docs', 'article.md');
  await writeFile(publishingFile, publishingFixture);
  await main.evaluate(`smokeIncludeChoice=1; smokeOpenPath=${JSON.stringify(publishingFile)}`);
  await action('open');
  const publishingDocument = await activeTab();
  await action('visual');
  await waitFor(async () => ui("document.querySelectorAll('.publishing-callout').length === 5 && document.querySelectorAll('[data-publishing-tabs]').length === 1"), 'protected rich publishing blocks');
  assert.equal(await ui("window.smokePublishingExecuted === undefined"), true, 'Unsupported HTML is never executable');
  for (const [theme, expected] of [
    ['light', ['rgb(239, 217, 253)', 'rgb(241, 250, 241)', 'rgb(235, 243, 252)', 'rgb(253, 243, 244)', 'rgb(255, 249, 245)']],
    ['dark', ['rgb(59, 46, 88)', 'rgb(5, 75, 22)', 'rgb(0, 65, 115)', 'rgb(99, 0, 1)', 'rgb(74, 30, 4)']],
  ]) {
    await menuAction(`theme:${theme}`);
    for (const [index, kind] of ['note', 'tip', 'important', 'caution', 'warning'].entries()) {
      assert.equal(await ui(`getComputedStyle(document.querySelector('.publishing-callout-${kind}')).backgroundColor`), expected[index], `${kind} matches the published ${theme} alert color`);
    }
  }
  await ui("document.querySelector('[data-publishing-tab=\"1\"]').click()");
  assert.equal(await ui("document.querySelector('[data-publishing-panel=\"0\"]').hidden"), true);
  assert.equal(await ui("document.querySelector('[data-publishing-panel=\"1\"]').hidden"), false);
  await ui("document.querySelector('[data-publishing-tab=\"0\"]').focus()");
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, sessionId);
  assert.equal(await ui("document.activeElement.dataset.publishingTab"), '1', 'Tabs support keyboard navigation');
  await ui("document.querySelector('[data-publishing-tab=\"0\"]').click(); [...document.querySelectorAll('.code-block-controls button')].find(button=>button.textContent==='Copy').click()");
  await waitFor(async () => (await main.evaluate('smokeElectron.clipboard.readText()')) === 'printf "identity"', 'editable rich-block copy matches the current code text without fence syntax');
  await waitFor(async () => ui("document.querySelector('[data-lekh-selector]') && document.querySelectorAll('.visual-surface [data-publishing-selector]').length===1"), 'a single editable Visual selector');
  await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-unsupported')?.textContent.includes('outside the allowed folder')"), 'out-of-folder include requires permission');
  assert.equal(await ui("Boolean(document.querySelector('[data-action=\"allow-include-folder\"], [data-action=\"revoke-include-folder\"]'))"), false, 'Include permission commands are absent from toolbar menus');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(publishingRoot)}`);
  await ui("document.querySelector('[data-lekh-include] .publishing-include-access').click()");
  await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-include-preview')?.textContent.includes('Shared included prose.')"), 'authorized include loads in Visual');
  await main.evaluate('smokeIncludeChoice=0');
  assert.equal(await ui("document.querySelector('[data-lekh-include] .publishing-include-preview').textContent.includes('Include metadata is not article content')"), false);
  await waitFor(async () => ui("(() => {const image=document.querySelector('[data-lekh-include] img');return image?.complete&&image.naturalWidth===1})()"), 'included relative image loads');
  await action('edit-split');
  assert.ok(await ui("(() => {const selector=document.querySelector('.visual-surface [data-publishing-selector]').getBoundingClientRect();const source=document.querySelector('.source-surface').getBoundingClientRect();return selector.right <= source.left+1 && selector.left >= document.querySelector('.visual-surface').getBoundingClientRect().left})()"), 'The selector belongs to Visual, never the Source column');
  assert.equal(await ui("document.querySelector('.document-pane > .publishing-document-selector')"), null);
  await action('visual');
  await ui("document.querySelector('[data-publishing-choice=\"second\"]').click()");
  assert.equal(await ui("document.querySelector('[data-publishing-zone=\"first\"] > .publishing-editable-body').hidden"), true);
  assert.equal(await ui("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false);
  assert.ok(await ui("document.querySelector('.publishing-zone-inactive .publishing-edit-header')?.textContent.includes('Show and edit')"), 'Inactive content remains represented and can be opened directly for editing');
  for (const theme of ['light', 'dark']) {
    await menuAction(`theme:${theme}`);
    await action('export-menu');
    const exportUI = await ui(`(() => {
      const menu=document.querySelector('#export-menu'), note=document.querySelector('#export-restriction');
      const rgb=value=>(value.match(/[\\d.]+/g)||[]).map(Number);
      const luminance=value=>{const c=value.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]};
      const foreground=luminance(rgb(getComputedStyle(note).color)),background=luminance(rgb(getComputedStyle(note).backgroundColor));
      const outer=menu.getBoundingClientRect(),inner=note.getBoundingClientRect();
      return {word:menu.querySelector('[data-action="export-docx"]').disabled,pdf:menu.querySelector('[data-action="export-pdf"]').disabled,
        html:!menu.querySelector('[data-action="export-html"]').disabled,note:!note.hidden,text:note.textContent,
        recommended:menu.querySelector('[data-action="export-html"]').classList.contains('recommended'),previews:menu.querySelectorAll('.export-preview').length,heading:menu.querySelector('#export-menu-title')?.textContent,labelled:menu.getAttribute('aria-labelledby'),
        previewInside:[...menu.querySelectorAll('.export-preview')].every(p=>{const r=p.getBoundingClientRect(),b=p.closest('button').getBoundingClientRect();return r.right<=b.right+1&&r.left>=b.left&&r.width>30}),
        fits:inner.left>=outer.left&&inner.right<=outer.right,contrast:(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)};
    })()`);
    assert.ok(exportUI.word && exportUI.pdf && exportUI.html && exportUI.note && exportUI.fits, JSON.stringify(exportUI));
    assert.match(exportUI.text, /require HTML.*Word and PDF are not supported/i);
    assert.ok(exportUI.contrast >= 4.5, `${theme} export warning contrast: ${exportUI.contrast}`);
    assert.deepEqual([exportUI.recommended, exportUI.previews, exportUI.heading, exportUI.labelled, exportUI.previewInside], [true, 3, 'Export document', 'export-menu-title', true], 'Export panel shows a heading, three format previews and recommends HTML');
    if (process.env.LEKH_SCREENSHOT || (process.env.LEKH_PUBLIC_SCREENSHOTS === '1' && theme === 'light')) {
      await ui("document.querySelector('#notification').hidden=true");
      const shot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      if (process.env.LEKH_SCREENSHOT) {
        await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), `export-panel-${theme}.png`), Buffer.from(shot.data, 'base64'));
      }
      if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1' && theme === 'light') {
        await writeFile(path.join(root, 'docs', 'images', 'export-panel.png'), Buffer.from(shot.data, 'base64'));
      }
    }
    await action('export-menu');
  }
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,700)");
  await action('export-menu');
  assert.equal(await ui("(() => {const r=document.querySelector('#export-menu').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()"), true, 'Export menu fits the minimum application width');
  await action('export-menu');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await ui("document.querySelector('[data-action=\"export-menu\"]').focus()");
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId);
  assert.equal(await ui("document.activeElement.dataset.action"), 'export-html', 'Keyboard entry focuses the supported export');
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 }, sessionId);
  assert.equal(await ui("document.activeElement.dataset.action"), 'export-html', 'Keyboard navigation skips unavailable formats');
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  assert.equal(await ui("document.activeElement.dataset.action"), 'export-menu');
  await waitFor(async () => main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('export-interactive-hint').visible"), 'native export restriction hint');
  const beforeBlockedExport = await main.evaluate('smokeSaveCalls');
  for (const format of ['docx', 'pdf']) {
    await main.evaluate(`smokeSavePath=${JSON.stringify(path.join(temporary, `blocked.${format}`))}`);
    await menuAction(`export-${format}`);
    assert.match(await ui("document.querySelector('#notification').textContent"), /Word and PDF export.*tabbed examples or variants.*HTML/i);
    assert.equal(await main.evaluate('smokeSaveCalls'), beforeBlockedExport, 'Unsupported export is rejected before opening a save dialog');
    await assert.rejects(() => readFile(path.join(temporary, `blocked.${format}`)), { code: 'ENOENT' });
  }
  const publishingHTML = path.join(temporary, 'publishing~review.html');
  await main.evaluate(`smokeSavePath=${JSON.stringify(publishingHTML)}`);
  await action('export-menu');
  await action('export-html');
  const exportedPublishing = await readFile(publishingHTML, 'utf8');
  for (const text of ['Managed identity', 'Service principal', 'First variant body.', 'Second variant body.']) assert.ok(exportedPublishing.includes(text), `HTML keeps ${text}`);
  assert.match(exportedPublishing, /Shared included prose/);
  assert.doesNotMatch(exportedPublishing, /Include metadata is not article content|Edit source|Copy failed/);
  assert.equal(await ui('typeof window.lekh.allowIncludeFolder'), 'function', 'The include permission bridge is available');
  await main.evaluate(`globalThis.smokeOfflineRequests=[]; globalThis.smokeReview=new smokeElectron.BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:'lekh-offline-review'}});
    smokeReview.webContents.session.webRequest.onBeforeRequest((request,callback)=>{smokeOfflineRequests.push(request.url);callback({cancel:!request.url.startsWith('file:')&&!request.url.startsWith('data:')})});
    smokeReview.webContents.setWindowOpenHandler(()=>({action:'deny'})); smokeReview.loadFile(${JSON.stringify(publishingHTML)});`);
  const reviewURL = await main.evaluate('smokeReview.webContents.getURL()');
  assert.equal(await realpath(fileURLToPath(reviewURL)), await realpath(publishingHTML), 'The browser loaded the exported HTML');
  const reviewTarget = await waitFor(async () => (await browser.call('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url === reviewURL), 'offline HTML browser page');
  const { sessionId: reviewSession } = await browser.call('Target.attachToTarget', { targetId: reviewTarget.targetId, flatten: true });
  const review = expression => browser.evaluate(expression, reviewSession);
  assert.equal(await review("document.documentElement.dataset.lekhInteractive"), 'true', 'The CSP-authorized script runs from the exported file');
  assert.equal(await review("document.querySelector('[data-publishing-panel=\"0\"]').hidden"), false);
  assert.equal(await review("document.querySelector('[data-publishing-panel=\"1\"]').hidden"), true);
  await review("document.querySelector('[data-publishing-tab=\"0\"]').focus()");
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, reviewSession);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 }, reviewSession);
  assert.equal(await review("document.activeElement.dataset.publishingTab"), '1');
  assert.equal(await review("document.querySelector('[data-publishing-panel=\"0\"]').hidden"), true);
  assert.equal(await review("document.querySelector('[data-publishing-panel=\"1\"]').hidden"), false);
  for (const [key, code, virtualKey, expected] of [['Home','Home',36,'0'], ['End','End',35,'1'], ['ArrowRight','ArrowRight',39,'0'], ['ArrowLeft','ArrowLeft',37,'1']]) {
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey }, reviewSession);
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey }, reviewSession);
    assert.equal(await review("document.activeElement.dataset.publishingTab"), expected, `${key} selects the expected tab`);
  }
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"first\"]').hidden"), false);
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), true);
  await review("document.querySelector('[data-publishing-variant=\"second\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"first\"]').hidden"), true);
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false);
  assert.equal(await review("document.querySelector('[data-publishing-variant=\"second\"]').getAttribute('aria-pressed')"), 'true');
  const { toOfflineHTML } = await import(new URL('../build/lib/export.js', import.meta.url));
  const longExportLabel = 'LongUnbrokenTechnicalPublishingLabel'.repeat(12);
  const extraMarkdown = [
    '# Offline interactions', '',
    '[Go to the second variant](#second-variant-heading)',
    '[Go to the nested example](#inner-two-heading)', '',
    ':::zone pivot="first"', 'First content before the selector.', ':::zone-end', '',
    ':::selector title="Choose a deployment"', '- [First](#variant/first)', '- [Second](#variant/second)', ':::selector-end', '',
    ':::zone pivot="second"', '## Second variant heading', 'Second content.', ':::zone-end', '',
    ':::zone pivot="third"', 'Third content without an explicit option.', ':::zone-end', '',
    ':::tabs', ':::tab Outer one', 'Outer one content.',
    ':::tabs', ':::tab Inner one', 'Inner one content.', ':::tab-end',
    ':::tab Inner two', '## Inner two heading', 'Inner two content.', ':::tab-end', ':::tabs-end',
    ':::tab-end', ':::tab Outer two', 'Outer two content.', ':::tab-end', ':::tabs-end', '',
    ':::tabs', `:::tab ${longExportLabel}`, 'Independent one content.', ':::tab-end',
    ':::tab Independent two', 'Independent two content.', ':::tab-end', ':::tabs-end', '',
  ].join('\n');
  const extraHTML = path.join(temporary, 'offline-interactions~review.html');
  await writeFile(extraHTML, await toOfflineHTML(extraMarkdown, null));
  await main.evaluate(`smokeReview.loadURL(${JSON.stringify(`${pathToFileURL(extraHTML).href}#second-variant-heading`)})`);
  await waitFor(async () => review("document.documentElement.dataset.lekhInteractive === 'true'"), 'additional offline interactions');
  assert.equal(await review("document.querySelectorAll('[data-publishing-tabs]').length"), 3, 'Nested and independent tab groups remain separate');
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false, 'An initial fragment reveals its inactive variant');
  assert.equal(await review("document.querySelector('[data-publishing-variant=\"second\"]').getAttribute('aria-pressed')"), 'true');
  await review("document.querySelector('[data-publishing-variant=\"first\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), true);
  await review("document.querySelector('a[href=\"#second-variant-heading\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false, 'Clicking a link to the current hash reveals its target again');
  await review("document.querySelector('[data-publishing-variant=\"first\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"first\"]').hidden"), false, 'A variant before its selector follows the selection');
  await review("document.querySelector('[data-publishing-selector=\"primary\"] [data-publishing-variant=\"second\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"first\"]').hidden"), true);
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false);
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"third\"]').hidden"), true);
  await review("document.querySelector('[data-publishing-selector=\"fallback\"] [data-publishing-variant=\"third\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"third\"]').hidden"), false, 'A missing selector option remains reachable');
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), true);
  await review("document.querySelectorAll('[data-publishing-tabs]')[1].querySelectorAll(':scope > .publishing-tablist > button')[1].click()");
  await review("document.querySelectorAll('[data-publishing-tabs]')[2].querySelectorAll(':scope > .publishing-tablist > button')[1].click()");
  assert.equal(await review("document.querySelectorAll('[data-publishing-tabs]')[0].querySelector(':scope > .publishing-tablist > button[aria-selected=\"true\"]').textContent"), 'Outer one');
  assert.equal(await review("document.querySelectorAll('[data-publishing-tabs]')[1].querySelector(':scope > .publishing-tablist > button[aria-selected=\"true\"]').textContent"), 'Inner two');
  assert.equal(await review("document.querySelectorAll('[data-publishing-tabs]')[2].querySelector(':scope > .publishing-tablist > button[aria-selected=\"true\"]').textContent"), 'Independent two');
  await review(`(() => {
    const groups = document.querySelectorAll('[data-publishing-tabs]');
    groups[0].querySelectorAll(':scope > .publishing-tablist > button')[1].click();
    groups[1].querySelectorAll(':scope > .publishing-tablist > button')[0].click();
    window.location.hash = '#inner-two-heading';
  })()`);
  await waitFor(async () => review("!document.querySelector('#inner-two-heading').closest('[hidden]')"), 'fragment navigation reveals nested tab ancestors');
  assert.equal(await review("document.querySelectorAll('[data-publishing-tabs]')[0].querySelector(':scope > .publishing-tablist > button[aria-selected=\"true\"]').textContent"), 'Outer one');
  assert.equal(await review("document.querySelectorAll('[data-publishing-tabs]')[1].querySelector(':scope > .publishing-tablist > button[aria-selected=\"true\"]').textContent"), 'Inner two');
  await review("document.querySelectorAll('[data-publishing-tabs]')[0].querySelectorAll(':scope > .publishing-tablist > button')[1].click();document.querySelector('a[href=\"#inner-two-heading\"]').click()");
  assert.equal(await review("Boolean(document.querySelector('#inner-two-heading').closest('[hidden]'))"), false, 'Repeated nested links reopen all hidden tab ancestors');
  for (const width of [320, 480, 1280]) {
    await browser.call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, reviewSession);
    const layout = await review(`(() => ({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,
      buttons:[...document.querySelectorAll('.publishing-tablist button,.publishing-variant-options button')].filter(button=>button.getClientRects().length)
        .every(button=>button.getBoundingClientRect().right<=innerWidth+1)}))()`);
    assert.ok(layout.scroll <= layout.width + 1 && layout.buttons, `HTML controls and long labels fit at ${width}px: ${JSON.stringify(layout)}`);
  }
  await browser.call('Emulation.clearDeviceMetricsOverride', {}, reviewSession);
  await main.evaluate(`globalThis.smokeNoJS=new smokeElectron.BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,javascript:false,partition:'lekh-offline-no-js'}}); smokeNoJS.loadFile(${JSON.stringify(extraHTML)});`);
  const noJSURL = await main.evaluate('smokeNoJS.webContents.getURL()');
  assert.equal(await realpath(fileURLToPath(noJSURL)), await realpath(extraHTML), 'The JavaScript-disabled browser loaded the offline HTML');
  const noJSTarget = await waitFor(async () => (await browser.call('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url === noJSURL && item.targetId !== reviewTarget.targetId), 'JavaScript-disabled HTML page');
  const { sessionId: noJSSession } = await browser.call('Target.attachToTarget', { targetId: noJSTarget.targetId, flatten: true });
  const noJS = expression => browser.evaluate(expression, noJSSession);
  assert.equal(await noJS("document.documentElement.dataset.lekhInteractive"), undefined);
  assert.equal(await noJS("[...document.querySelectorAll('[data-publishing-panel], [data-publishing-zone]')].every(element=>!element.hidden)"), true);
  assert.equal(await noJS("getComputedStyle(document.querySelector('.publishing-tab-label')).display"), 'block');
  assert.equal(await noJS("getComputedStyle(document.querySelector('.publishing-tablist')).display"), 'none');
  assert.match(await noJS("document.querySelector('.offline-notice').textContent"), /all tabbed examples and variant content are shown/i);
  const fallbackHTML = path.join(temporary, 'offline-fallback.html');
  await writeFile(fallbackHTML, await toOfflineHTML(':::zone pivot=first\nFirst only.\n:::zone-end\n\n:::zone pivot=second\nSecond only.\n:::zone-end\n', null));
  await main.evaluate(`smokeReview.loadFile(${JSON.stringify(fallbackHTML)})`);
  assert.equal(await review("document.querySelector('[data-publishing-selector=\"fallback\"] .publishing-selector-title').textContent"), 'Choose a variant');
  await review("document.querySelector('[data-publishing-selector=\"fallback\"] [data-publishing-variant=\"second\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"first\"]').hidden"), true);
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false);
  const nestedSelector = [
    ':::tabs', ':::tab Selector tab',
    ':::selector title="Choose inside a tab"', '- [First choice](#variant/first)', '- [Second choice](#variant/second)', ':::selector-end',
    ':::tab-end', ':::tab Other tab', 'The selector is not visible here.', ':::tab-end', ':::tabs-end', '',
    ':::zone pivot=first', 'First content.', ':::zone-end', '',
    ':::zone pivot=second', 'Second content.', ':::zone-end', '',
  ].join('\n');
  const nestedSelectorHTML = path.join(temporary, 'offline-nested-selector.html');
  await writeFile(nestedSelectorHTML, await toOfflineHTML(nestedSelector, null));
  await main.evaluate(`smokeReview.loadFile(${JSON.stringify(nestedSelectorHTML)})`);
  await review("document.querySelector('[data-publishing-tab=\"1\"]').click()");
  await review("document.querySelector('[data-publishing-selector=\"fallback\"] [data-publishing-variant=\"second\"]').click()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false, 'A selector inside a hidden tab has a reachable document-wide fallback');
  assert.equal(await review("document.querySelector('[data-publishing-selector=\"fallback\"] [data-publishing-variant=\"second\"]').textContent"), 'Second choice');
  const nestedZoneSelector = [
    ':::zone pivot=first', ':::selector title="Choose inside a variant"',
    '- [First choice](#variant/first)', '- [Second choice](#variant/second)', ':::selector-end',
    'First content.', ':::zone-end', '',
    ':::zone pivot=second', 'Second content.', ':::zone-end', '',
  ].join('\n');
  const nestedZoneHTML = path.join(temporary, 'offline-zone-selector.html');
  await writeFile(nestedZoneHTML, await toOfflineHTML(nestedZoneSelector, null));
  await main.evaluate(`smokeReview.loadFile(${JSON.stringify(nestedZoneHTML)})`);
  await review("(() => {const button=document.querySelector('[data-publishing-selector=\"primary\"] [data-publishing-variant=\"second\"]');button.focus();button.click()})()");
  assert.equal(await review("document.querySelector('[data-publishing-zone=\"second\"]').hidden"), false);
  assert.equal(await review("document.activeElement.closest('[data-publishing-selector]')?.dataset.publishingSelector"), 'fallback', 'Focus moves to a reachable control when switching hides the original selector');
  assert.deepEqual(await main.evaluate("smokeOfflineRequests.filter(url=>!url.startsWith('file:')&&!url.startsWith('data:'))"), [], 'Offline review does not request external resources');
  await main.evaluate('smokeNoJS.destroy();smokeReview.destroy()');
  console.log('PASS: HTML export, disabled static exports, accessible light/dark guidance, offline tab keyboard navigation and document-wide variants');
  await ui("(() => {const p=[...document.querySelectorAll('.tiptap > p')].find(p=>p.textContent==='Unrelated prose.');p.focus();const range=document.createRange();range.selectNodeContents(p);range.collapse(false);window.getSelection().removeAllRanges();window.getSelection().addRange(range);p.closest('.tiptap').focus()})()");
  await browser.call('Input.insertText', { text: ' Added.' }, sessionId);
  await action('source');
  const retainedPublishing = await ui("document.querySelector('#source-editor').value");
  assert.ok(retainedPublishing.includes('Unrelated prose. Added.'));
  for (const block of publishingBlockRanges(publishingFixture)) assert.ok(retainedPublishing.includes(block.raw.trimEnd()), `Visual editing preserves ${block.kind} source`);
  assert.equal(await readFile(publishingFile, 'utf8'), publishingFixture, 'Rendering and interaction never save or overwrite the source');
  await action('preview');
  await waitFor(async () => ui("document.querySelector('.document-preview').textContent.includes('Publishing fixture') && document.querySelector('.document-preview').textContent.includes('Shared included prose.')"), 'Preview resolves local includes');
  assert.equal(await ui("document.querySelector('.document-preview').textContent.includes('Include metadata is not article content')"), false);
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  const includeOnlyFile = path.join(publishingRoot, 'docs', 'include-only.md');
  await writeFile(path.join(publishingRoot, 'includes', 'interactive.md'), ':::tabs\n:::tab One\nIncluded first example.\n:::tab-end\n:::tab Two\nIncluded second example.\n:::tab-end\n:::tabs-end\n');
  await writeFile(includeOnlyFile, '# Include-only article\n\n[!INCLUDE [Examples](../includes/interactive.md)]\n');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(includeOnlyFile)}`);
  await action('open');
  await action('export-menu');
  await waitFor(async () => ui("!document.querySelector('#export-restriction').hidden && document.querySelector('[data-action=\"export-docx\"]').disabled && document.querySelector('[data-action=\"export-pdf\"]').disabled"), 'included tabs restrict static exports');
  await action('export-menu');
  await menuAction('close-tab');
  await action('new');
  await action('source');
  const blockSelection = '**Selected $& text**';
  const blockDocument = `Before.\n\n${blockSelection}\n\nAfter.\n`;
  await sourceEdit(blockDocument);
  await ui(`document.querySelector('#source-editor').setSelectionRange(${blockDocument.indexOf(blockSelection)},${blockDocument.indexOf(blockSelection) + blockSelection.length})`);
  if (!await ui("document.querySelector('[aria-controls=\"alerts-menu\"]').getClientRects().length > 0")) await action('format-menu');
  await ui("document.querySelector('[aria-controls=\"alerts-menu\"]').click()");
  assert.equal(await ui("document.querySelector('#alerts-menu').hidden"), false);
  await ui("document.querySelector('#alerts-menu [data-action=\"insert:callout-tip\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'toolbar callout insertion');
  const formattedSelection = await ui("document.querySelector('#source-editor').value");
  assert.ok(formattedSelection.includes(`> [!TIP]\n> ${blockSelection}`));
  assert.equal(formattedSelection.split(blockSelection).length - 1, 1, 'Formatting the selection must not duplicate it');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), blockDocument);
  await main.evaluate(`smokeOpenPath=${JSON.stringify(path.join(publishingRoot, 'assets', 'pixel.png'))}`);
  await ui("document.querySelector('[aria-controls=\"structure-menu\"]').click()");
  await ui("document.querySelector('#structure-menu [data-action=\"insert:publishing-image\"]').click()");
  await waitFor(async () => ui("document.querySelector('#publishing-image-dialog').open"), 'described image dialog');
  await ui("document.querySelector('#publishing-image-alt').value='A \"quoted\" diagram'; document.querySelector('#publishing-image-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'image directive insertion');
  await action('visual');
  await waitFor(async () => ui("[...document.querySelectorAll('.publishing-image img')].some(image=>image.getAttribute('alt')==='A \"quoted\" diagram' && image.naturalWidth===1)"), 'quoted image description in the editable image node');
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  console.log('PASS: publishing toolbar, exact light/dark alert colors, keyboard tabs, raw code copy, global variants/local labels, protected source roundtrip, unloaded local includes, HTML-only restrictions and described-image insertion');

  await action('new');
  await action('source');
  await sourceEdit('# Root\n\n## Setup\n\nFirst section.\n\n> [!NOTE]\n> ## Setup\n>\n> Second section.\n\n[Go first](#setup)\n\n[Go second](#setup-1)\n');
  await action('visual');
  await waitFor(async () => ui("document.querySelector('.publishing-callout h2')?.id === 'setup-1' && document.querySelector('.tiptap > h2')?.id === 'setup'"), 'document-wide duplicate heading anchors').catch(async error => {
    console.error('Heading diagnostic:', JSON.stringify(await ui("({headings:[...document.querySelectorAll('.tiptap h1,.tiptap h2')].map(h=>({text:h.textContent,id:h.id})),model:document.querySelector('.tiptap').editor.getJSON()})")));
    throw error;
  });
  await ui("window.smokePublishingScroll=[]; document.querySelectorAll('.tiptap h2').forEach(h=>h.scrollIntoView=()=>window.smokePublishingScroll.push(h.id)); document.querySelector('.tiptap a[href=\"#setup\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'first duplicate heading navigation');
  await ui("document.querySelector('.tiptap a[href=\"#setup-1\"]').dispatchEvent(new MouseEvent('click',{bubbles:true,ctrlKey:true}))");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'second duplicate heading navigation');
  assert.deepEqual(await ui("window.smokePublishingScroll"), ['setup', 'setup-1']);
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  console.log('PASS: publishing headings share document-wide unique anchors and navigate to the correct duplicate');

  if (process.env.LEKH_PUBLISHING_REFERENCE && process.env.LEKH_PUBLISHING_ROOT) {
    const reference = await readFile(process.env.LEKH_PUBLISHING_REFERENCE, 'utf8');
    await main.evaluate(`smokeOpenPath=${JSON.stringify(process.env.LEKH_PUBLISHING_REFERENCE)}`);
    await action('open');
    await main.evaluate(`smokeOpenPath=${JSON.stringify(process.env.LEKH_PUBLISHING_ROOT)}`);
    await menuAction('allow-image-folder');
    await action('visual');
    await waitFor(async () => ui("document.querySelector('.visual-surface [data-publishing-selector]')?.getAttribute('aria-label') === 'Choose your Pacemaker Fencing Solution' && document.querySelectorAll('[data-publishing-tabs]').length >= 2"), 'actual reference selectors, includes and implicitly terminated tab groups', 90000);
    await ui("document.querySelector('[data-publishing-choice=\"azure-fence-agent\"]').click()");
    assert.ok(await ui("[...document.querySelectorAll('[role=\"tab\"]')].some(tab=>tab.textContent==='Managed identity' && tab.getClientRects().length>0)"));
    assert.ok(await ui("[...document.querySelectorAll('[role=\"tab\"]')].some(tab=>tab.textContent==='Service principal' && tab.getClientRects().length>0)"));
    assert.equal(await ui("document.querySelector('.tiptap').textContent.includes('Unclosed tabs')"), false);
    if (process.env.LEKH_SCREENSHOT) {
      const capture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'publishing-reference.png'), Buffer.from(capture.data, 'base64'));
    }
    await action('source');
    assert.equal(await ui("document.querySelector('#source-editor').value"), reference.replace(/\r\n/g, '\n'), 'Actual public article remains unchanged through rendering and selector interaction');
    assert.equal(await readFile(process.env.LEKH_PUBLISHING_REFERENCE, 'utf8'), reference);
    await menuAction('close-tab');
    console.log('PASS: the supplied public article renders its real selector prompt/labels and managed-identity/service-principal tabs from authorized local project files without changing source');
  }

  await action('new');
  for (const kind of ['note', 'tip', 'important', 'caution', 'warning']) {
    await action('source');
    await sourceEdit('');
    await action('visual');
    await action(`insert:callout-${kind}`);
    await waitFor(async () => ui("Boolean(document.activeElement?.closest('.tiptap'))"), `the new ${kind} alert keeps the writing caret in Visual`, 5_000);
    await browser.call('Input.insertText', { text: `Direct ${kind} content.` }, sessionId);
    await waitFor(async () => ui(`document.querySelector('.publishing-callout-${kind} .publishing-callout-body')?.textContent === 'Direct ${kind} content.'`), `directly editable ${kind} alert`);
    assert.equal(await ui("(() => {const e=document.querySelector('.tiptap').editor;e.setEditable(false,false);const editable=document.querySelector('.publishing-callout-body').isContentEditable;e.setEditable(true,false);return editable})()"), false, 'Alert bodies respect the editor lock while a native operation is running');
    assert.equal(await ui("document.querySelector('.publishing-callout .publishing-block-tools')"), null);
    assert.equal(await ui("getComputedStyle(document.querySelector('.publishing-callout')).borderLeftWidth"), '4px');
    assert.equal(await ui("document.querySelectorAll('.publishing-callout-title .publishing-icon').length"), 1);
    await action('source');
    const raw = await ui("document.querySelector('#source-editor').value");
    assert.match(raw, new RegExp(`> \\[!${kind.toUpperCase()}\\]`));
    assert.ok(raw.includes(`> Direct ${kind} content.`));
  }
  await action('visual');
  await ui("(() => {const p=document.querySelector('.publishing-callout-body p');const r=document.createRange();r.selectNodeContents(p);r.collapse(false);window.getSelection().removeAllRanges();window.getSelection().addRange(r);p.closest('.tiptap').focus()})()");
  await action('insert:callout-tip');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-alert]').length"), 1, 'Choosing another type changes the current alert rather than nesting a new one');
  assert.equal(await ui("document.querySelector('.publishing-callout-tip .publishing-callout-body').textContent"), 'Direct warning content.');
  await browser.call('Input.insertText', { text: ' More text.' }, sessionId);
  const alertBeforeUndo = await ui("document.querySelector('.publishing-callout-body').textContent");
  await menuAction('undo');
  assert.notEqual(await ui("document.querySelector('.publishing-callout-body').textContent"), alertBeforeUndo);
  assert.ok(await ui("document.querySelector('.publishing-callout-tip') !== null"), 'Typing undo does not also undo a previous type change');
  await menuAction('redo');
  assert.equal(await ui("document.querySelector('.publishing-callout-body').textContent"), alertBeforeUndo);
  await ui("(() => {const p=document.querySelector('.publishing-callout-body p:last-child');const r=document.createRange();r.selectNodeContents(p);r.collapse(false);window.getSelection().removeAllRanges();window.getSelection().addRange(r);p.closest('.tiptap').focus()})()");
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  await browser.call('Input.insertText', { text: 'A second alert paragraph.' }, sessionId);
  assert.ok(await ui("document.querySelector('.publishing-callout-body').textContent.includes('A second alert paragraph.')"));
  for (let count = 0; count < 2; count++) {
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  }
  await browser.call('Input.insertText', { text: 'Outside the alert.' }, sessionId);
  assert.equal(await ui("document.querySelector('.publishing-callout-body').textContent.includes('Outside the alert.')"), false, 'An empty final paragraph can exit the alert without trapping the caret');
  assert.ok(await ui("[...document.querySelectorAll('.tiptap > p')].some(p=>p.textContent==='Outside the alert.')"));
  await action('source');
  await sourceEdit('> [!NOTE]\n> **Formatted** alert body.\n');
  await action('visual');
  await ui(`(() => {
    const target=document.querySelector('.tiptap'),editor=target.editor;
    const html=new DOMParser().parseFromString(editor.getHTML(),'text/html').querySelector('[data-lekh-alert]').outerHTML;
    editor.commands.insertContentAt(editor.state.doc.content.size,{type:'paragraph'});
    editor.commands.setTextSelection(editor.state.doc.content.size);
    editor.commands.focus();
    const transfer=new DataTransfer();transfer.setData('text/html',html);
    target.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  assert.equal(await ui("document.querySelectorAll('[data-lekh-alert]').length"), 2, 'Rich alert clipboard paste preserves the container');
  assert.ok(await ui("[...document.querySelectorAll('.publishing-callout-body')].every(body=>body.textContent==='Formatted alert body.' && body.querySelector('strong')?.textContent==='Formatted')"), 'Alert labels and icons never become pasted body text');
  await ui(`(() => {
    const target=document.querySelector('.tiptap'),editor=target.editor;
    editor.commands.insertContentAt(editor.state.doc.content.size,{type:'paragraph'});
    editor.commands.setTextSelection(editor.state.doc.content.size);editor.commands.focus();
    const transfer=new DataTransfer();
    transfer.setData('text/html','<aside data-lekh-alert="note"><div class="publishing-callout-title">Note</div><div class="publishing-callout-body"><p onclick="window.smokeAlertExecuted=true">Safe <strong>rich text</strong><a href="javascript:window.smokeAlertExecuted=true"> link</a><script>window.smokeAlertExecuted=true</script></p></div></aside>');
    target.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  })()`);
  assert.equal(await ui("window.smokeAlertExecuted===undefined"), true);
  assert.equal(await ui("document.querySelectorAll('[data-lekh-alert]').length"), 3);
  assert.ok(await ui("document.querySelector('.tiptap').textContent.includes('Safe rich text')"), 'Safe content survives sanitization');
  assert.doesNotMatch(await ui("document.querySelector('.tiptap').editor.getHTML()"), /<script|\sonclick=|javascript:/i, 'Alert clipboard content is schema-sanitized');
  await action('source');
  await sourceEdit('> [!NOTE]\n> Context.\n>\n> [guide]: https://example.com/guide "Guide"\n\n> [!TIP]\n> Read [the guide][guide].\n\n# [First](#tab/first)\n\n[The same guide][guide].\n\n# [Second](#tab/second)\n\nOther content.\n\n---\n');
  await action('visual');
  await ui("(() => {const p=document.querySelector('.publishing-callout-note .publishing-callout-body p');const r=document.createRange();r.selectNodeContents(p);r.collapse(true);window.getSelection().removeAllRanges();window.getSelection().addRange(r);p.closest('.tiptap').focus()})()");
  await browser.call('Input.insertText', { text: 'Edited ' }, sessionId);
  await action('source');
  const savedAlertReferences = await ui("document.querySelector('#source-editor').value");
  assert.ok(savedAlertReferences.includes('Edited Context.'));
  const { documentPreviewHTML } = await import(new URL('../build/lib/markdown.js', import.meta.url));
  assert.equal((documentPreviewHTML(savedAlertReferences, 'saved-alert').match(/href="https:\/\/example.com\/guide"/g) ?? []).length, 2, 'Serialized alert edits keep reference destinations used by siblings and protected tabs');
  await action('source');
  await sourceEdit('> [!NOTE]\n> A readable note.\n\n# [First example](#tab/first)\n\nVisible example text.\n\n# [Second example](#tab/second)\n\nSecond example text.\n\n---\n\n:::custom-widget\nUnsupported widget body.\n:::custom-widget-end\n');
  await action('visual');
  await waitFor(async () => ui("document.querySelector('.publishing-unsupported pre') && document.querySelectorAll('[data-publishing-tab]').length===2"), 'contrast fixtures');
  for (const theme of ['light', 'dark']) {
    await menuAction(`theme:${theme}`);
    const contrasts = await ui(`(() => {
      const rgb = value => (value.match(/[\\d.]+/g)||[]).map(Number);
      const luminance = value => {const c=value.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4)});return .2126*c[0]+.7152*c[1]+.0722*c[2]};
      return [...document.querySelectorAll('.publishing-tablist button,.publishing-tab-panel p,.publishing-unsupported p,.publishing-unsupported pre')].filter(e=>e.getClientRects().length).map(e=>{
        let parent=e,bg;while(parent){const color=rgb(getComputedStyle(parent).backgroundColor);if(color.length===3||color[3]===1){bg=color;break}parent=parent.parentElement}
        const fg=rgb(getComputedStyle(e).color),a=luminance(fg),b=luminance(bg||[255,255,255]);
        return {text:e.textContent.slice(0,40),foreground:fg,background:bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      });
    })()`);
    assert.ok(contrasts.length >= 5);
    for (const item of contrasts) assert.ok(item.ratio >= 4.5, `${theme} text contrast must meet 4.5:1: ${JSON.stringify(item)}`);
    await ui("document.querySelector('[data-publishing-tab=\"1\"]').click()");
    assert.equal(await ui("document.querySelector('[data-publishing-panel=\"1\"]').hidden"), false);
    await ui("document.querySelector('[aria-controls=\"interactive-menu\"]').click()");
    assert.ok(await ui("document.querySelector('#alerts-menu [data-action=\"insert:callout-note\"]') !== null && document.querySelector('#interactive-menu [data-action=\"insert:callout-note\"]') === null"));
    assert.ok(await ui("[...document.querySelectorAll('#structure-menu button, #interactive-menu button')].every(button=>button.querySelector('svg') && button.title.length>20 && button.getAttribute('aria-description')===button.title)"));
    await ui("document.body.click()");
  }
  await action('source');
  const longPublishingLabel = `A detailed option ${'UnbrokenTechnicalPublishingLabel'.repeat(7)}`;
  await sourceEdit(`:::selector title="Choose a narrow-window option"\n- [${longPublishingLabel}](#variant/first)\n- [Other option](#variant/second)\n:::selector-end\n\n:::zone pivot="first"\nFirst body.\n:::zone-end\n\n:::zone pivot="second"\nSecond body.\n:::zone-end\n\n# [${longPublishingLabel}](#tab/first)\n\nFirst example.\n\n# [Other example](#tab/second)\n\nSecond example.\n\n---\n`);
  await action('visual');
  await action('edit-split');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,800)");
  await waitFor(async () => ui("document.querySelector('.visual-surface [data-publishing-selector]') && document.querySelectorAll('[data-publishing-tab]').length===2"), 'narrow-window publishing content');
  assert.ok(await ui("(() => {const view=document.querySelector('.visual-surface').getBoundingClientRect();return [...document.querySelectorAll('.visual-surface .publishing-variant-options button,.visual-surface .publishing-tablist button')].every(button=>{const box=button.getBoundingClientRect();return box.left>=view.left-1&&box.right<=view.right+1&&button.scrollWidth<=button.clientWidth+1})})()"), 'Long selector and tab labels wrap without clipping or crossing into Source');
  await action('visual');
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await main.evaluate('smokeChoice=1');
  await menuAction('close-tab');
  console.log('PASS: all five alerts edit directly in Visual, type changes retain content, undo/redo and Enter work, GitHub-style cards have semantic icons, grouped tools have accessible descriptions, and light/dark tabs/warnings meet 4.5:1 contrast');

  const visualPublishingFile = path.join(publishingRoot, 'docs', 'editable.md');
  await writeFile(visualPublishingFile, '---\ntitle: Original title\ndescription: Original description\ncustom: [keep, these]\n---\n\n# Fully visual publishing\n\nPlace the first variant here.\n\n## A different location\n\nPlace the second variant here.\n\n:::steps\n1. First step.\n2. Second step.\n:::steps-end\n\n# [First example](#tab/first)\n\nFirst example body.\n\n# [Second example](#tab/second)\n\nSecond example body.\n\n---\n\n:::image type="complex" source="../assets/pixel.png" alt-text="Original description":::\nLong image description.\n:::image-end\n\n[!INCLUDE [Shared content](../includes/shared.md)]\n');
  await main.evaluate(`smokeOpenPath=${JSON.stringify(visualPublishingFile)}`);
  await action('open');
  await action('visual');
  const visualPublishingId = await activeTab();
  const publishingTool = async (kind, modal = false) => {
    const menu = ['publishing-tabs', 'publishing-selector'].includes(kind) ? 'interactive-menu' : 'structure-menu';
    await ui(`document.querySelector('[aria-controls="${menu}"]').click()`);
    await ui(`document.querySelector('#${menu} [data-action="insert:${kind}"]').click()`);
    if (kind === 'publishing-selector') {
      await waitFor(async () => ui("document.querySelector('#variant-storage-dialog').open || document.querySelector('#variant-content-dialog').open"), 'variant selector or content dialog');
      if (await ui("document.querySelector('#variant-storage-dialog').open")) {
        await ui("document.querySelector('#variant-storage-dialog button[value=local]').click()");
      }
    }
    if (!modal) await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Visual publishing toolbar insertion');
  };
  const inputText = async (selector, value) => {
    await ui(`(() => {const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.setSelectionRange(0,input.value.length)})()`);
    await browser.call('Input.insertText', { text: value }, sessionId);
  };
  const renamePublishingChoice = async (selector, input, value) => {
    await ui(`(() => {const button=document.querySelector(${JSON.stringify(selector)});button.click();button.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()`);
    assert.ok(await ui(`document.querySelector(${JSON.stringify(input)}).getClientRects().length > 0`), 'Rename directly on the displayed choice, not in a duplicate form');
    await inputText(input, value);
    await ui("document.activeElement.blur()");
  };
  const caretIn = async text => {
    const position = await ui(`(() => {
      const root=document.querySelector('#visual-editor .tiptap');
      const p=[...root.querySelectorAll('p')].find(p=>p.textContent===${JSON.stringify(text)});
      if (!p) throw new Error('Missing paragraph: '+${JSON.stringify(text)}+'; found: '+[...root.querySelectorAll('p')].map(node=>node.textContent).join(' | '));
      const desired=root.editor.view.posAtDOM(p,p.childNodes.length);
      root.editor.view.focus();
      root.editor.commands.setTextSelection(desired);
      return desired;
    })()`);
    await waitFor(async () => ui(`(() => {const selection=document.querySelector('#visual-editor .tiptap').editor.state.selection;return selection.empty && selection.from === ${position}})()`), `caret sync for ${text}`);
  };
  await waitFor(async () => ui("document.querySelector('[data-lekh-tabs]') && document.querySelector('[data-lekh-metadata]')"), 'real editable tab and metadata model');
  await showContext('.tiptap p');
  await contextAction(['Insert', 'Interactive']);
  const flyout = await ui(`(() => {
    const root=document.querySelector('#editor-context-menu');
    const insert=[...root.querySelectorAll('button')].find(button=>button.dataset.contextLabel==='Insert'&&button.closest('[role=menu]')===root);
    const parent=document.getElementById(insert.getAttribute('aria-controls'));
    const trigger=[...parent.querySelectorAll('button')].find(button=>button.dataset.contextLabel==='Interactive'&&button.closest('[role=menu]')===parent);
    const child=document.getElementById(trigger.getAttribute('aria-controls'));
    const a=parent.getBoundingClientRect(),b=child.getBoundingClientRect(),row=trigger.getBoundingClientRect();
    return {root:root.matches(':popover-open'),parent:parent.matches(':popover-open'),child:child.matches(':popover-open'),left:b.left,right:b.right,top:b.top,height:b.height,parentLeft:a.left,parentRight:a.right,rowTop:row.top,width:innerWidth,viewHeight:innerHeight,icons:[...child.querySelectorAll('button')].every(button=>button.querySelector('svg')&&button.title.length>20)};
  })()`);
  assert.ok(flyout.root && flyout.parent && flyout.child, 'Nested publishing menu never closes or detaches its parent');
  assert.ok(flyout.left>=8 && flyout.right<=flyout.width-8);
  assert.ok(Math.min(Math.abs(flyout.left-flyout.parentRight-3),Math.abs(flyout.right-flyout.parentLeft+3))<3, 'Flyout attaches to its actual parent, not the root');
  assert.ok(Math.abs(flyout.top-Math.max(8,Math.min(flyout.rowTop,flyout.viewHeight-flyout.height-8)))<3);
  assert.ok(flyout.icons, 'Right-click publishing tools share toolbar icons and descriptions');
  assert.ok(await ui("document.querySelector('#structure-menu [data-action=\"insert:publishing-include\"]')"), 'Structure offers Include');
  assert.equal(await ui("document.querySelector('#interactive-menu [data-action=\"insert:publishing-include\"]')===null"), true, 'Include belongs to Structure, not Interactive');
  assert.equal(await main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('publishing-include').label"), 'Include…', 'The native Insert menu offers Include');
  if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
    await ui("document.querySelector('#notification').hidden=true");
    const capture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(root, 'docs', 'images', 'context-publishing-dark.png'), Buffer.from(capture.data, 'base64'));
  }
  await ui("document.querySelector('#editor-context-menu').hidePopover()");
  const beforeCanceledInclude = await ui("JSON.stringify(document.querySelector('#visual-editor .tiptap').editor.getJSON())");
  await showContext('.tiptap p');
  await contextAction(['Insert', 'Structure']);
  assert.ok(await ui("Boolean(document.querySelector('[data-context-label=\"Include…\"]'))"), 'Right-click Structure offers Include with the other Structure tools');
  await ui("document.querySelector('[data-context-label=\"Include…\"]').click()");
  await waitFor(async () => ui("document.querySelector('#publishing-include-dialog').open"), 'Include dialog from right-click');
  assert.deepEqual(await ui("[...document.querySelectorAll('#publishing-include-dialog label')].map(label=>label.childNodes[0].textContent)"), ['Title', 'File path'], 'Include asks for exactly the requested fields, in order');
  await ui("document.querySelector('#publishing-include-dialog button[value=\"insert\"]').click()");
  assert.equal(await ui("document.querySelector('#publishing-include-dialog').open"), true, 'Both fields are required');
  await ui("document.querySelector('#publishing-include-dialog button[value=\"cancel\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Cancel Include');
  assert.equal(await ui("JSON.stringify(document.querySelector('#visual-editor .tiptap').editor.getJSON())"), beforeCanceledInclude, 'Cancel leaves the document unchanged');
  await caretIn('Place the first variant here.');
  const beforeVisualInclude = await ui("JSON.stringify(document.querySelector('#visual-editor .tiptap').editor.getJSON())");
  await publishingTool('publishing-include', true);
  await waitFor(async () => ui("document.querySelector('#publishing-include-dialog').open"), 'Include dialog from Structure');
  await inputText('#publishing-include-name', 'Deployment prerequisites');
  await inputText('#publishing-include-path', '../includes/prerequisites.md');
  const expectedVisualInclude = '[!INCLUDE [Deployment prerequisites](../includes/prerequisites.md)]';
  assert.equal(await ui("document.querySelector('#publishing-include-preview').textContent"), expectedVisualInclude, 'The dialog previews the directive');
  await ui("document.querySelector('#publishing-include-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Insert Include in Visual');
  assert.ok(await ui(`document.querySelector('#visual-editor .tiptap').editor.markdown.serialize(document.querySelector('#visual-editor .tiptap').editor.getJSON()).includes(${JSON.stringify(expectedVisualInclude)})`), 'Visual inserts the exact title and file path');
  assert.ok(await ui("(() => {const content=document.querySelector('#visual-editor .tiptap').editor.getJSON().content;const index=content.findIndex(node=>node.type==='lekhInclude'&&node.attrs.label==='Deployment prerequisites');return index>=0&&content[index+1]?.type==='paragraph'&&!content[index+1].content})()"), 'The inserted Include leaves a paragraph below it');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui(`JSON.stringify(document.querySelector('#visual-editor .tiptap').editor.getJSON())===${JSON.stringify(beforeVisualInclude)}`), 'Undo Include insertion');
  await action('source');
  const beforeSourceInclude = await ui("document.querySelector('#source-editor').value");
  await ui("(() => {const source=document.querySelector('#source-editor');source.focus();source.setSelectionRange(source.value.length,source.value.length)})()");
  await publishingTool('publishing-include', true);
  await waitFor(async () => ui("document.querySelector('#publishing-include-dialog').open"), 'Include dialog in Source');
  await inputText('#publishing-include-name', 'Source title');
  await inputText('#publishing-include-path', 'includes/source.md');
  await ui("document.querySelector('#publishing-include-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Insert Include in Source');
  const withSourceInclude = await ui("document.querySelector('#source-editor').value");
  assert.ok(withSourceInclude.startsWith(beforeSourceInclude), 'Source inserts at the original caret after opening the dialog');
  assert.ok(withSourceInclude.includes('[!INCLUDE [Source title](includes/source.md)]'), 'Source inserts the exact directive');
  await sourceEdit(beforeSourceInclude);
  await action('visual');
  for (const theme of ['dark', 'light']) {
    for (const category of ['Alerts', 'Structure', 'Interactive']) {
      await showContext('.tiptap p');
      await contextAction(['Insert', category]);
      const rows = await ui(`(() => {
        const menu=[...document.querySelectorAll('.editor-context-submenu:popover-open')].find(menu=>menu.getAttribute('aria-label')===${JSON.stringify(category)});
        return [...menu.querySelectorAll('button')].map(button=>{
          const group=button.querySelector('.context-menu-label'),icon=group.querySelector('svg'),text=group.querySelector('span');
          const a=icon.getBoundingClientRect(),b=text.getBoundingClientRect(),row=button.getBoundingClientRect();
          return {name:text.textContent,expected:button.dataset.contextLabel,gap:b.left-a.right,iconLeft:a.left-row.left,textRight:b.right,rowWidth:row.right,iconWidth:a.width,iconHeight:a.height};
        });
      })()`);
      assert.ok(rows.length > 0, `${theme} ${category} contains tools`);
      for (const row of rows) {
        assert.equal(row.name, row.expected);
        assert.ok(row.gap >= 7 && row.gap <= 9, `${theme} ${row.name}: icon and label stay adjacent, not on opposite edges`);
        assert.ok(row.iconLeft >= 8 && row.iconLeft <= 12 && row.textRight <= row.rowWidth - 8,
          `${theme} ${row.name}: grouped label stays left-aligned within the row`);
        assert.equal(row.iconWidth, 16);
        assert.equal(row.iconHeight, 16);
      }
      await ui("document.querySelector('#editor-context-menu').hidePopover()");
    }
    await action('theme');
  }
  assert.equal(await ui("document.querySelector('#interactive-menu [data-action=\"insert:publishing-zone\"]')===null"), true, 'Variant content is not an independent block-creation option');
  assert.equal(await ui("document.querySelector('#interactive-menu [data-action=\"insert:publishing-selector\"] span').textContent"), 'Variant selector');
  await caretIn('Place the first variant here.');
  await publishingTool('publishing-selector');
  assert.equal(await ui("document.querySelector('#interactive-menu [data-action=\"insert:publishing-selector\"] span').textContent"), 'Add variant content\u2026', 'After inserting a selector, the same tool adds its content instead of creating another selector');
  assert.equal(await ui("Boolean(document.querySelector('[data-lekh-selector] .publishing-add-variant-content'))"), false, 'The selector does not offer a location-specific insertion button');
  await waitFor(async () => main.evaluate("smokeElectron.Menu.getApplicationMenu().getMenuItemById('publishing-selector').label==='Add variant content\u2026'"), 'Native Insert menu follows the selector prerequisite');
  await showContext('.tiptap p');
  await contextAction(['Insert', 'Interactive']);
  assert.ok(await ui("Boolean(document.querySelector('[data-context-label=\"Add variant content\u2026\"]'))"), 'Right-click offers the same follow-on action');
  assert.equal(await ui("document.querySelector('[data-context-label=\"Variant content\u2026\"]')===null"), true);
  await ui("document.querySelector('#editor-context-menu').hidePopover()");
  assert.equal(await ui("document.querySelectorAll('[data-lekh-container=\"lekhZone\"]').length"), 0, 'Selector inserts only choices, never bundled content');
  assert.equal(await ui("document.querySelector('[data-lekh-selector] input').disabled"), false, 'Inserted selector fields unlock after the toolbar operation');
  assert.equal(await ui("document.querySelector('[data-lekh-selector] input').value"), '', 'New selectors contain no prompt text to delete');
  assert.equal(await ui("document.querySelector('[data-lekh-selector] input').placeholder"), 'Describe the title for the selection');
  assert.equal(await ui("document.querySelector('[data-lekh-selector] .publishing-variant-guidance').textContent"), 'To add variant content for an option, choose Add variant content from Interactive.', 'The selector explains where variant content comes from');
  assert.ok(await ui("document.querySelector('[data-lekh-selector] .publishing-variant-guidance').compareDocumentPosition(document.querySelector('[data-lekh-selector] .publishing-variant-options')) & Node.DOCUMENT_POSITION_PRECEDING"), 'The variant-content guidance follows the choices');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-selector] .publishing-write-after, [data-lekh-tabs] .publishing-write-after, [data-lekh-container=\"lekhZone\"] .publishing-write-after').length"), 0, 'Interactive blocks never show a write-after button');
  assert.equal(await ui("(() => {const selector=document.querySelector('[data-lekh-selector]');const doc=selector.closest('.tiptap').editor.state.doc;let next;doc.forEach((node,offset,index)=>{if(node.type.name==='lekhSelector')next=doc.maybeChild(index+1)});return next?.type.name==='paragraph'&&next.content.size===0})()"), true, 'An empty line follows an inserted selector');
  await inputText('[data-lekh-selector] input[aria-label="Selection title"]', 'Choose a deployment');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-selector] .publishing-choice-fields').length"), 0, 'Selector choices have no duplicate option-name form');
  await renamePublishingChoice('[data-lekh-selector] [data-publishing-choice="first"]', '[data-lekh-selector] input[aria-label="Option name (first)"]', 'Availability Zones');
  await renamePublishingChoice('[data-lekh-selector] [data-publishing-choice="second"]', '[data-lekh-selector] input[aria-label="Option name (second)"]', 'Scale Set');
  assert.ok(await ui("document.querySelector('[data-lekh-selector] .publishing-variant-options').lastElementChild.getAttribute('aria-label')==='Add option'"), 'Add option follows the displayed choices');
  await ui("document.querySelector('[data-lekh-selector] [aria-label=\"Add option\"]').click()");
  assert.equal(await ui("document.querySelector('[data-publishing-choice=\"option-3\"]').textContent"), 'Option 3');
  await renamePublishingChoice('[data-lekh-selector] [data-publishing-choice="option-3"]', '[data-lekh-selector] input[aria-label="Option name (option-3)"]', 'Temporary option');
  await ui("document.querySelector('[data-publishing-choice=\"option-3\"]').parentElement.querySelector('[aria-label=\"Remove option\"]').click()");
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("Boolean(document.querySelector('[data-publishing-choice=\"option-3\"]'))"), 'Native undo restores the removed choice');
  assert.equal(await ui("document.querySelector('[data-publishing-choice=\"option-3\"]').textContent"), 'Temporary option', 'Undo restores an individually removed choice without changing its stable ID');
  await nativeShortcut('Z', ['control', 'shift'], false);
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-selector] [data-publishing-choice]').length===2"), 'Native redo removes only that choice');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-selector] [data-publishing-choice]').length"), 2);
  await ui("document.querySelector('[data-publishing-choice=\"first\"]').parentElement.querySelector('[aria-label=\"Remove option\"]').click()");
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-selector] [data-publishing-choice]').length===1"), 'x removes a choice');
  await ui("document.querySelector('[data-publishing-choice=\"second\"]').parentElement.querySelector('[aria-label=\"Remove option\"]').click()");
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-selector]').length===0"), 'Removing the last choice removes the selector');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-selector] [data-publishing-choice]').length===1"), 'Undo restores the selector');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-selector] [data-publishing-choice]').length===2"), 'Undo restores both choices');
  assert.equal(await ui("document.querySelector('[data-publishing-choice=\"first\"]').textContent"), 'Availability Zones');
  await ui("document.activeElement.blur()");
  assert.equal(await ui("document.querySelector('[data-lekh-selector] input[aria-label=\"Option name (second)\"]').value"), 'Scale Set');
  assert.equal(await ui("document.querySelector('#source-editor').hidden"), true, 'Editing selector prompt and labels never opens Source');
  await caretIn('Place the first variant here.');
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Independent variant-content choice dialog');
  const variantRows = await ui(`Array.from(document.querySelectorAll('#variant-content-options label')).map(row => {
    const checkbox=row.querySelector('input'),text=row.querySelector('span');
    const a=checkbox.getBoundingClientRect(),b=text.getBoundingClientRect(),c=row.getBoundingClientRect();
    return {width:a.width,gap:b.left-a.right,textWidth:b.width,right:b.right,rowRight:c.right,label:text.textContent};
  })`);
  assert.equal(variantRows.length, 2);
  for (const row of variantRows) {
    assert.equal(row.width, 16, 'Variant checkboxes do not inherit full-width text-input dimensions');
    assert.ok(row.gap >= 9 && row.gap <= 11, 'Variant names sit directly beside their checkbox');
    assert.ok(row.textWidth >= 150 && row.right <= row.rowRight, 'Variant labels receive the available row width');
  }
  if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
    const theme = await ui('document.documentElement.dataset.theme');
    for (const variantTheme of ['light', 'dark']) {
      await ui(`document.documentElement.dataset.theme=${JSON.stringify(variantTheme)}`);
      await delay(150);
      const capture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(process.cwd(), 'docs', 'images', `variant-content-${variantTheme}.png`), Buffer.from(capture.data, 'base64'));
    }
    await ui(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
  }
  await ui("document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'First distributed variant content');
  assert.ok(await ui("(() => {const doc=document.querySelector('[data-lekh-selector]').closest('.tiptap').editor.getJSON().content;const paragraph=doc.findIndex(node=>node.type==='paragraph' && node.content?.some(item=>item.text==='Place the first variant here.'));const zone=doc.findIndex(node=>node.type==='lekhZone');const selector=doc.findIndex(node=>node.type==='lekhSelector');return paragraph<zone&&zone<selector})()"), 'Interactive inserts content at the chosen caret, even before the selector');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-selector]').length"), 1, 'Follow-on content actions never create duplicate selectors');
  await browser.call('Input.insertText', { text: ' Availability Zones edited directly.' }, sessionId);
  await caretIn('Place the second variant here.');
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Second distributed variant-content dialog');
  await ui("document.querySelectorAll('#variant-content-options input').forEach(input=>input.checked=input.value==='second');document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-container=\"lekhZone\"]').length===2 && document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Second independent variant content');
  assert.equal(await ui("document.querySelector('[data-publishing-zone=\"second\"] .publishing-edit-header button').disabled"), false, 'Inserted variant controls unlock after modal insertion');
  await ui("document.querySelector('[data-publishing-zone=\"second\"] .publishing-edit-header button').click()");
  assert.equal(await ui("document.querySelector('[data-publishing-zone=\"second\"] .publishing-editable-body').hidden"), false, 'Inactive content opens for editing in Visual');
  await ui("(() => {const p=document.querySelector('[data-publishing-zone=\"second\"] .publishing-editable-body p');const range=document.createRange();range.selectNodeContents(p);range.collapse(false);window.getSelection().removeAllRanges();window.getSelection().addRange(range);p.closest('.tiptap').focus()})()");
  await browser.call('Input.insertText', { text: ' Scale Set edited at a different location.' }, sessionId);
  await delay(600);
  await ui("document.querySelector('[data-lekh-selector] [data-publishing-choice=\"second\"]').parentElement.querySelector('[aria-label=\"Remove option\"]').click()");
  await waitFor(async () => ui("!document.querySelector('[data-lekh-selector] [data-publishing-choice=\"second\"]')"), 'Removing an option with existing variant content succeeds');
  assert.ok(await ui("document.querySelector('[data-publishing-zone=\"second\"]').textContent.includes('Scale Set edited at a different location.')"), 'Removing a choice preserves its variant content for reassignment');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("Boolean(document.querySelector('[data-lekh-selector] [data-publishing-choice=\"second\"]'))"), 'Undo restores the referenced selector choice');
  assert.ok(await ui("document.querySelector('[data-publishing-zone=\"second\"]').textContent.includes('Scale Set edited at a different location.')"));
  await caretIn('Place the first variant here.');
  const beforeCanceledVariant = await ui("JSON.stringify(document.querySelector('[data-lekh-selector]').closest('.tiptap').editor.getJSON())");
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Variant insertion at a caret before its selector');
  await ui("document.querySelector('#variant-content-dialog button[value=\"cancel\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Cancel variant insertion before selector');
  assert.equal(await ui("JSON.stringify(document.querySelector('[data-lekh-selector]').closest('.tiptap').editor.getJSON())"), beforeCanceledVariant, 'Cancel never moves content or inserts an empty block');
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Create content before its selector');
  await ui("document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-container=\"lekhZone\"]').length===3 && document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Independent content before selector');
  assert.ok(await ui("(() => {const doc=document.querySelector('[data-lekh-selector]').closest('.tiptap').editor.getJSON().content;return doc.findIndex(node=>node.type==='lekhZone')<doc.findIndex(node=>node.type==='lekhSelector')})()"), 'Variant content can precede the selector as well as appear farther down the document');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-container=\"lekhZone\"]').length===2"), 'Undo only the variant created before its selector');
  const wrappedText = 'Place the first variant here.';
  const beforeVisualWrap = await ui("JSON.stringify(document.querySelector('#visual-editor .tiptap').editor.getJSON())");
  await ui(`(() => {
    const root=document.querySelector('#visual-editor .tiptap');
    const paragraph=[...root.querySelectorAll('p')].find(item=>item.textContent===${JSON.stringify(wrappedText)});
    const text=paragraph.firstChild;
    root.editor.commands.setTextSelection({from:root.editor.view.posAtDOM(text,0),to:root.editor.view.posAtDOM(text,text.textContent.length)});
    root.editor.view.focus();
  })()`);
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Wrap selected Visual text');
  await ui("document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Insert selected Visual text');
  const visualWrappedText = await ui("document.querySelector('#visual-editor .tiptap').editor.getMarkdown()");
  assert.match(visualWrappedText, /:::zone pivot="first"\nPlace the first variant here\.\n:::zone-end/);
  assert.equal(visualWrappedText.split(wrappedText).length - 1, 1, 'Wrapping Visual text never duplicates it');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui(`JSON.stringify(document.querySelector('#visual-editor .tiptap').editor.getJSON())===${JSON.stringify(beforeVisualWrap)}`), 'Undo wrapping Visual text');
  await action('source');
  const beforeSourceWrap = await ui("document.querySelector('#source-editor').value");
  await ui(`(() => {
    const source=document.querySelector('#source-editor'),start=source.value.indexOf(${JSON.stringify(wrappedText)});
    source.focus();source.setSelectionRange(start,start+${wrappedText.length});
  })()`);
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Wrap selected Markdown text');
  await ui("document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false'"), 'Insert selected Markdown text');
  const sourceWrappedText = await ui("document.querySelector('#source-editor').value");
  assert.match(sourceWrappedText, /:::zone pivot="first"\nPlace the first variant here\.\n:::zone-end/);
  assert.equal(sourceWrappedText.split(wrappedText).length - 1, 1, 'Wrapping Markdown text never duplicates it');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), beforeSourceWrap, 'One undo restores selected Markdown');
  await action('visual');
  const metadataYAML = '[data-lekh-metadata] textarea[aria-label="Metadata YAML"]';
  assert.equal(await ui("document.querySelectorAll('[data-lekh-metadata] input').length"), 0, 'Metadata is a single YAML box without separate title/description fields');
  assert.equal(await ui(`document.querySelector(${JSON.stringify(metadataYAML)}).value.trimEnd()`), 'title: Original title\ndescription: Original description\ncustom: [keep, these]');
  await inputText(metadataYAML, 'title: Edited title\ndescription: Edited metadata in Visual\ncustom: [keep, these]');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui(`document.querySelector(${JSON.stringify(metadataYAML)}).value.startsWith('title: Original title')`), 'Undo updates a focused Visual metadata field');
  await nativeShortcut('Z', ['control', 'shift'], false);
  await waitFor(async () => ui(`document.querySelector(${JSON.stringify(metadataYAML)}).value.startsWith('title: Edited title')`), 'Redo restores a focused Visual metadata field');
  await ui("document.activeElement.blur();document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"1\"]').click()");
  assert.equal(await ui("document.querySelectorAll('[data-lekh-tab] input').length"), 0, 'Example bodies start with document content, not a Tab name form');
  assert.ok(await ui("(() => {const list=document.querySelector('[data-lekh-tabs] .publishing-tablist');return list.lastElementChild.getAttribute('aria-label')==='Add tab'&&list.lastElementChild.textContent==='+'&&list.querySelectorAll('[data-remove-tab]').length===2})()"), 'Add follows the examples; each tab owns its remove icon');
  await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"1\"]').focus()");
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F2', code: 'F2', windowsVirtualKeyCode: 113 }, sessionId);
  await waitFor(async () => ui("document.activeElement.getAttribute('aria-label')==='Tab name (second)'"), 'F2 starts editing on the tab');
  await inputText('[data-lekh-tabs] input[aria-label="Tab name (second)"]', 'Scale [Set] example');
  assert.equal(await ui("document.activeElement.getAttribute('aria-label')"), 'Tab name (second)', 'Renaming preserves focus instead of replacing the tab on every keystroke');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.activeElement.value==='Second example'"), 'Undo refreshes the focused tab-name editor');
  assert.equal(await ui("document.activeElement.value"), 'Second example');
  await nativeShortcut('Z', ['control', 'shift'], false);
  await waitFor(async () => ui("document.activeElement.value==='Scale [Set] example'"), 'Redo refreshes the focused tab-name editor');
  assert.equal(await ui("document.activeElement.value"), 'Scale [Set] example');
  await ui("document.activeElement.blur()");
  await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"1\"]').click()");
  assert.ok(await ui("document.querySelector('[data-lekh-tabs] input[aria-label=\"Tab name (second)\"]').getClientRects().length>0"), 'Clicking the selected tab renames it directly on the tab');
  await inputText('[data-lekh-tabs] input[aria-label="Tab name (second)"]', 'Discard this rename');
  await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, sessionId);
  assert.equal(await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"1\"]').textContent"), 'Scale [Set] example', 'Escape restores the name and leaves example content unchanged');
  await caretIn('Second example body.');
  await browser.call('Input.insertText', { text: ' Edited in Visual.' }, sessionId);
  await ui("document.querySelector('[data-lekh-tabs] button[aria-label=\"Add tab\"]').click()");
  await browser.call('Input.insertText', { text: 'Third example written immediately.' }, sessionId);
  assert.ok(await ui("document.querySelector('[data-publishing-panel-id=\"example-3\"]').textContent.includes('Third example written immediately.')"), 'Adding a tab places the caret directly in its content');
  await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"0\"]').click();document.querySelector('[data-remove-tab=\"example-3\"]').click()");
  assert.equal(await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"0\"]').getAttribute('aria-selected')"), 'true', 'Removing another tab preserves the active example');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("Boolean(document.querySelector('[data-publishing-panel-id=\"example-3\"]'))"), 'Undo restores the removed example');
  assert.ok(await ui("document.querySelector('[data-publishing-panel-id=\"example-3\"]').textContent.includes('Third example written immediately.')"), 'Undo restores a removed tab and all its content');
  await nativeShortcut('Z', ['control', 'shift'], false);
  await waitFor(async () => ui("document.querySelectorAll('[data-lekh-tabs] [data-publishing-tab]').length===2"), 'Redo removes only the restored example');
  assert.equal(await ui("document.querySelectorAll('[data-lekh-tabs] [data-publishing-tab]').length"), 2);
  await caretIn('Second step.');
  await browser.call('Input.insertText', { text: ' Updated procedure.' }, sessionId);
  await ui("document.querySelector('[data-lekh-described-image] .publishing-advanced').open=true");
  await inputText('[data-lekh-described-image] input[aria-label="Alternate text"]', 'Edited image description');
  await ui("document.activeElement.blur()");
  await caretIn('Long image description.');
  await browser.call('Input.insertText', { text: ' Rich editable description.' }, sessionId);
  await ui("document.querySelector('[data-lekh-include] details').open=true");
  await inputText('[data-lekh-include] input[aria-label="Include title"]', 'Edited shared name');
  await ui("document.activeElement.blur()");
  assert.equal(await ui("document.querySelector('#source-editor').hidden"), true, 'Every supported block was edited without Source');
  assert.equal(await ui("document.querySelectorAll('.tiptap button').length && [...document.querySelectorAll('.tiptap button')].some(button=>button.textContent==='Edit source')"), false);
  const visualPublishingHTML = path.join(temporary, 'editable-publishing.html');
  await main.evaluate(`smokeSavePath=${JSON.stringify(visualPublishingHTML)}`);
  await main.evaluate(`smokeOpenPath=${JSON.stringify(publishingRoot)}`);
  await ui("document.querySelector('#notification').hidden=true;document.querySelector('#notification').textContent=''");
  await menuAction('allow-image-folder');
  await waitFor(async () => ui("(document.querySelector('#notification')?.textContent || '').includes('Project images and variant labels are allowed')"), 'project image folder granted before Visual publishing export');
  await waitFor(async () => ui("document.querySelector('[data-lekh-include] .publishing-include-preview')?.textContent.includes('Shared included prose.')"), 'include access granted for Visual publishing export');
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), 'idle before Visual publishing export');
  await ui("document.querySelector('#notification').hidden=true;document.querySelector('#notification').textContent=''");
  await menuAction('export-html');
  await waitFor(async () => { try { await readFile(visualPublishingHTML); return true; } catch { return ui("document.querySelector('#notification')?.textContent || ''").then(text => { if (/fail|error|cannot|could not|wait|must be inside/i.test(text)) throw new Error(text); return false; }); } }, 'Visual publishing HTML export');
  const visualPublishingExport = await readFile(visualPublishingHTML, 'utf8');
  for (const text of ['Availability Zones edited directly.', 'Scale Set edited at a different location.', 'Scale [Set] example', 'Second example body. Edited in Visual.', 'Updated procedure.', 'Rich editable description.']) assert.ok(visualPublishingExport.includes(text), `Visual edits export without losing alternatives: ${text}`);
  await action('source');
  const fullyEditedPublishing = await ui("document.querySelector('#source-editor').value");
  for (const text of ['title: Edited title', 'description: Edited metadata in Visual', 'custom: [keep, these]', '#variant/first', '#variant/second', 'Availability Zones edited directly.', 'Scale Set edited at a different location.', 'Edited shared name', 'Edited image description']) assert.ok(fullyEditedPublishing.includes(text), text);
  assert.equal((fullyEditedPublishing.match(/:::zone pivot=/g)||[]).length, 2);
  assert.ok(fullyEditedPublishing.indexOf(':::zone pivot="first"') < fullyEditedPublishing.indexOf('## A different location'));
  assert.ok(fullyEditedPublishing.indexOf(':::zone pivot="second"') > fullyEditedPublishing.indexOf('## A different location'));
  await menuAction('save');
  assert.equal(await readFile(visualPublishingFile,'utf8'), fullyEditedPublishing, 'Actual save retains every Visual field/body change');
  await action('visual');
  assert.equal(await ui("document.querySelector('[data-lekh-selector] input[aria-label=\"Option name (second)\"]').value"), 'Scale Set');
  assert.equal(await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"1\"]').textContent"), 'Scale [Set] example');
  assert.equal(await activeTab(), visualPublishingId);
  await waitFor(async () => ui("document.querySelector('[data-lekh-include]').textContent.includes('Shared included prose.')"), 'Include content is loaded in Visual after save');
  assert.equal(await ui("[...document.querySelectorAll('[data-lekh-include] button')].some(button=>button.textContent==='Open shared file in Visual')"), false);
  await menuAction('close-tab');
  console.log('PASS: direct publishing bodies, in-place tab/choice names, inline add/remove icons, immediate new-example typing, rename undo/redo/Escape, YAML metadata, included content and image descriptions preserve source, actual saves and every alternative');

  await action('new'); await action('source');
  await sourceEdit(':::selector title="Choose a variant"\n- [First](#variant/first)\n- [Second](#variant/second)\n:::selector-end\n');
  await action('visual');
  await ui("document.querySelector('.document-pane.active-pane [data-publishing-choice=\"first\"]').click();document.querySelector('.document-pane.active-pane .tiptap').editor.commands.focus('end')");
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Insert content for an inactive variant');
  await ui("document.querySelectorAll('#variant-content-options input').forEach(input=>input.checked=input.value==='second');document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false' && Boolean(document.querySelector('.document-pane.active-pane [data-publishing-zone=\"second\"]'))"), 'Activate newly inserted variant content');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-choice=\"second\"]').getAttribute('aria-pressed')"), 'true');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane .tiptap').editor.getJSON().content[0].type"), 'lekhSelector', 'Adding content after a selector does not wrap or replace it');
  assert.equal(await ui("Boolean(document.querySelector('.document-pane.active-pane [data-publishing-zone=\"second\"] [data-lekh-selector]'))"), false);
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-zone=\"second\"] > .publishing-editable-body').hidden"), false);
  assert.equal(await ui("Boolean(window.getSelection().anchorNode?.parentElement?.closest('[data-publishing-zone=\"second\"] .publishing-editable-body'))"), true, 'Caret is inside the newly revealed content');
  await browser.call('Input.insertText', { text: 'Typed immediately. ' }, sessionId);
  assert.ok(await ui("document.querySelector('.document-pane.active-pane [data-publishing-zone=\"second\"] .publishing-editable-body').textContent.includes('Typed immediately.')"), 'Typing immediately edits the selected variant');
  await ui("document.querySelector('.document-pane.active-pane .tiptap').editor.commands.focus('end')");
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Insert content shared by both variants');
  await ui("document.querySelectorAll('#variant-content-options input').forEach(input=>input.checked=true);document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false' && Boolean(document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"]'))"), 'Insert shared variant content');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-choice=\"second\"]').getAttribute('aria-pressed')"), 'true', 'Keep the active variant when it applies to the new content');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"] > .publishing-editable-body').hidden"), false);
  assert.equal(await ui("Boolean(window.getSelection().anchorNode?.parentElement?.closest('[data-publishing-zone=\"first,second\"] .publishing-editable-body'))"), true, 'Shared content is immediately editable without changing the active variant');
  await browser.call('Input.insertText', { text: 'Shared text. ' }, sessionId);
  assert.ok(await ui("document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"] .publishing-editable-body').textContent.includes('Shared text.')"));
  await action('source');
  assert.match(await ui("document.querySelector('#source-editor').value"), /Typed immediately\./);

  const nestedVariantSource = ':::selector title="Choose"\n- [First](#variant/first)\n- [Third](#variant/third)\n- [Second](#variant/second)\n:::selector-end\n\n:::zone pivot="first,second"\nParent body.\n:::zone-end\n';
  await sourceEdit(nestedVariantSource);
  await action('visual');
  await ui("document.querySelector('.document-pane.active-pane [data-publishing-choice=\"first\"]').click()");
  await caretIn('Parent body.');
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Nested variant choices');
  await ui("document.querySelectorAll('#variant-content-options input').forEach(input=>input.checked=['third','second'].includes(input.value));document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false' && Boolean(document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"] [data-publishing-zone=\"third,second\"]'))"), 'Insert a reachable nested variant');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-choice=\"second\"]').getAttribute('aria-pressed')"), 'true', 'The shared choice keeps the parent and new content visible');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"] > .publishing-editable-body').hidden"), false);
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-zone=\"third,second\"] > .publishing-editable-body').hidden"), false);
  await browser.call('Input.insertText', { text: 'Nested body.' }, sessionId);
  await ui("(() => {document.querySelector('#notification').textContent='';const parent=document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"]');[...parent.querySelectorAll(':scope > .publishing-edit-header details label')].find(label=>label.textContent==='Second').querySelector('input').click()})()");
  assert.match(await ui("document.querySelector('#notification').textContent"), /share at least one option/i);
  assert.equal(await ui("(() => {const parent=document.querySelector('.document-pane.active-pane [data-publishing-zone=\"first,second\"]');return [...parent.querySelectorAll(':scope > .publishing-edit-header details label')].find(label=>label.textContent==='Second').querySelector('input').checked})()"), true, 'An assignment cannot hide a nested alternative permanently');

  await caretIn('Nested body.');
  const beforeUnreachable = await ui("JSON.stringify(document.querySelector('.document-pane.active-pane .tiptap').editor.getJSON())");
  await ui("document.querySelector('#notification').textContent=''");
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Unreachable nested variant choices');
  await ui("document.querySelectorAll('#variant-content-options input').forEach(input=>input.checked=input.value==='first');document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false' && document.querySelector('#notification').textContent.includes('share at least one option')"), 'Reject unreachable nested content');
  assert.equal(await ui("JSON.stringify(document.querySelector('.document-pane.active-pane .tiptap').editor.getJSON())"), beforeUnreachable, 'A rejected Visual insertion does not change content');
  await action('source');
  const beforeUnreachableSource = await ui("document.querySelector('#source-editor').value");
  await ui("(() => {const source=document.querySelector('#source-editor'),start=source.value.indexOf('Parent body.')+'Parent body.'.length;source.focus();source.setSelectionRange(start,start);document.querySelector('#notification').textContent=''})()");
  await publishingTool('publishing-selector', true);
  await waitFor(async () => ui("document.querySelector('#variant-content-dialog').open"), 'Unreachable Markdown variant choices');
  await ui("document.querySelectorAll('#variant-content-options input').forEach(input=>input.checked=input.value==='third');document.querySelector('#variant-content-dialog button[value=\"insert\"]').click()");
  await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy')==='false' && document.querySelector('#notification').textContent.includes('share at least one option')"), 'Reject unreachable Markdown content');
  assert.equal(await ui("document.querySelector('#source-editor').value"), beforeUnreachableSource, 'A rejected Markdown insertion does not change content');

  await sourceEdit('# [First duplicate](#tab/shared)\n\nFirst duplicate body.\n\n# [Second duplicate](#tab/shared)\n\nSecond duplicate body.\n\n# [Independent](#tab/independent)\n\nIndependent body.\n\n---\n');
  await action('visual');
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-lekh-tabs] [data-publishing-tab]').length===3"), 'Tabs with duplicate source IDs');
  await ui("document.querySelector('.document-pane.active-pane [data-publishing-tab=\"1\"]').click()");
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-panel=\"0\"]').hidden"), true);
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-panel=\"1\"]').hidden"), false, 'Duplicate IDs still select only the intended panel');
  await ui("(() => {const button=document.querySelector('.document-pane.active-pane [data-publishing-tab=\"0\"]');button.click();button.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()");
  await inputText('.document-pane.active-pane .publishing-tab-item:nth-child(1) input', 'Renamed first');
  await ui("document.activeElement.blur()");
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-tab=\"0\"]').textContent"), 'Renamed first');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-tab=\"1\"]').textContent"), 'Second duplicate', 'Renaming the first duplicate never changes the second');
  await ui("document.querySelector('.document-pane.active-pane .publishing-tab-item:nth-child(1) [data-remove-tab]').click()");
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-publishing-tab]').length===2 && Boolean(document.querySelector('.document-pane.active-pane [data-publishing-panel=\"0\"]'))"), 'Remove only the first duplicate');
  assert.equal(await ui("document.querySelector('.document-pane.active-pane [data-publishing-tab=\"0\"]').textContent"), 'Second duplicate');
  assert.ok(await ui("document.querySelector('.document-pane.active-pane [data-publishing-panel=\"0\"]').textContent.includes('Second duplicate body.')"), 'Removing the first duplicate preserves the second body');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-publishing-tab]').length===3"), 'Undo removing a duplicate tab');
  await nativeShortcut('Z', ['control', 'shift'], false);
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-publishing-tab]').length===2"), 'Redo removing the first duplicate');
  await ui("document.querySelector('.document-pane.active-pane .publishing-tab-item:nth-child(1) [data-remove-tab]').click()");
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-publishing-tab]').length===1"), 'Remove the second-to-last tab');
  await ui("document.querySelector('.document-pane.active-pane .publishing-tab-item:nth-child(1) [data-remove-tab]').click()");
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-lekh-tabs]').length===0"), 'Removing the last tab removes the tabbed example');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-publishing-tab]').length===1"), 'Undo restores the tabbed example');
  await nativeShortcut('Z', ['control'], false);
  await waitFor(async () => ui("document.querySelectorAll('.document-pane.active-pane [data-publishing-tab]').length===2"), 'Undo restores the removed tab');
  await action('source');
  const duplicateSource = await ui("document.querySelector('#source-editor').value");
  assert.ok(duplicateSource.includes('# [Second duplicate](#tab/secondduplicate)') && duplicateSource.includes('Second duplicate body.'), 'Tab IDs are derived from the visible tab names');
  assert.ok(!duplicateSource.includes('First duplicate body.') && duplicateSource.includes('Independent body.'));

  const unpaddedJPEG = Buffer.from(JSON.parse(await readFile(path.join(root, 'tests', 'fixtures', 'jpeg-2x3.json'), 'utf8')).join(''), 'base64');
  const paddedJPEG = Buffer.concat([unpaddedJPEG.subarray(0, 3), Buffer.from([255, 255]), unpaddedJPEG.subarray(3)]);
  const jpegSource = `data:image/jpeg;base64,${paddedJPEG.toString('base64')}`;
  await sourceEdit(`# JPEG export\n\n![A tiny JPEG](${jpegSource})\n`);
  const jpegExport = path.join(temporary, 'jpeg-offline.html');
  await main.evaluate(`smokeSavePath=${JSON.stringify(jpegExport)}`);
  await menuAction('export-html');
  assert.ok((await readFile(jpegExport, 'utf8')).includes(jpegSource), 'Actual HTML export accepts and embeds a decodable JPEG with marker padding');
  await main.evaluate('smokeChoice=1'); await menuAction('close-tab');
  console.log('PASS: inactive and shared variant insertion focuses visible content; duplicate tab IDs select, rename, remove, undo and serialize independently; valid padded JPEGs export through the desktop');

  await action('new'); await action('source');
  const divisionTitle = 'Follow-up "quoted" \\ path';
  await sourceEdit(`> [!div class="nextstepaction"] ${divisionTitle}\n> Clipboard division body.\n\n:::image type="content" source="data:image/png;base64,${testPNG(1,1).toString('base64')}" alt-text="Clipboard image" border="false":::\n`);
  await action('visual');
  const clipboardAttributes = await ui(`(() => {
    const target=document.querySelector('.tiptap'),editor=target.editor;
    editor.commands.selectAll();editor.commands.focus();
    const transfer=new DataTransfer();
    target.dispatchEvent(new ClipboardEvent('cut',{clipboardData:transfer,bubbles:true,cancelable:true}));
    const html=transfer.getData('text/html');
    if(!html)throw new Error('Normal cut did not serialize rich clipboard HTML.');
    if(editor.state.doc.textContent)throw new Error('Normal cut did not remove the selection.');
    target.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
    const records=[];editor.state.doc.descendants(node=>{if(node.type.name==='lekhDivision'||node.type.name==='lekhImageDescription')records.push({type:node.type.name,title:node.attrs.title,border:node.attrs.border})});
    return records;
  })()`);
  assert.equal(clipboardAttributes.find(node=>node.type==='lekhDivision').title, divisionTitle, 'Normal cut/paste retains custom division titles');
  assert.equal(clipboardAttributes.find(node=>node.type==='lekhImageDescription').border, 'false', 'Normal cut/paste retains explicit image-border settings');
  await action('source');
  assert.ok((await ui("document.querySelector('#source-editor').value")).includes(`> [!div class="nextstepaction"] ${divisionTitle}\n`));
  assert.ok((await ui("document.querySelector('#source-editor').value")).includes('border="false"'));
  await main.evaluate('smokeChoice=1'); await menuAction('close-tab');
  console.log('PASS: normal complete-block HTML cut/paste retains division titles and image borders, and division titles survive body editing without escaping drift');

  if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
    const images = path.join(root, 'docs', 'images');
    const alertsDemo = path.join(temporary, 'Writing with alerts.md');
    await writeFile(alertsDemo, '# Make the important things clear.\n\nWrite directly in an alert, just as you write anywhere else.\n\n> [!NOTE]\n> A little context helps readers understand the next step.\n\n> [!TIP]\n> Share a useful shortcut or a better way to work.\n\n> [!IMPORTANT]\n> Put essential information where it cannot be missed.\n\n> [!CAUTION]\n> Explain the risk and the precautions readers should take.\n\n> [!WARNING]\n> Make serious risks clear before readers continue.\n');
    await main.evaluate(`smokeOpenPath=${JSON.stringify(alertsDemo)}; smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1360,1120)`);
    await action('open');
    await action('visual');
    for (const theme of ['light', 'dark']) {
      await menuAction(`theme:${theme}`);
      await ui("document.querySelector('#notification').hidden=true; document.activeElement?.blur()");
      const capture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(images, `alerts-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
    await ui("document.querySelector('[aria-controls=\"interactive-menu\"]').click()");
    const menuCapture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(images, 'publishing-menu-dark.png'), Buffer.from(menuCapture.data, 'base64'));
    await ui("document.body.click()");
    const publishingDemo = path.join(temporary, 'Publishing blocks.md');
    await writeFile(publishingDemo, '# One document. Every reader.\n\nChoose an option without changing the source.\n\n:::selector title="Choose your approach"\n- [Quick start](#variant/quick)\n- [Detailed guide](#variant/detailed)\n:::selector-end\n\n:::zone pivot="quick"\nStart with a clear, focused example.\n:::zone-end\n\n:::zone pivot="detailed"\nAdd the background and details your readers need.\n:::zone-end\n\n# [JavaScript](#tab/javascript)\n\n```javascript\nconst release = "ready";\nconsole.log(release);\n```\n\n# [Python](#tab/python)\n\n```python\nrelease = "ready"\nprint(release)\n```\n\n---\n\n> [!TIP]\n> Keep your writing readable in both Light and Dark.\n');
    await main.evaluate(`smokeOpenPath=${JSON.stringify(publishingDemo)}; smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1360,1000)`);
    await action('open');
    await action('visual');
    await action('edit-split');
    await waitFor(async () => ui("document.querySelector('.visual-surface [data-publishing-selector]') && document.querySelectorAll('[data-publishing-tab]').length===2"), 'publishing documentation screenshot');
    await ui("document.querySelector('#notification').hidden=true; document.activeElement?.blur()");
    const splitCapture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(images, 'publishing-split-dark.png'), Buffer.from(splitCapture.data, 'base64'));
    const fieldDemo = path.join(temporary, 'Editable publishing fields.md');
    await writeFile(fieldDemo, '---\ntitle: A richer publishing workflow\ndescription: Edit metadata and examples in Visual.\nkeywords: [writing, publishing]\n---\n\n# Write once. Publish well.\n\n# [Quick example](#tab/quick)\n\nEdit this example directly, including **rich formatting**.\n\n# [Detailed example](#tab/detailed)\n\nEvery alternative remains editable and is retained in exports.\n\n---\n\n> [!TIP]\n> Keep examples concise and actionable.\n');
    await main.evaluate(`smokeOpenPath=${JSON.stringify(fieldDemo)}`);
    await action('open'); await action('visual');
    await waitFor(async () => ui("Boolean(document.querySelector('[data-lekh-metadata] textarea[aria-label=\"Metadata YAML\"]')) && Boolean(document.querySelector('[data-lekh-tabs]'))"), 'current metadata and tabs for documentation');
    await ui("document.querySelector('[data-lekh-metadata]').scrollIntoView({block:'start'});document.querySelector('#notification').hidden=true;document.activeElement?.blur()");
    const fieldsCapture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(images, 'publishing-fields-dark.png'), Buffer.from(fieldsCapture.data, 'base64'));
    await ui("document.querySelector('[data-lekh-tabs] [data-publishing-tab=\"1\"]').click();document.querySelector('[data-lekh-tabs]').scrollIntoView({block:'start'})");
    const contentCapture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(images, 'publishing-editing-dark.png'), Buffer.from(contentCapture.data, 'base64'));
    await menuAction('close-tab');
    await main.evaluate('smokeChoice=1');
    await menuAction('close-tab');
    await menuAction('close-tab');
    await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
    console.log('PASS: feature guide screenshots show editable alerts in Light/Dark, grouped icon tools, and Visual-scoped selectors with readable Dark tabs');
  }

  const grammarFixture = '# Grammar check\n\nWe made a error. We made a error.\n\nShe could of gone.\n\n`We made a error.`\n\n```text\nWe made a error.\n```\n\n[Link](https://example.com/a-error)\n';
  const grammarCRLF = path.join(temporary, 'Grammar CRLF.md');
  await writeFile(grammarCRLF, grammarFixture.replace(/\n/g, '\r\n'));
  await main.evaluate(`smokeOpenPath=${JSON.stringify(grammarCRLF)}`);
  await action('open');
  await action('source');
  const grammarDocument = await activeTab();
  await action('writing-assistance');
  assert.equal(await ui("document.querySelector('#writing-enabled').checked"), false, 'Grammar checking starts opt-in');
  await browser.call('Network.enable', {}, sessionId);
  await browser.call('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
  await ui("document.querySelector('#writing-enabled').click()");
  await waitFor(async () => ui("document.querySelectorAll('#writing-suggestions li').length === 3"), 'real offline grammar results', 90000);
  assert.equal(await ui("localStorage.getItem('lekh-writing-assistance')"), 'true');
  assert.equal(await ui("document.querySelectorAll('.grammar-highlights .grammar-mark').length"), 3, 'Only prose has Source grammar underlines');
  assert.equal(await ui("document.querySelector('#source-editor').value"), grammarFixture, 'Checking does not rewrite Markdown');
  assert.equal(await readFile(grammarCRLF, 'utf8'), grammarFixture.replace(/\n/g, '\r\n'), 'Checking an opened CRLF file leaves its bytes intact');
  await ui("[...document.querySelectorAll('#writing-suggestions li')].find(row=>row.querySelector('.grammar-original').textContent==='a').querySelectorAll('button')[2].click()");
  assert.equal(await ui("document.querySelectorAll('#writing-suggestions li').length"), 2, 'Ignore suppresses only one occurrence');
  await ui("[...document.querySelectorAll('#writing-suggestions li')].find(row=>row.querySelector('.grammar-original').textContent==='a').querySelectorAll('button')[3].click()");
  assert.equal(await ui("document.querySelectorAll('#writing-suggestions li').length"), 1, 'Ignore throughout document suppresses matching rule and text');
  await ui("document.querySelector('[data-grammar-apply]').click()");
  assert.equal(await ui("document.querySelector('#source-editor').value"), grammarFixture.replace('could of', 'could have'));
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('#source-editor').value"), grammarFixture, 'A source grammar correction is undoable without touching code or markup');
  await action('new');
  await action('source');
  const visualGrammarFixture = '> [!NOTE]\n> **We made a error.**\n\n`We made a error.`\n\n```text\nWe made a error.\n```\n';
  await sourceEdit(visualGrammarFixture);
  await action('visual');
  await waitFor(async () => ui("document.querySelectorAll('#writing-suggestions li').length === 1 && document.querySelectorAll('.tiptap .grammar-mark').length === 1"), 'Visual grammar and tab-scoped ignores', 90000);
  await action('edit-split');
  await ui("document.querySelector('#source-editor').focus()");
  await waitFor(async () => ui("document.querySelectorAll('.grammar-highlights .grammar-mark').length === 1 && document.querySelectorAll('.tiptap .grammar-mark').length === 0"), 'focus-only transition to Source grammar', 90000);
  await ui("document.querySelector('.tiptap').focus()");
  await waitFor(async () => ui("document.querySelectorAll('.tiptap .grammar-mark').length === 1 && document.querySelectorAll('.grammar-highlights .grammar-mark').length === 0"), 'focus-only transition to Visual grammar', 90000);
  assert.equal(await ui("document.querySelector('.tiptap pre .grammar-mark, .tiptap code .grammar-mark')"), null);
  if (process.env.LEKH_SCREENSHOT) {
    const capture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'writing-assistance.png'), Buffer.from(capture.data, 'base64'));
  }
  await ui("document.querySelector('[data-grammar-apply]').click()");
  assert.equal(await ui("document.querySelector('.tiptap strong').textContent"), 'We made an error.', 'Visual corrections preserve bold formatting');
  await menuAction('undo');
  assert.equal(await ui("document.querySelector('.tiptap strong').textContent"), 'We made a error.');
  await waitFor(async () => ui("document.querySelector('[data-grammar-apply]') !== null"), 'grammar results after undo', 90000);
  await ui("window.smokeStaleGrammarButton=document.querySelector('[data-grammar-apply]')");
  await action('source');
  await sourceEdit('A completely different sentence.');
  await ui("window.smokeStaleGrammarButton.click()");
  assert.equal(await ui("document.querySelector('#source-editor').value"), 'A completely different sentence.', 'Stale grammar suggestions cannot edit a changed document');
  await selectTab(grammarDocument);
  assert.equal(await ui("document.querySelector('#source-editor').value"), grammarFixture, 'Other documents are unchanged by grammar edits');
  await ui("document.querySelector('#writing-enabled').click()");
  assert.equal(await ui("localStorage.getItem('lekh-writing-assistance')"), 'false');
  assert.equal(await ui("document.querySelectorAll('.grammar-mark').length"), 0, 'Disabling checking clears underlines');
  await ui("document.querySelector('#writing-close').click()");
  await browser.call('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  console.log('PASS: real offline Harper grammar, opened CRLF files, focus-only dual-view transitions, code/URL exclusion, apply/ignore/ignore-document, per-tab isolation, bold preservation, undo, stale edit guards, opt-in persistence, and worker disable');

  const pressKey = async (key, windowsVirtualKeyCode, modifiers = 0, text) => {
    await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode, modifiers, ...(text ? { text } : {}) }, sessionId);
    await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode, modifiers }, sessionId);
    await delay(80);
    await waitFor(async () => ui("document.querySelector('#app').getAttribute('aria-busy') === 'false'"), `key ${key}`);
  };
  const visualBlocks = () => ui("document.querySelector('#visual-editor .tiptap').editor.state.doc.content.content.map(node => node.textContent)");
  const outlineLabels = () => ui("[...document.querySelectorAll('#outline .outline-entry')].map(entry => entry.textContent)");
  const outlineFixture = '# Alpha\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Alpha child\n\nChild text.\n\n# Beta\n\nBeta text.\n';
  await action('new');
  await action('visual');
  await ui("document.querySelector('#visual-editor .tiptap').blur()");
  assert.match(await ui("document.querySelector('#visual-editor .editor-empty-hint').dataset.placeholder"), /press \/ for commands/);
  assert.equal(await ui("document.querySelector('#visual-editor .tiptap').editor.getMarkdown()"), '', 'Blank-document guidance never becomes Markdown');
  for (const menu of ['structure', 'interactive']) {
    assert.ok(await ui(`document.querySelector('.toolbar [data-action="${menu}-menu"]').getClientRects().length > 0`));
    await clickControl(`[data-action="${menu}-menu"]`);
    assert.equal(await ui(`document.querySelector('#${menu}-menu').hidden`), false);
    await pressKey('Escape', 27);
    assert.equal(await ui(`document.querySelector('#${menu}-menu').hidden`), true);
  }
  assert.deepEqual(await ui("[...document.querySelectorAll('#structure-menu button')].map(button => button.dataset.action || `command:${button.dataset.command}`)"),
    ['insert:toc', 'insert:mermaid', 'command:rule', 'insert:publishing-metadata', 'insert:publishing-image', 'insert:publishing-include']);
  assert.deepEqual(await ui("[...document.querySelectorAll('#interactive-menu button')].map(button => button.dataset.action)"),
    ['insert:publishing-tabs', 'insert:publishing-selector']);
  assert.equal(await ui("document.querySelector('#structure-menu [data-action=\"insert:publishing-tabs\"]')"), null);
  assert.equal(await ui("document.querySelector('#interactive-menu [data-action=\"insert:publishing-metadata\"]')"), null);
  for (const theme of ['light', 'dark']) {
    await menuAction(`theme:${theme}`);
    if (process.env.LEKH_SCREENSHOT) {
      await ui("document.querySelector('#notification').hidden=true");
      const capture = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), `blank-document-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
  }
  await ui("document.querySelector('#visual-editor .tiptap').editor.commands.focus('start')");
  await waitFor(async () => ui("document.activeElement === document.querySelector('#visual-editor .tiptap') && !document.querySelector('#visual-editor .editor-empty-hint')"), 'Clicking into an empty document hides the hint before typing');
  await browser.call('Input.insertText', { text: 'Write without the hint.' }, sessionId);
  assert.equal(await ui("document.querySelector('#visual-editor .editor-empty-hint')"), null);
  await menuAction('undo');
  await ui("document.querySelector('#visual-editor .tiptap').blur()");
  assert.ok(await ui("Boolean(document.querySelector('#visual-editor .editor-empty-hint'))"), 'Undo to blank restores guidance');
  await action('source');
  assert.equal(await ui("document.querySelector('#source-editor').value"), '');
  assert.match(await ui("document.querySelector('#source-editor').placeholder"), /Ctrl\+Shift\+P/);
  console.log('PASS: empty-document guidance, typing/undo, content-free hints, separate Structure/Interactive menus and keyboard dismissal');
  await sourceEdit(outlineFixture);
  await ui("(() => {const source=document.querySelector('#source-editor');source.focus();source.setSelectionRange(10,10);source.dispatchEvent(new Event('select'));})()");
  await waitFor(async () => ui("document.querySelector('#cursor-position').textContent === 'Ln 3, Col 2' && !document.querySelector('#cursor-position').hidden"), 'Source status shows the caret line and column');
  assert.match(await ui("document.querySelector('#word-count').textContent"), /^\d+ words · 1 min read$/);
  assert.equal(await ui("document.querySelector('#word-count').tagName + ':' + document.querySelector('#word-count').dataset.action"), 'BUTTON:document-stats');
  await clickControl('#word-count');
  await waitFor(async () => ui("/\\d+ words.*\\d+ characters.*3 headings/i.test(document.querySelector('#notification').textContent)"), 'Clicking the word count shows document statistics');
  assert.equal(await ui("document.querySelector('#save-status').tagName + ':' + document.querySelector('#save-status').dataset.action"), 'BUTTON:save');

  // Outline: Alt+Arrow moves a section with its subsections in Source, and undo restores it.
  assert.deepEqual(await outlineLabels(), ['Alpha', 'Alpha child', 'Beta']);
  await ui("document.querySelector('#outline .outline-entry').focus()");
  await pressKey('ArrowDown', 40, 1);
  await waitFor(async () => ui("document.querySelector('#source-editor').value.startsWith('# Beta')"), 'Alt+Down moves the outline section in Source');
  assert.equal(await ui("document.querySelector('#source-editor').value"), '# Beta\n\nBeta text.\n\n# Alpha\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Alpha child\n\nChild text.\n');
  assert.deepEqual(await outlineLabels(), ['Beta', 'Alpha', 'Alpha child']);
  assert.equal(await ui("document.activeElement.textContent"), 'Alpha', 'Focus follows the moved outline section');
  await pressKey('ArrowDown', 40, 1);
  assert.equal(await ui("document.querySelector('#source-editor').value.startsWith('# Beta')"), true, 'The last section stays in place');
  await menuAction('undo');
  await waitFor(async () => ui(`document.querySelector('#source-editor').value === ${JSON.stringify(outlineFixture)}`), 'Undo restores a Source outline move');

  // Outline drag and drop in Visual, with undo.
  await action('visual');
  await waitFor(async () => (await outlineLabels()).length === 3, 'Visual outline');
  await ui(`(() => {
    const entries=[...document.querySelectorAll('#outline .outline-entry')];
    const transfer=new DataTransfer();
    entries[2].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
    const box=entries[0].getBoundingClientRect();
    const point={bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.x+4,clientY:box.y+2};
    entries[0].dispatchEvent(new DragEvent('dragover',point));
    if (!entries[0].classList.contains('drop-before')) throw new Error('Missing drop-before indicator');
    entries[0].dispatchEvent(new DragEvent('drop',point));
    entries[2].dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:transfer}));
  })()`);
  await waitFor(async () => (await outlineLabels())[0] === 'Beta', 'Dragging an outline heading moves its section');
  assert.deepEqual(await visualBlocks(), ['Beta', 'Beta text.', 'Alpha', 'First paragraph.', 'Second paragraph.', 'Alpha child', 'Child text.']);
  assert.equal(await ui("document.querySelectorAll('#outline .drop-before, #outline .drop-after, #outline .dragging').length"), 0);
  await ui(`(() => {
    const entries=[...document.querySelectorAll('#outline .outline-entry')];
    const transfer=new DataTransfer();
    transfer.setData('text/plain','not a section');
    const box=entries[0].getBoundingClientRect();
    entries[0].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:box.x+4,clientY:box.y+2}));
  })()`);
  await delay(150);
  assert.equal((await outlineLabels())[0], 'Beta', 'Foreign drops never move sections');
  await nativeShortcut('Z', ['control']);
  await waitFor(async () => (await outlineLabels())[0] === 'Alpha', 'Ctrl+Z undoes a Visual outline move');
  assert.deepEqual(await visualBlocks(), ['Alpha', 'First paragraph.', 'Second paragraph.', 'Alpha child', 'Child text.', 'Beta', 'Beta text.']);
  assert.equal(await ui("document.querySelector('#cursor-position').hidden"), true, 'Line and column appear only in Source');
  console.log('PASS: Source caret status, word/read-time count, outline Alt+Arrow and drag-and-drop section moves with subsections, foreign-drop guard, focus tracking, and undo in both modes');

  // Outline collapse and expand: chevron, Left/Right keys, hidden children, and drag after collapse.
  const outlineState = () => ui("[...document.querySelectorAll('#outline .outline-row')].map(row => [row.querySelector('.outline-entry').textContent, row.hidden, row.querySelector('.outline-toggle').getAttribute('aria-expanded'), row.querySelector('.outline-toggle').disabled])");
  assert.deepEqual(await outlineState(), [['Alpha', false, 'true', false], ['Alpha child', false, null, true], ['Beta', false, null, true]]);
  await clickControl('#outline .outline-row:first-child .outline-toggle');
  await waitFor(async () => (await outlineState())[1][1] === true, 'Collapsing hides child headings');
  assert.equal((await outlineState())[0][2], 'false');
  assert.equal(await ui("document.activeElement.classList.contains('outline-entry') && document.activeElement.textContent"), 'Alpha', 'The toggle returns focus to its entry');
  await pressKey('ArrowRight', 39);
  await waitFor(async () => (await outlineState())[1][1] === false, 'Right expands a collapsed heading');
  await pressKey('ArrowLeft', 37);
  await waitFor(async () => (await outlineState())[1][1] === true, 'Left collapses an expanded heading');
  assert.deepEqual(await visualBlocks(), ['Alpha', 'First paragraph.', 'Second paragraph.', 'Alpha child', 'Child text.', 'Beta', 'Beta text.'], 'Collapsing never edits the document');
  if (process.env.LEKH_SCREENSHOT) {
    const shot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'outline-collapsed.png'), Buffer.from(shot.data, 'base64'));
  }
  await pressKey('ArrowRight', 39);
  await waitFor(async () => (await outlineState())[1][1] === false, 'expand again');
  console.log('PASS: outline collapse/expand by chevron and Left/Right keys, hidden descendants, ARIA state, and focus return');

  // Outline moves never split publishing zones or lists; nested headings are not draggable.
  await action('source');
  const zoneFixture = '# One\n\nIntro.\n\n:::zone pivot="a"\n\n## Inside\n\nZone text.\n\n:::zone-end\n\n# Two\n\nTail.\n';
  await sourceEdit(zoneFixture);
  await waitFor(async () => (await outlineLabels()).join('|') === 'One|Inside|Two', 'zone outline');
  assert.deepEqual(await ui("[...document.querySelectorAll('#outline .outline-entry')].map(entry => entry.draggable)"), [true, false, true], 'Only top-level headings are draggable');
  await ui("[...document.querySelectorAll('#outline .outline-entry')][2].focus()");
  await pressKey('ArrowUp', 38, 1);
  await waitFor(async () => ui("document.querySelector('#source-editor').value.startsWith('# Two')"), 'Alt+Up moves a section past a whole zone');
  const movedZone = await ui("document.querySelector('#source-editor').value");
  assert.equal((movedZone.match(/:::zone pivot/g) || []).length, 1);
  assert.ok(movedZone.indexOf(':::zone pivot') < movedZone.indexOf(':::zone-end') && movedZone.indexOf('## Inside') < movedZone.indexOf(':::zone-end'), 'The zone stays intact');
  await menuAction('undo');
  await waitFor(async () => ui(`document.querySelector('#source-editor').value === ${JSON.stringify(zoneFixture)}`), 'undo zone move');
  await sourceEdit(outlineFixture);
  await action('visual');
  await waitFor(async () => (await outlineLabels()).join('|') === 'Alpha|Alpha child|Beta', 'restore outline fixture');
  console.log('PASS: outline moves keep publishing zones intact and only top-level headings can be dragged');

  // Block commands: keyboard, native menus, compact context menu, palette, and undo.
  await caretIn('Second paragraph.');
  await pressKey('ArrowUp', 38, 9);
  assert.deepEqual((await visualBlocks()).slice(0, 3), ['Alpha', 'Second paragraph.', 'First paragraph.'], 'Alt+Shift+Up moves the block');
  assert.equal(await ui("document.querySelector('#visual-editor .tiptap').editor.state.selection.$from.parent.textContent"), 'Second paragraph.', 'The caret moves with its block');
  await menuAction('block:down');
  assert.deepEqual((await visualBlocks()).slice(0, 3), ['Alpha', 'First paragraph.', 'Second paragraph.'], 'Block > Move block down');
  await ui("(() => {const root=document.querySelector('#visual-editor .tiptap');root.editor.chain().focus().setTextSelection(2).run();return true})()");
  await menuAction('block:up');
  await waitFor(async () => ui("document.querySelector('#notification').textContent.includes('already the first')"), 'First block explains why it cannot move');
  await caretIn('Second paragraph.');
  await showContext('.tiptap > p:nth-of-type(2)');
  const blockMenu = await main.evaluate("smokeMenuItem(['Edit']).submenu.items.filter(item => /^(Move block|Duplicate block|Remove block)/.test(item.label)).map(item => [item.label, item.enabled])");
  assert.deepEqual(blockMenu, [['Move block up', true], ['Move block down', true], ['Duplicate block', true], ['Remove block', true]]);
  assert.equal(await main.evaluate("smokeMenuItem(['View and tools', 'Command palette...']).accelerator"), 'CmdOrCtrl+Shift+P');
  await contextAction(['Edit', 'Duplicate block']);
  assert.equal((await visualBlocks()).filter(text => text === 'Second paragraph.').length, 2, 'Right-click Edit > Duplicate block');
  await ui("document.querySelector('#editor-context-menu').hidePopover?.()");
  const appMenu = await main.evaluate(`(() => {
    const items = smokeElectron.Menu.getApplicationMenu().items;
    const edit = items.find(item => item.label.replace('&','') === 'Edit').submenu.items.filter(item => /^(Move block|Duplicate block|Remove block)/.test(item.label));
    const view = items.find(item => item.label.replace('&','') === 'View').submenu.items.find(item => item.label === 'Command palette...');
    return {block: edit.map(item => item.label), palette: view.accelerator, registered: view.registerAccelerator !== false};
  })()`);
  assert.deepEqual(appMenu, { block: ['Move block up', 'Move block down', 'Duplicate block', 'Remove block'], palette: 'CmdOrCtrl+Shift+P', registered: true });

  // Command palette: shortcut, header button, filtering, empty state, Enter, Escape, backdrop.
  await nativeShortcut('P', ['control', 'shift']);
  await waitFor(async () => ui("!document.querySelector('#command-palette').hidden && document.activeElement === document.querySelector('#command-palette input')"), 'Ctrl+Shift+P opens the command palette');
  assert.ok(await ui("document.querySelectorAll('#command-results .command-group').length") >= 8, 'Empty query lists grouped commands');
  assert.ok(await ui("(() => {const panel=document.querySelector('.command-panel').getBoundingClientRect();return panel.left>=0&&panel.right<=innerWidth&&panel.top>=0&&panel.bottom<=innerHeight})()"), 'Palette fits inside the window');
  await browser.call('Input.insertText', { text: 'remove block' }, sessionId);
  await waitFor(async () => ui("document.querySelector('#command-results [aria-selected=true]')?.dataset.commandId === 'block:remove'"), 'Palette filters by every typed word');
  assert.equal(await ui("document.querySelector('#command-palette input').getAttribute('aria-activedescendant')"), await ui("document.querySelector('#command-results [aria-selected=true]').id"));
  await pressKey('Enter', 13, 0, '\r');
  await waitFor(async () => ui("document.querySelector('#command-palette').hidden"), 'Enter closes the palette');
  assert.equal((await visualBlocks()).filter(text => text === 'Second paragraph.').length, 1, 'Palette runs Remove block at the restored caret');
  assert.equal(await ui("document.querySelectorAll('#command-results [role=option]').length"), 0, 'Closed palette leaves no stale options');
  assert.match(await ui("document.querySelector('#notification').textContent"), /Ctrl\+Z/);
  await nativeShortcut('Z', ['control']);
  await waitFor(async () => (await visualBlocks()).filter(text => text === 'Second paragraph.').length === 2, 'Undo restores a removed block');
  await clickControl('header [data-action="command-palette"]');
  await waitFor(async () => ui("!document.querySelector('#command-palette').hidden"), 'Header search opens the palette');
  await browser.call('Input.insertText', { text: 'zzzz nothing' }, sessionId);
  await waitFor(async () => ui("document.querySelector('#command-results .command-empty')?.textContent === 'No matching commands'"), 'Palette empty state');
  await pressKey('Enter', 13, 0, '\r');
  assert.equal(await ui("document.querySelector('#command-palette').hidden"), false, 'Enter with no match does nothing');
  await pressKey('Escape', 27);
  await waitFor(async () => ui("document.querySelector('#command-palette').hidden"), 'Escape closes the palette');
  assert.equal(await ui("Boolean(document.activeElement.closest('.tiptap'))"), true, 'Closing the palette restores editor focus');
  await menuAction('command-palette');
  await waitFor(async () => ui("!document.querySelector('#command-palette').hidden"), 'Menu action opens the palette');
  await menuAction('command-palette');
  assert.equal(await ui("!document.querySelector('#command-palette').hidden && document.activeElement === document.querySelector('#command-palette input')"), true, 'Opening twice keeps one palette focused');
  await pressKey('Tab', 9);
  assert.equal(await ui("document.activeElement === document.querySelector('#command-palette input') && !document.querySelector('#command-palette').hidden"), true, 'Tab keeps focus inside the palette');
  await pressKey('Tab', 9, 8);
  assert.equal(await ui("document.activeElement === document.querySelector('#command-palette input')"), true, 'Shift+Tab keeps focus inside the palette');
  await ui("document.querySelector('header [data-action=\"command-palette\"]').focus()");
  await waitFor(async () => ui("document.querySelector('#command-palette').hidden"), 'Focus leaving the palette closes it');
  await menuAction('command-palette');
  await waitFor(async () => ui("!document.querySelector('#command-palette').hidden"), 'reopen palette');
  for (const type of ['mousePressed', 'mouseReleased']) await browser.call('Input.dispatchMouseEvent', { type, x: 12, y: 300, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sessionId);
  await waitFor(async () => ui("document.querySelector('#command-palette').hidden"), 'Backdrop click closes the palette');
  await caretIn('Beta text.');
  await nativeShortcut('P', ['control', 'shift'], false);
  await waitFor(async () => ui("!document.querySelector('#command-palette').hidden"), 'palette for a toolbar command');
  await browser.call('Input.insertText', { text: 'heading 2' }, sessionId);
  await waitFor(async () => ui("document.querySelector('#command-results [aria-selected=true]')?.dataset.commandId === 'heading:2'"), 'Palette finds Heading 2');
  await pressKey('Enter', 13, 0, '\r');
  await waitFor(async () => ui("[...document.querySelectorAll('.tiptap h2')].some(heading => heading.textContent === 'Beta text.')"), 'Palette applies a paragraph style');
  await nativeShortcut('Z', ['control']);
  await waitFor(async () => ui("![...document.querySelectorAll('.tiptap h2')].some(heading => heading.textContent === 'Beta text.')"), 'Undo the palette style');
  console.log('PASS: block move/duplicate/remove via Alt+Shift+Arrow, menus, right-click and palette with undo; palette shortcut, header button, filtering, ARIA, empty state, Escape, backdrop, focus restore and idempotent open');

  // Floating block toolbar: appears for the clicked block, hides while typing, edge states, actions, and undo.
  const clickParagraph = async text => {
    const point = await ui(`(() => {const p=[...document.querySelectorAll('#visual-editor .tiptap p')].find(p=>p.textContent===${JSON.stringify(text)});p.scrollIntoView({block:'center'});const r=p.getBoundingClientRect();return {x:r.left+Math.min(r.width-2,60),y:r.top+r.height/2}})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await browser.call('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }, sessionId);
    await delay(120);
  };
  const blockToolbar = () => ui(`(() => {
    const bar=document.querySelector('.block-toolbar');
    if (!bar || bar.hidden || !bar.getClientRects().length) return null;
    const r=bar.getBoundingClientRect(), canvas=document.querySelector('#canvas').getBoundingClientRect();
    return {actions:[...bar.querySelectorAll('button')].map(b=>[b.dataset.action,b.disabled,b.getAttribute('aria-label')||b.title]),inside:r.left>=canvas.left-1&&r.right<=canvas.right+1&&r.top>=canvas.top-1};
  })()`);
  await clickParagraph('First paragraph.');
  await waitFor(async () => Boolean(await blockToolbar()), 'Clicking a block shows the floating block toolbar');
  const toolbarState = await blockToolbar();
  assert.deepEqual(toolbarState.actions.map(([id, disabled]) => [id, disabled]), [['block:up', false], ['block:down', false], ['block:duplicate', false], ['block:remove', false]]);
  assert.ok(toolbarState.inside && toolbarState.actions.every(([, , label]) => label), JSON.stringify(toolbarState));
  if (process.env.LEKH_SCREENSHOT || process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
    await ui("document.querySelector('#notification').hidden=true");
    const shot = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (process.env.LEKH_SCREENSHOT) {
      await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'block-toolbar.png'), Buffer.from(shot.data, 'base64'));
    }
    if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
      await writeFile(path.join(root, 'docs', 'images', 'block-toolbar.png'), Buffer.from(shot.data, 'base64'));
    }
  }
  await pressKey('a', 65, 0, 'a');
  await waitFor(async () => (await blockToolbar()) === null, 'Typing hides the block toolbar');
  await pressKey('Backspace', 8);
  await clickParagraph('First paragraph.');
  await waitFor(async () => Boolean(await blockToolbar()), 'Clicking again shows the toolbar');
  const before = await visualBlocks();
  await clickControl('.block-toolbar [data-action="block:duplicate"]');
  await waitFor(async () => (await visualBlocks()).filter(text => text === 'First paragraph.').length === 2, 'Toolbar duplicate');
  assert.equal(await ui("Boolean(document.activeElement.closest('.tiptap'))"), true, 'Toolbar clicks keep editor focus');
  await clickControl('.block-toolbar [data-action="block:remove"]');
  await waitFor(async () => JSON.stringify(await visualBlocks()) === JSON.stringify(before), 'Toolbar remove');
  await clickParagraph('First paragraph.');
  await waitFor(async () => Boolean(await blockToolbar()), 'toolbar after remove');
  await clickControl('.block-toolbar [data-action="block:down"]');
  await waitFor(async () => (await visualBlocks())[1] === 'Second paragraph.', 'Toolbar move down');
  await nativeShortcut('Z', ['control']);
  await waitFor(async () => JSON.stringify(await visualBlocks()) === JSON.stringify(before), 'Undo a toolbar move');
  await ui("(() => {const root=document.querySelector('#visual-editor .tiptap');root.editor.chain().focus().setTextSelection(2).run();return true})()");
  await waitFor(async () => (await blockToolbar())?.actions[0][1] === true, 'Move up is disabled on the first block');
  await action('source');
  assert.equal(await blockToolbar(), null, 'The block toolbar is Visual-only');
  await action('visual');
  console.log('PASS: floating block toolbar placement, labels, typing hide, edge states, duplicate/remove/move with focus kept, undo, and Visual-only display');

  // Slash menu on an empty Visual line.
  await caretIn('Beta text.');
  await pressKey('End', 35, 2);
  await pressKey('Enter', 13, 0, '\r');
  await browser.call('Input.insertText', { text: '/tabbed' }, sessionId);
  await waitFor(async () => ui("!document.querySelector('#slash-results').hidden && document.querySelector('#slash-results [aria-selected=true]')?.dataset.commandId === 'insert:publishing-tabs'"), 'Typing /tabbed opens the slash menu');
  assert.ok(await ui("(() => {const menu=document.querySelector('#slash-results').getBoundingClientRect();return menu.left>=0&&menu.right<=innerWidth&&menu.top>=0&&menu.bottom<=innerHeight})()"), 'Slash menu stays inside the window');
  assert.equal(await ui("[...document.querySelectorAll('#slash-results [data-command-id]')].every(option => option.querySelector('.command-icon')?.children.length && option.querySelector('small')?.textContent.trim() && option.querySelector('small').getClientRects().length)"), true, 'Every slash entry shows an icon and a description');
  assert.equal(await ui("[...document.querySelectorAll('#slash-results [data-command-id]')].some(option => ['save','export-pdf','block:up'].includes(option.dataset.commandId))"), false);
  await pressKey('Escape', 27);
  await waitFor(async () => ui("document.querySelector('#slash-results').hidden"), 'Escape dismisses the slash menu');
  assert.equal((await visualBlocks()).at(-1), '/tabbed', 'Escape keeps the typed text');
  await browser.call('Input.insertText', { text: ' ' }, sessionId);
  await waitFor(async () => ui("!document.querySelector('#slash-results').hidden"), 'Typing again reopens the slash menu');
  await pressKey('ArrowDown', 40);
  await pressKey('ArrowUp', 38);
  assert.equal(await ui("document.querySelector('#slash-results [aria-selected=true]').dataset.commandId"), 'insert:publishing-tabs', 'Arrow keys move through slash results');
  await pressKey('Enter', 13, 0, '\r');
  await waitFor(async () => ui("Boolean(document.querySelector('.tiptap [data-lekh-tabs]')) && document.querySelector('#slash-results').hidden"), 'Enter inserts the chosen block');
  assert.equal((await visualBlocks()).includes('/tabbed '), false, 'The slash command text is removed');
  await ui(`(() => {
    const root=document.querySelector('#visual-editor .tiptap');
    const heading=[...root.querySelectorAll('h1')].find(node=>node.textContent==='Beta');
    root.editor.view.focus();
    root.editor.commands.setTextSelection(root.editor.view.posAtDOM(heading, heading.childNodes.length));
  })()`);
  await browser.call('Input.insertText', { text: '/x' }, sessionId);
  await delay(150);
  assert.equal(await ui("document.querySelector('#slash-results').hidden"), true, 'Slash inside text or headings does not open the menu');
  await caretIn('Beta text.');
  await pressKey('End', 35, 2);
  await pressKey('Enter', 13, 0, '\r');
  await browser.call('Input.insertText', { text: '/qqqzz' }, sessionId);
  await delay(150);
  const blockCount = (await visualBlocks()).length;
  await pressKey('Enter', 13, 0, '\r');
  assert.equal((await visualBlocks()).length, blockCount + 1, 'Enter with no slash match creates a new paragraph');
  assert.equal(await ui("document.querySelector('#slash-results').hidden"), true);
  await nativeShortcut('Z', ['control']);
  console.log('PASS: slash icons and descriptions; Enter falls through when nothing matches');
  console.log('PASS: slash menu filtering, placement, block-only entries, Escape dismissal, reopen, arrow navigation and Enter insertion without leftover text');

  // Grouped toolbar overflow keeps whole groups, with captions, at the minimum window size.
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(850,600)");
  await delay(300);
  const grouped = await ui(`(() => {
    const toolbar=document.querySelector('.toolbar');
    const groups=[...toolbar.querySelectorAll('.toolbar-group')];
    const overflow=document.querySelector('#toolbar-overflow');
    return {
      scroll: toolbar.scrollWidth <= toolbar.clientWidth + 1,
      split: groups.filter(group => group.closest('#toolbar-overflow')).some(group => group.querySelectorAll('button').length === 0),
      overflowGroups: overflow.querySelectorAll('.toolbar-group').length,
      palette: getComputedStyle(document.querySelector('header [data-action="command-palette"]')).display !== 'none',
      overlap: (() => {
        const visible=[...toolbar.querySelectorAll('button, select')].filter(control => !control.closest('#toolbar-overflow, .dropdown') && control.getClientRects().length).map(control => control.getBoundingClientRect());
        return visible.some((a, i) => visible.some((b, j) => i !== j && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
      })(),
      label: [...document.querySelectorAll('.toolbar .global-modes button, .toolbar #preview-toggle')].every(button => button.scrollWidth <= button.clientWidth + 1),
      fonts: new Set([...document.querySelectorAll('#toolbar-overflow .toolbar-group button')].map(b => getComputedStyle(b).fontSize)).size,
    };
  })()`);
  assert.equal(grouped.overlap, false, 'Visible toolbar controls never overlap at the minimum width');
  assert.equal(grouped.label, true, 'The View switch label is never clipped');
  assert.ok(grouped.fonts <= 1, 'Overflow items share one font size');
  assert.equal(grouped.scroll, true, 'No horizontal toolbar scrolling');
  assert.equal(grouped.split, false, 'Overflow never leaves an empty group');
  assert.ok(grouped.overflowGroups > 0, `Whole groups move into More: ${JSON.stringify(grouped)}`);
  assert.equal(grouped.palette, true, 'Search commands remains reachable at the minimum width');
  assert.ok(await ui("document.querySelector('.tabs-bar > [data-action=\"new\"]').getClientRects().length > 0"), 'New-tab plus remains reachable at minimum width');
  for (const menu of ['structure', 'interactive']) {
    assert.ok(await ui(`document.querySelector('.toolbar [data-action="${menu}-menu"]').getClientRects().length > 0`), `${menu} stays visible at minimum width`);
    assert.equal(await ui(`document.querySelector('#toolbar-overflow [data-action="${menu}-menu"]')`), null);
  }
  if (process.env.LEKH_SCREENSHOT) {
    await clickControl('[data-action="format-menu"]');
    const narrow = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'toolbar-narrow-overflow.png'), Buffer.from(narrow.data, 'base64'));
    await clickControl('[data-action="format-menu"]');
  }
  await main.evaluate("smokeElectron.BrowserWindow.getAllWindows()[0].setSize(1320,900)");
  await delay(300);
  if (process.env.LEKH_SCREENSHOT || process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
    await caretIn('First paragraph.');
    await pressKey('End', 35, 2);
    await pressKey('Enter', 13, 0, '\r');
    await browser.call('Input.insertText', { text: '/' }, sessionId);
    await waitFor(async () => ui("!document.querySelector('#slash-results').hidden"), 'slash screenshot');
    await ui("document.querySelector('#notification').hidden=true");
    const slash = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    if (process.env.LEKH_SCREENSHOT) {
      await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'slash-menu.png'), Buffer.from(slash.data, 'base64'));
    }
    if (process.env.LEKH_PUBLIC_SCREENSHOTS === '1') {
      await writeFile(path.join(root, 'docs', 'images', 'slash-menu.png'), Buffer.from(slash.data, 'base64'));
    }
    await pressKey('Escape', 27);
  }
  if (process.env.LEKH_SCREENSHOT) {
    await menuAction('command-palette');
    const palette = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), 'command-palette.png'), Buffer.from(palette.data, 'base64'));
    await pressKey('Escape', 27);
    await browser.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 330 }, sessionId);
    for (const theme of ['light', 'dark']) {
      await menuAction(`theme:${theme}`);
      await delay(200);
      const full = await browser.call('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(path.join(path.dirname(process.env.LEKH_SCREENSHOT), `grouped-toolbar-${theme}.png`), Buffer.from(full.data, 'base64'));
    }
  }
  await main.evaluate('smokeChoice = 1');
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  console.log('PASS: grouped toolbar overflow keeps whole groups and command search reachable at the minimum window size');

  await action('source');
  await sourceEdit('# Final unsaved draft');
  await main.evaluate('smokeChoice = 2');
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  assert.equal(await ui("document.querySelector('#source-editor').value"), '# Final unsaved draft');
  await main.evaluate('smokeChoice = 0; smokeSavePath = null');
  await menuAction('close-tab');
  assert.equal(await tabCount(), 1);
  assert.equal(await ui("document.querySelector('#source-editor').value"), '# Final unsaved draft');
  const remainingWindows = await main.evaluate("smokeElectron.BrowserWindow.getAllWindows().map(window=>({id:window.id,visible:window.isVisible(),url:window.webContents.getURL()}))");
  assert.equal(remainingWindows.length, 1, `Unexpected windows remain before the final close: ${JSON.stringify(remainingWindows)}`);
  await main.evaluate(`for (const event of ['window-all-closed','before-quit','will-quit','quit']) {
    smokeElectron.app.once(event, () => process.stdout.write('SMOKE_' + event + '\\n'));
  }
  smokeChoice = 1; smokeElectron.BrowserWindow.getAllWindows()[0].once('closed', () => process.stdout.write('SMOKE_LAST_TAB_CLOSED\\n')); smokeElectron.BrowserWindow.getAllWindows()[0].webContents.send('app:action', 'close-tab')`);
  await waitFor(() => log.includes('SMOKE_LAST_TAB_CLOSED'), 'actual final-tab window closure');
  for (const client of clients) client.socket.close();
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'normal application exit after final tab', 15000);
  assert.equal(child.exitCode, 0, `Application exited with code ${child.exitCode} / signal ${child.signalCode}`);
  console.log('PASS: final-tab Cancel and canceled Save As retain edits; Discard closes the actual window and exits the application normally');
  console.log('Desktop smoke checks passed.');
}

try {
  await runChecks();
} catch (error) {
  console.error(error);
  console.error(log);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.socket.close();
  child.kill();
  await new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else { child.once('exit', resolve); setTimeout(resolve, 5000).unref(); }
  });
  await delay(1000);
  try {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (error) {
    console.error(`Could not clean the isolated desktop-test directory ${temporary}:`, error);
    process.exitCode = 1;
  }
}
