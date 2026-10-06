# broadcast-server

A small CLI WebSocket server and client for real-time broadcast messaging. Start a server, connect as many clients as you like from other terminals, and every message a client sends is instantly relayed to all the others. It works like a stripped-down chat room.

Built as a solution to the [Broadcast Server](https://roadmap.sh/projects/broadcast-server) project on roadmap.sh, to learn how real-time features such as chat apps and live scoreboards work under the hood.

```
$ broadcast-server connect --name alice
Connected as alice (2 online). Type a message and press Enter, /quit to leave.
> hey bob!
> [10:44:05 PM] bob: hi alice 👋
> * carol joined (3 online)
```

## Features

- **Single CLI** with two commands: `start` runs the server and `connect` opens an interactive client.
- **Broadcasts** every message to all other connected clients, with sender name and timestamp.
- **Join and leave notifications** that include the live online count.
- **Handles disconnects gracefully.** Clients are removed from the list as soon as they leave or drop.
- **Heartbeats** (ping/pong every 30s) detect and remove dead, half-open connections.
- **Graceful shutdown.** On Ctrl+C or SIGTERM the server stops accepting connections, closes every client with a "going away" frame, and waits for them before exiting. A second Ctrl+C forces exit.
- **Clear error handling** for a port already in use, a server that isn't running, invalid arguments, binary frames and oversized payloads.
- **One runtime dependency** ([`ws`](https://github.com/websockets/ws)).

## Requirements

- Node.js 20 or newer

## Installation

```bash
git clone https://github.com/<your-username>/broadcast-server.git
cd broadcast-server
npm install
npm link        # makes the `broadcast-server` command available globally
```

If you'd rather not link it globally, replace `broadcast-server` with `node bin/broadcast-server.js` in the examples below.

## Usage

```
broadcast-server start   [--port <port>] [--host <host>]
broadcast-server connect [--port <port>] [--host <host>] [--name <name>]
```

| Option | Description | Default |
| --- | --- | --- |
| `-p, --port` | Port to listen on (`start`) or connect to (`connect`) | `$PORT` or `8080` |
| `--host` | Interface to bind (`start`) or server host (`connect`) | all interfaces / `localhost` |
| `-n, --name` | Display name shown to other clients | `user-<id>` |
| `-h, --help` | Show help | |

### Try it

Terminal 1: start the server.

```bash
broadcast-server start
# Broadcast server listening on ws://localhost:8080
```

Terminals 2, 3, …: connect clients.

```bash
broadcast-server connect --name alice
broadcast-server connect --name bob
```

Type a message and press **Enter** to broadcast it. Leave with `/quit`, **Ctrl+C** or **Ctrl+D**. Stop the server with **Ctrl+C** and every client is notified and disconnected cleanly.

## How it works

```
             ┌──────────── broadcast-server ────────────┐
alice ──ws──▶│  clients: Map<WebSocket, {id, name}>     │──ws──▶ bob
             │  on message → send to every other client │──ws──▶ carol
             └──────────────────────────────────────────┘
```

1. **Connect.** The server stores each new connection in a `Map` together with its id and name, sends it a `welcome`, and tells everyone else it `join`ed.
2. **Message.** Text a client sends is trimmed, wrapped with sender and timestamp, and sent to every *other* open connection. The sender already sees what they typed, so it isn't echoed back.
3. **Disconnect.** When a socket closes (cleanly or not), it is removed from the map and the others get a `leave` event.
4. **Heartbeat.** Every 30s the server pings each client. Any client that didn't answer the previous ping is terminated. This catches connections that died without a close frame (network loss, sleeping laptop).
5. **Shutdown.** `close()` stops the listener, sends close code `1001 Going Away` to every client, force-terminates stragglers after 3s, and resolves once everything is closed.

### Protocol

Clients send **plain text** frames. The server sends **JSON** frames:

| `type` | Fields | When |
| --- | --- | --- |
| `welcome` | `id`, `name`, `online` | Sent to a client right after it connects |
| `join` | `name`, `online` | Another client connected |
| `leave` | `name`, `online` | Another client disconnected |
| `message` | `from`, `text`, `timestamp` | Another client sent a message |
| `error` | `text` | The client sent something invalid (e.g. a binary frame) |

The client name is passed as a query parameter (`ws://localhost:8080?name=alice`), so any WebSocket client can join. For example, with [`wscat`](https://github.com/websockets/wscat):

```bash
npx wscat -c "ws://localhost:8080?name=wscat"
```

## Development

```bash
npm test
```

The tests use Node's built-in test runner. They start real servers on random ports and cover broadcasting, join/leave events, disconnect cleanup, heartbeat timeouts, graceful shutdown, port conflicts and the interactive client.

```
bin/broadcast-server.js   CLI entry point (argument parsing, signal handling)
src/server.js             WebSocket server: client registry, broadcast, heartbeat, shutdown
src/client.js             Interactive terminal client
test/                     node:test suites
```

## License

[MIT](LICENSE)
