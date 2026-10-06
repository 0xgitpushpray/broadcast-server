import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { runClient, formatMessage } from '../src/client.js';

const silent = { info() {}, error() {} };

function collect(stream) {
  let text = '';
  stream.on('data', (chunk) => (text += chunk));
  return () => text;
}

test('sends typed lines to the server and prints broadcasts', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', logger: silent });
  const input = new PassThrough();
  const output = new PassThrough();
  const printed = collect(output);

  const observer = new WebSocket(`ws://127.0.0.1:${server.port}?name=observer`);
  await new Promise((resolve) => observer.once('message', resolve)); // welcome

  const exited = runClient({ url: `ws://127.0.0.1:${server.port}`, name: 'alice', input, output });

  const received = new Promise((resolve) => {
    observer.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'message') resolve(msg);
    });
  });
  input.write('hello from the cli\n');

  const msg = await received;
  assert.equal(msg.from, 'alice');
  assert.equal(msg.text, 'hello from the cli');

  observer.send('hi alice');
  await waitFor(() => printed().includes('observer: hi alice'));

  input.write('/quit\n');
  assert.equal(await exited, 0);
  assert.match(printed(), /Connected as alice/);
  assert.match(printed(), /Disconnected/);

  observer.close();
  await server.close();
});

test('reports a friendly error when no server is running', async () => {
  const server = await startServer({ port: 0, host: '127.0.0.1', logger: silent });
  const { port } = server;
  await server.close();

  const output = new PassThrough();
  const printed = collect(output);
  const code = await runClient({ url: `ws://127.0.0.1:${port}`, input: new PassThrough(), output });

  assert.equal(code, 1);
  assert.match(printed(), /Could not connect/);
});

test('formats each message type for display', () => {
  assert.equal(formatMessage({ type: 'join', name: 'bob', online: 2 }), '* bob joined (2 online)');
  assert.equal(formatMessage({ type: 'leave', name: 'bob', online: 1 }), '* bob left (1 online)');
  assert.match(
    formatMessage({ type: 'message', from: 'bob', text: 'yo', timestamp: new Date().toISOString() }),
    /^\[.+\] bob: yo$/,
  );
});

async function waitFor(condition, timeout = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}
