// Thin socket client: one request per connection.
import net from 'node:net';
import type { Envelope, Reply } from '../core/types';

export function request(socket: string, env: Envelope, timeoutMs = 5000): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socket);
    let buf = '';
    const t = setTimeout(() => { sock.destroy(); reject(new Error('Claude Glass did not respond (timeout)')); }, timeoutMs);
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(JSON.stringify(env) + '\n'));
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => {
      clearTimeout(t);
      try { resolve(JSON.parse(buf)); } catch { reject(new Error(`bad reply from Claude Glass: ${buf.slice(0, 200)}`)); }
    });
    sock.on('error', (e: any) => {
      clearTimeout(t);
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? new Error('Claude Glass is not open for this session (run: claude-glass open)') : e);
    });
  });
}
