import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';

const silent = { info() {}, error() {} };
let server;

beforeEach(async () => {
  server = await startServer({ port: 0, host: '127.0.0.1', logger: silent });
});

afterEach(async () => {
  await server.close();
});

/**
 * Opens a client and waits for its welcome message. Incoming messages are
 * queued so tests can `await client.next()` without racing the socket.
 */
async function connect(port, name, options) {
  const query = name ? `?name=${encodeURIComponent(name)}` : '';
  const ws = new WebSocket(`ws://127.0.0.1:${port}${query}`, options);
  const queue = [];
  const waiters = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });

  const client = {
    ws,
    next: () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r))),
    closed: new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))),
  };
  const failed = new Promise((_, reject) => ws.once('error', reject));
  client.welcome = await Promise.race([client.next(), failed]);
  return client;
}

async function waitFor(condition, timeout = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('greets each client with its name and the online count', async () => {
  const alice = await connect(server.port, 'alice');
  const anon = await connect(server.port);

  assert.equal(alice.welcome.type, 'welcome');
  assert.equal(alice.welcome.name, 'alice');
  assert.equal(alice.welcome.online, 1);
  assert.match(anon.welcome.name, /^user-\d+$/);
  assert.equal(anon.welcome.online, 2);
  assert.equal(server.clientCount, 2);

  alice.ws.close();
  anon.ws.close();
});

test('broadcasts a message to every other connected client', async () => {
  const alice = await connect(server.port, 'alice');
  const bob = await connect(server.port, 'bob');
  const carol = await connect(server.port, 'carol');
  // Drain join notifications.
  await alice.next(); // bob joined
  await alice.next(); // carol joined
  await bob.next(); // carol joined

  alice.ws.send('hello everyone');

  for (const client of [bob, carol]) {
    const msg = await client.next();
    assert.equal(msg.type, 'message');
    assert.equal(msg.from, 'alice');
    assert.equal(msg.text, 'hello everyone');
    assert.ok(!Number.isNaN(Date.parse(msg.timestamp)));
  }

  // The sender does not get its own message back: the next thing alice sees
  // is bob's reply, which proves nothing else was queued before it.
  bob.ws.send('hi alice');
  const reply = await alice.next();
  assert.equal(reply.from, 'bob');
  assert.equal(reply.text, 'hi alice');

  for (const client of [alice, bob, carol]) client.ws.close();
});

test('ignores blank messages', async () => {
  const alice = await connect(server.port, 'alice');
  const bob = await connect(server.port, 'bob');

  alice.ws.send('   ');
  alice.ws.send('real message');

  const msg = await bob.next();
  assert.equal(msg.text, 'real message');

  alice.ws.close();
  bob.ws.close();
});

test('removes disconnected clients and notifies the others', async () => {
  const alice = await connect(server.port, 'alice');
  const bob = await connect(server.port, 'bob');
  await alice.next(); // bob joined

  bob.ws.close();
  const leave = await alice.next();

  assert.deepEqual(leave, { type: 'leave', name: 'bob', online: 1 });
  assert.equal(server.clientCount, 1);

  alice.ws.close();
});

test('rejects binary messages with an error', async () => {
  const alice = await connect(server.port, 'alice');

  alice.ws.send(Buffer.from([1, 2, 3]));
  const msg = await alice.next();

  assert.equal(msg.type, 'error');
  alice.ws.close();
});

test('close() disconnects every client with "going away" and stops accepting connections', async () => {
  const alice = await connect(server.port, 'alice');
  const bob = await connect(server.port, 'bob');

  await server.close();

  for (const client of [alice, bob]) {
    const { code, reason } = await client.closed;
    assert.equal(code, 1001);
    assert.equal(reason, 'Server shutting down');
  }
  assert.equal(server.clientCount, 0);

  await assert.rejects(connect(server.port, 'late'));
});

test('drops clients that stop answering heartbeats', async (t) => {
  const fast = await startServer({ port: 0, host: '127.0.0.1', heartbeatInterval: 50, logger: silent });
  t.after(() => fast.close());
  const zombie = await connect(fast.port, 'zombie', { autoPong: false });

  const { code } = await zombie.closed;

  assert.equal(code, 1006); // terminated without a close handshake
  await waitFor(() => fast.clientCount === 0);
});

test('fails to start when the port is already in use', async () => {
  await assert.rejects(startServer({ port: server.port, host: '127.0.0.1', logger: silent }), {
    code: 'EADDRINUSE',
  });
});
