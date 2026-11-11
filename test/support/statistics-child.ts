import { main } from '../../src/cli.ts';
import { runQueue } from '../../src/runner.ts';
import type { RunOptions } from '../../src/runner.ts';
import type { RunConfig } from '../../src/model.ts';

const [path, root, phase] = process.argv.slice(2);
const signalsBefore = ['SIGINT', 'SIGTERM'].map(signal => process.listenerCount(signal));
let rejectWork: (reason: Error) => void = () => {};
let closes = 0;
const keepAlive = setInterval(() => {}, 1000);
const ready = () => { process.send!({ type: 'ready' }); };
try {
  const code = await main(path, phase === 'append' ? async () => {
    ready();
    await new Promise<void>(resolve => process.once('message', () => resolve()));
    return { status: 'exhausted', accepted: [], remaining: [], completions: {} };
  } : (config: RunConfig, options: RunOptions) => runQueue(config, { ...options,
    openspec: { interactive: phase === 'preflight', probe: () => ({ status: phase === 'preflight' ? 1 : 0 }),
      configPresent: () => true, say: () => {}, ask: async () => { ready(); return new Promise<string>(() => {}); } },
    selection: { interactive: phase === 'selection', recorded: () => null,
      probe: harness => ({ harness, available: true, version: 'scripted-child' }), say: () => {},
      ask: async () => { ready(); return new Promise<string>(() => {}); } },
    createAdapter: () => ({
      probe: () => ({ status: 'interface-ready' }),
      startAction: async () => {
        ready(); return new Promise<never>((_, reject) => {
          rejectWork = reject;
          if (phase === 'race') process.once('message', () => {
            process.emit('SIGINT'); process.emit('SIGTERM'); process.emit('SIGINT');
            reject(new Error('SECRET_RACING_FAILURE'));
          });
        });
      },
      close: () => { closes++; rejectWork(new Error('SECRET_PRIVATE_WORKER_FAILURE')); },
    }),
  }), line => { process.stdout.write(line); }, { cwd: root });
  process.exitCode = code;
  process.send!({ type: 'done', code, closes,
    handlersClean: ['SIGINT', 'SIGTERM'].every((signal, index) => process.listenerCount(signal) === signalsBefore[index]) });
} finally {
  clearInterval(keepAlive);
  process.disconnect();
}
