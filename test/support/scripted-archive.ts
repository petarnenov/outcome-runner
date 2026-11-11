import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandRunner } from '../../src/runner.ts';

export interface ArchiveCall { cwd: string; program: string; args: string[] }

export interface ScriptedArchiveOptions {
  /** Every invocation is recorded here; the real openspec is never executed. */
  calls?: ArchiveCall[];
  changes?: string;
  date?: string;
  /** Where the delta of one capability is applied; the default mirrors OpenSpec: openspec/specs/<capability>/spec.md. */
  specPath?: (change: string, capability: string) => string;
  /** When set, the command fails with this text on stderr. */
  fail?: string;
  /** Runs after the relocation, for example to alter an archived file. */
  after?: (cwd: string, archived: string) => void;
}

export const archiveDate = (): string => new Date().toISOString().slice(0, 10);

/** A scripted `openspec archive <change> --yes`: it relocates the change and applies each delta as the spec. */
export function scriptedArchive(options: ScriptedArchiveOptions = {}): CommandRunner {
  return (cwd, program, args) => {
    options.calls?.push({ cwd, program, args: [...args] });
    if (options.fail !== undefined) {
      throw Object.assign(new Error('Command failed: scripted archive'), { stderr: options.fail });
    }
    const change = args[1];
    const changes = options.changes ?? 'openspec/changes';
    const source = join(cwd, changes, change);
    const archived = `${changes}/archive/${options.date ?? archiveDate()}-${change}`;
    for (const capability of readdirSync(join(source, 'specs'))) {
      const path = join(cwd, options.specPath?.(change, capability) ?? `openspec/specs/${capability}/spec.md`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(source, 'specs', capability, 'spec.md')));
    }
    mkdirSync(join(cwd, changes, 'archive'), { recursive: true });
    renameSync(source, join(cwd, archived));
    options.after?.(cwd, archived);
    return `Archived ${change}`;
  };
}

/** The archive used by general scripted runs: each change writes its own spec file, so parallel tasks never overlap. */
export const separateArchive = (): CommandRunner =>
  scriptedArchive({ specPath: (change, capability) => `openspec/specs/${change}-${capability}/spec.md` });
