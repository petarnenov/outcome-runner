// Runs one default OpenSpec preflight effect so tests can observe exactly what reaches this process's stdout and stderr.
import { defaultPreflightDeps } from '../../src/openspec-preflight.ts';

const [mode, program, ...args] = process.argv.slice(2);
const deps = defaultPreflightDeps();
if (mode === 'ask') {
  const answer = await deps.ask(program);
  process.stdout.write(JSON.stringify({ answer }));
} else {
  const run = mode === 'exec' ? deps.exec : deps.probe;
  const { status } = run(program, args, process.cwd());
  process.exitCode = status === 0 ? 0 : 7;
}
