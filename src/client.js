import readline from 'node:readline';
import WebSocket from 'ws';

/**
 * Connects to a broadcast server and bridges it to an interactive prompt:
 * each line typed is sent to the server, and every broadcast received is
 * printed above the prompt.
 *
 * Resolves with an exit code once the connection is closed.
 */
export function runClient({ url, name, input = process.stdin, output = process.stdout }) {
  return new Promise((resolve) => {
    const target = new URL(url);
    if (name) target.searchParams.set('name', name);

    const ws = new WebSocket(target);
    let rl;
    let opened = false;
    let exitCode = 0;

    // Print a line without mangling whatever the user is currently typing.
    function print(line) {
      if (rl && output.isTTY) {
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
      }
      output.write(`${line}\n`);
      rl?.prompt(true);
    }

    ws.on('open', () => {
      opened = true;
      rl = readline.createInterface({ input, output, prompt: '> ' });

      rl.on('line', (line) => {
        const text = line.trim();
        if (text === '/quit') {
          rl.close();
          return;
        }
        if (text) ws.send(text);
        rl.prompt();
      });

      // Ctrl+C, Ctrl+D and /quit all end the session with a clean close.
      rl.on('SIGINT', () => rl.close());
      rl.on('close', () => ws.close(1000, 'Client left'));
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        print(data.toString());
        return;
      }
      print(formatMessage(msg));
    });

    ws.on('error', (err) => {
      exitCode = 1;
      const reason =
        err.code === 'ECONNREFUSED'
          ? `Could not connect to ${url}. Is the server running?`
          : err.message || err.code;
      output.write(`Connection error: ${reason}\n`);
    });

    ws.on('close', (code, reason) => {
      if (opened) {
        rl.close();
        if (output.isTTY) output.write('\n');
        output.write(`Disconnected${reason.length ? `: ${reason}` : ''}\n`);
        if (code !== 1000 && code !== 1001) exitCode = 1;
      }
      resolve(exitCode);
    });
  });
}

export function formatMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      return `Connected as ${msg.name} (${msg.online} online). Type a message and press Enter, /quit to leave.`;
    case 'join':
      return `* ${msg.name} joined (${msg.online} online)`;
    case 'leave':
      return `* ${msg.name} left (${msg.online} online)`;
    case 'message': {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      return `[${time}] ${msg.from}: ${msg.text}`;
    }
    case 'error':
      return `! ${msg.text}`;
    default:
      return JSON.stringify(msg);
  }
}
