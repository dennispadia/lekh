import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageBoxQueue, validMessageResponse, type AppMessageBox } from '../lib/message-box.js';

const message = (id: string): AppMessageBox => ({
  id, title: 'Lekh', type: 'question', message: 'Allow shared files?', detail: '',
  buttons: ['Allow folder', 'Not now'], defaultId: 1, cancelId: 1,
});

test('message dialogs wait for renderer readiness and deliver one request at a time', async () => {
  const sent: string[] = [];
  const queue = new MessageBoxQueue(item => sent.push(item.id));
  const first = queue.request(message('first'));
  const second = queue.request(message('second'));
  queue.answer('first', 0);
  assert.deepEqual(sent, []);
  queue.setReady(); queue.setReady();
  assert.deepEqual(sent, ['first']);
  for (const response of [-1, 2, 0.5, '0', null, NaN]) queue.answer('first', response);
  queue.answer('different', 0);
  assert.deepEqual(sent, ['first']);
  queue.answer('first', 0);
  assert.equal(await first, 0);
  assert.deepEqual(sent, ['first', 'second']);
  queue.answer('first', 1);
  queue.answer('second', 1);
  assert.equal(await second, 1);
});

test('reload, crash and window closure cancel all requests without granting permission', async () => {
  const sent: string[] = [];
  const queue = new MessageBoxQueue(item => sent.push(item.id));
  queue.setReady();
  const first = queue.request(message('first'));
  const second = queue.request(message('second'));
  queue.cancel();
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  const third = queue.request(message('third'));
  queue.answer('first', 0);
  assert.deepEqual(sent, ['first']);
  queue.setReady();
  assert.deepEqual(sent, ['first', 'third']);
  queue.answer('third', 0);
  assert.equal(await third, 0);
  queue.cancel();
});

test('message answers require the exact request identity and a valid button index', () => {
  assert.equal(validMessageResponse(message('id'), 'id', 0), true);
  assert.equal(validMessageResponse(message('id'), 'id', 1), true);
  assert.equal(validMessageResponse(message('id'), {}, 0), false);
  assert.equal(validMessageResponse(message('id'), 'id', Infinity), false);
});
