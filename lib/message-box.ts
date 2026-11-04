export interface AppMessageBox {
  id: string;
  title: string;
  message: string;
  detail: string;
  type: 'info' | 'question' | 'warning' | 'error';
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

export function validMessageResponse(message: AppMessageBox, id: unknown, response: unknown): response is number {
  return id === message.id && typeof response === 'number' && Number.isInteger(response)
    && response >= 0 && response < message.buttons.length;
}

export class MessageBoxQueue {
  private pending: { message: AppMessageBox; resolve: (response: number) => void }[] = [];
  private ready = false;
  private delivered = false;
  constructor(private readonly send: (message: AppMessageBox) => void) {}
  request(message: AppMessageBox): Promise<number> {
    return new Promise(resolve => { this.pending.push({ message, resolve }); this.deliver(); });
  }
  setReady(): void { this.ready = true; this.deliver(); }
  answer(id: unknown, response: unknown): void {
    const first = this.pending[0];
    if (!first || !this.delivered || !validMessageResponse(first.message, id, response)) return;
    this.pending.shift();
    this.delivered = false;
    first.resolve(response);
    this.deliver();
  }
  cancel(): void {
    this.ready = false;
    this.delivered = false;
    for (const pending of this.pending.splice(0)) pending.resolve(pending.message.cancelId);
  }
  private deliver(): void {
    if (this.ready && !this.delivered && this.pending[0]) {
      this.delivered = true;
      this.send(this.pending[0].message);
    }
  }
}
