import { readFileSync } from 'node:fs';
import { runQueue } from '../../src/runner.mjs';

const pending = new Map(); let sequence = 0;
process.on('message', message => {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error));
  else entry.resolve(message.result);
});
const request = (method, args) => new Promise((resolve, reject) => {
  const id = ++sequence; pending.set(id, { resolve, reject });
  process.send({ type: 'host', id, method, args });
});
try {
  const result = await runQueue(JSON.parse(readFileSync(process.argv[2], 'utf8')), {
    host: Object.fromEntries(['find', 'create', 'merge'].map(method => [method,
      (...args) => request(method, args)])),
    afterEffect: async operation => {
      if (operation === process.argv[3]) {
        process.send({ type: 'boundary', operation }); await new Promise(() => {});
      }
    },
  });
  process.send({ type: 'result', result }); process.disconnect();
} catch (error) {
  process.send({ type: 'error', message: error.message }); process.disconnect(); process.exitCode = 1;
}
