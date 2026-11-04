import { ipcMain, type BrowserWindow, type IpcMainEvent, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron';
import { randomUUID } from 'node:crypto';
import { MessageBoxQueue } from '../lib/message-box.js';
const queues = new WeakMap<BrowserWindow, MessageBoxQueue>();

export function installMessageDialogs(window: BrowserWindow): void {
  const queue = new MessageBoxQueue(message => window.webContents.send('app:message-box', message));
  queues.set(window, queue);
  const validSender = (event: IpcMainEvent) => !window.isDestroyed()
    && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const onReady = (event: IpcMainEvent) => { if (validSender(event)) queue.setReady(); };
  const onResponse = (event: IpcMainEvent, id: unknown, response: unknown) => { if (validSender(event)) queue.answer(id, response); };
  ipcMain.on('app:message-box-ready', onReady);
  ipcMain.on('app:message-box-response', onResponse);
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
    if (mainFrame && !inPlace) queue.cancel();
  });
  window.webContents.on('render-process-gone', () => queue.cancel());
  window.on('closed', () => {
    queue.cancel();
    queues.delete(window);
    ipcMain.removeListener('app:message-box-ready', onReady);
    ipcMain.removeListener('app:message-box-response', onResponse);
  });
}

export const appDialogs = {
  showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<MessageBoxReturnValue> {
    const queue = queues.get(window);
    if (!queue || window.isDestroyed()) return Promise.reject(new Error('The dialog window is unavailable.'));
    const buttons = options.buttons?.length ? [...options.buttons] : ['OK'];
    const defaultId = options.defaultId ?? 0;
    const cancelId = options.cancelId ?? Math.max(0, buttons.findIndex(button => /^(?:cancel|not now)$/i.test(button)));
    if (![defaultId, cancelId].every(id => Number.isInteger(id) && id >= 0 && id < buttons.length)) {
      return Promise.reject(new Error('Invalid message dialog button configuration.'));
    }
    return queue.request({
      id: randomUUID(), title: options.title ?? 'Lekh', message: options.message,
      detail: options.detail ?? '', type: options.type === 'warning' || options.type === 'error' || options.type === 'question' ? options.type : 'info',
      buttons, defaultId, cancelId,
    }).then(response => ({ response, checkboxChecked: false }));
  },
};
