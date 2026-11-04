import type { AppMessageBox } from '../lib/message-box.js';
import { publishingIcon } from '../lib/publishing-icons.js';

export function installMessageDialog(icon: (name: 'table' | 'split' | 'link' | 'keyboard' | 'help') => string): void {
  for (const heading of document.querySelectorAll('dialog h2')) {
    const id = heading.closest('dialog')?.id ?? '';
    const kind = /image/.test(id) ? 'image' : /include/.test(id) ? 'include' : /variant/.test(id) ? 'selector' : 'note';
    const symbol = /table/.test(id) ? icon('table') : /link/.test(id) ? icon('link')
      : /split/.test(id) ? icon('split') : /shortcuts/.test(id) ? icon('keyboard') : /help/.test(id) ? icon('help') : publishingIcon(kind);
    heading.insertAdjacentHTML('afterbegin', symbol);
    heading.classList.add('dialog-heading');
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'app-message-dialog';
  dialog.setAttribute('aria-labelledby', 'app-message-title');
  dialog.setAttribute('aria-describedby', 'app-message-detail');
  let current: AppMessageBox | undefined;
  let origin: HTMLElement | null = null;
  const respond = (response: number) => {
    if (!current) return;
    const id = current.id;
    current = undefined;
    dialog.close();
    if (origin?.isConnected) origin.focus({ preventScroll: true });
    window.lekh.answerMessageBox(id, response);
  };
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    if (current) respond(current.cancelId);
  });
  document.body.append(dialog);
  window.lekh.onMessageBox(message => {
    if (current?.id === message.id) return;
    current = message;
    origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.replaceChildren();
    dialog.dataset.kind = message.type;
    const heading = document.createElement('div'); heading.className = 'app-message-heading';
    heading.insertAdjacentHTML('beforeend', publishingIcon(message.type === 'error' ? 'caution' : message.type === 'warning' ? 'warning' : message.buttons[0] === 'Allow folder' ? 'include' : 'note'));
    const title = document.createElement('h2'); title.id = 'app-message-title'; title.textContent = message.message;
    heading.append(title);
    const label = document.createElement('p'); label.className = 'dialog-eyebrow'; label.textContent = message.title;
    const detail = document.createElement('div'); detail.id = 'app-message-detail';
    for (const paragraph of message.detail.split(/\n\s*\n/).filter(Boolean)) {
      const node = document.createElement('p'); node.textContent = paragraph; detail.append(node);
    }
    const actions = document.createElement('div'); actions.className = 'dialog-actions';
    for (const [index, caption] of message.buttons.entries()) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = caption;
      button.dataset.response = String(index);
      if (index === message.defaultId) button.className = 'primary';
      button.onclick = () => respond(index);
      actions.append(button);
    }
    dialog.append(label, heading, detail, actions);
    if (!dialog.open) dialog.showModal();
    actions.querySelector<HTMLButtonElement>(`[data-response="${message.defaultId}"]`)?.focus();
  });
}
