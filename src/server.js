import { WebSocketServer, WebSocket } from 'ws';

export const DEFAULT_PORT = 8080;

const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 32;
const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * Starts a WebSocket broadcast server.
 *
 * Resolves once the server is listening with a handle exposing the bound port,
 * the live client count and a `close()` method for graceful shutdown.
 * Rejects if the server cannot bind (e.g. EADDRINUSE).
 */
export function startServer({
  port = DEFAULT_PORT,
  host,
  heartbeatInterval = 30_000,
  logger = console,
} = {}) {
  /** @type {Map<WebSocket, { id: number, name: string, isAlive: boolean }>} */
  const clients = new Map();
  let nextId = 1;
  let heartbeat;
  let closing = null;

  const wss = new WebSocketServer({ port, host, maxPayload: MAX_PAYLOAD_BYTES });

  function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }

  function broadcast(payload, exclude) {
    const data = JSON.stringify(payload);
    for (const ws of clients.keys()) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  wss.on('connection', (ws, req) => {
    if (closing) {
      ws.close(1001, 'Server shutting down');
      return;
    }

    const id = nextId++;
    const name = parseName(req.url) ?? `user-${id}`;
    const client = { id, name, isAlive: true };
    clients.set(ws, client);
    logger.info(`+ ${name} connected (${clients.size} online)`);

    send(ws, { type: 'welcome', id, name, online: clients.size });
    broadcast({ type: 'join', name, online: clients.size }, ws);

    ws.on('pong', () => {
      client.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        send(ws, { type: 'error', text: 'Binary messages are not supported' });
        return;
      }
      const text = data.toString().trim();
      if (!text) return;

      logger.info(`${name}: ${text}`);
      broadcast({ type: 'message', from: name, text, timestamp: new Date().toISOString() }, ws);
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info(`- ${name} disconnected (${clients.size} online)`);
      if (!closing) broadcast({ type: 'leave', name, online: clients.size });
    });

    // Socket errors (e.g. oversized payloads, abrupt resets) are followed by
    // 'close', so logging here is enough; the client is removed there.
    ws.on('error', (err) => logger.error(`! ${name}: ${err.message}`));
  });

  // Ping every client periodically and drop the ones that never answered the
  // previous ping, so half-open connections don't linger in the client list.
  function checkHeartbeats() {
    for (const [ws, client] of clients) {
      if (!client.isAlive) {
        logger.info(`- ${client.name} timed out`);
        ws.terminate();
        continue;
      }
      client.isAlive = false;
      ws.ping();
    }
  }

  function close() {
    if (closing) return closing;

    closing = (async () => {
      clearInterval(heartbeat);
      const serverClosed = new Promise((resolve) => wss.close(() => resolve()));

      const clientsClosed = [...clients.keys()].map(
        (ws) =>
          new Promise((resolve) => {
            ws.once('close', resolve);
            ws.close(1001, 'Server shutting down');
          }),
      );
      // Clients that don't complete the close handshake in time are cut off.
      const force = setTimeout(() => {
        for (const ws of clients.keys()) ws.terminate();
      }, SHUTDOWN_TIMEOUT_MS);

      await Promise.all(clientsClosed);
      clearTimeout(force);
      await serverClosed;
    })();

    return closing;
  }

  return new Promise((resolve, reject) => {
    const onStartupError = (err) => {
      wss.close();
      reject(err);
    };
    wss.once('error', onStartupError);

    wss.once('listening', () => {
      wss.off('error', onStartupError);
      wss.on('error', (err) => logger.error(`! server: ${err.message}`));

      heartbeat = setInterval(checkHeartbeats, heartbeatInterval);
      heartbeat.unref();

      resolve({
        port: wss.address().port,
        get clientCount() {
          return clients.size;
        },
        close,
      });
    });
  });
}

function parseName(reqUrl) {
  const raw = new URL(reqUrl ?? '/', 'http://localhost').searchParams.get('name');
  const name = raw?.replace(/\p{C}/gu, '').trim().slice(0, MAX_NAME_LENGTH);
  return name || undefined;
}
