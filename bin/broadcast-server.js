#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startServer, DEFAULT_PORT } from '../src/server.js';
import { runClient } from '../src/client.js';

const USAGE = `Usage:
  broadcast-server start   [--port <port>] [--host <host>]
  broadcast-server connect [--port <port>] [--host <host>] [--name <name>]

Commands:
  start      Start the broadcast server
  connect    Connect to a server as an interactive client

Options:
  -p, --port <port>   Port to listen on / connect to (default: $PORT or ${DEFAULT_PORT})
      --host <host>   Interface to bind (start, default: all) or server host (connect, default: localhost)
  -n, --name <name>   Display name shown to other clients (connect only)
  -h, --help          Show this help`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string' },
      name: { type: 'string', short: 'n' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command] = positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    console.error(USAGE);
    return 1;
  }

  const port = parsePort(values.port ?? process.env.PORT ?? DEFAULT_PORT);

  switch (command) {
    case 'start':
      return start({ port, host: values.host });
    case 'connect':
      return runClient({ url: `ws://${values.host ?? 'localhost'}:${port}`, name: values.name });
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

async function start({ port, host }) {
  let server;
  try {
    server = await startServer({ port, host });
  } catch (err) {
    if (err.code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use`);
    throw err;
  }

  console.log(`Broadcast server listening on ws://${host ?? 'localhost'}:${server.port}`);
  console.log('Press Ctrl+C to stop.');

  return new Promise((resolve) => {
    let stopping = false;

    const shutdown = async (signal) => {
      if (stopping) {
        console.log('Forcing exit.');
        process.exit(1);
      }
      stopping = true;
      console.log(`\nReceived ${signal}, disconnecting ${server.clientCount} client(s)...`);
      await server.close();
      console.log('Server stopped.');
      resolve(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`Invalid port "${value}"`);
  }
  return port;
}

class UsageError extends Error {}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`Error: ${err.message}`);
    if (err instanceof UsageError || err.code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`\n${USAGE}`);
    }
    process.exitCode = 1;
  },
);
