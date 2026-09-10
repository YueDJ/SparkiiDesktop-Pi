import { basename } from 'node:path';
import { stdin, stdout } from 'node:process';

stdin.setEncoding('utf8');

let rest = '';

function writeFrame(frame) {
  stdout.write(`${JSON.stringify(frame)}\n`);
}

function handle(frame) {
  if (!frame || typeof frame !== 'object') return;
  if (frame.method === 'parse') {
    writeFrame({ id: frame.id, method: 'progress', params: { page: 1, total: 1 } });
    const name = basename(typeof frame.params?.path === 'string' ? frame.params.path : '');
    writeFrame({
      id: frame.id,
      result: {
        markdown: `# fake\n${name}`,
        pages: [{ page: 1, score: 0.91 }],
      },
    });
    return;
  }
  if (frame.method === 'shutdown') {
    stdout.write('', () => {
      process.exit(0);
    });
  }
}

stdin.on('data', (chunk) => {
  rest += chunk;
  const parts = rest.split('\n');
  rest = parts.pop() ?? '';
  for (const line of parts) {
    if (line.trim().length === 0) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    handle(frame);
  }
});
