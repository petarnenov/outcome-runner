import { readFileSync } from 'node:fs';
import { runQueue } from '../../src/runner.ts';
import type { PullRequestHost } from '../../src/runner.ts';

interface PendingRequest { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
interface HostReply { id: number; error?: string; result?: unknown }

const pending = new Map<number, PendingRequest>(); let sequence = 0;
process.on('message', ((message: HostReply) => {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.result);
}) as NodeJS.MessageListener);
const request = (method: string, args: unknown[]) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  process.send!({ type: 'host', id, method, args });
});
try {
  const result = await runQueue(JSON.parse(readFileSync(process.argv[2], 'utf8')), {
    host: Object.fromEntries(['find', 'create', 'merge'].map(method => [method,
      (...args: unknown[]) => request(method, args)])) as unknown as PullRequestHost,
    afterEffect: async operation => {
      if (operation === process.argv[3]) {
        process.send!({ type: 'boundary', operation }); await new Promise(() => {});
      }
    },
  });
  process.send!({ type: 'result', result }); process.disconnect();
} catch (error) {
  process.send!({ type: 'error', message: (error as Error).message }); process.disconnect(); process.exitCode = 1;
}
