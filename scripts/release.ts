import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type Entry = { description: string; hash: string; level: number };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
}

function compare(a: string, b: string): number {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function breakingFooter(body: string): boolean {
  // Footers begin at a paragraph boundary. Their values may continue across lines.
  const blocks = body.trim().split(/\r?\n\s*\r?\n/);
  const start = blocks.findIndex(block => /^(?:BREAKING CHANGE|[A-Za-z][A-Za-z-]*)(?:: | #)/.test(block));
  return start >= 0 && blocks.slice(start).some(block =>
    /(?:^|\r?\n)(?:BREAKING CHANGE|BREAKING-CHANGE): \S/.test(block));
}

function entries(cwd: string, tag: string | undefined): Entry[] {
  const range = tag ? [`${tag}..HEAD`] : ['HEAD'];
  const hashes = git(cwd, 'rev-list', '--no-merges', ...range).split('\n').filter(Boolean);
  return hashes.flatMap(hash => {
    const message = git(cwd, 'show', '-s', '--format=%B', hash);
    const [subject, ...body] = message.split('\n');
    if (subject.startsWith('chore(release):')) return [];
    const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\([^()\r\n]+\))?(!)?: (\S.*)$/.exec(subject);
    if (!match) return [];
    const level = match[2] || breakingFooter(body.join('\n')) ? 3
      : match[1] === 'feat' ? 2 : ['fix', 'perf'].includes(match[1]) ? 1 : 0;
    return level ? [{ description: match[3], hash: git(cwd, 'rev-parse', '--short', hash), level }] : [];
  });
}

/** Replace selected JSON string tokens, keeping all other original characters intact. */
export function versionTokens(source: string, paths: string[][], version: string): string {
  JSON.parse(source);
  const tokens = [...source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)];
  let cursor = 0;
  const edits: { start: number; end: number }[] = [];
  function value(path: string[]): void {
    const token = tokens[cursor++];
    if (token[0] === '{') {
      while (tokens[cursor][0] !== '}') {
        const key = JSON.parse(tokens[cursor++][0]) as string;
        cursor++; // colon
        value([...path, key]);
        if (tokens[cursor][0] !== ',') break;
        cursor++;
      }
      cursor++;
    } else if (token[0] === '[') {
      let index = 0;
      while (tokens[cursor][0] !== ']') {
        value([...path, String(index++)]);
        if (tokens[cursor][0] !== ',') break;
        cursor++;
      }
      cursor++;
    } else if (paths.some(candidate => JSON.stringify(candidate) === JSON.stringify(path))) {
      if (!token[0].startsWith('"')) throw new Error('Version must be a string');
      edits.push({ start: token.index!, end: token.index! + token[0].length });
    }
  }
  value([]);
  if (edits.length !== paths.length) throw new Error('Missing or duplicate version fields');
  for (const edit of edits.reverse()) {
    source = source.slice(0, edit.start) + JSON.stringify(version) + source.slice(edit.end);
  }
  return source;
}

export function release(cwd: string, dryRun = false, date = new Date()): string {
  const tags = git(cwd, 'tag', '--merged', 'HEAD').split('\n')
    .filter(tag => tag.startsWith('v') && stable.test(tag.slice(1)))
    .sort((a, b) => compare(a.slice(1), b.slice(1)));
  const tag = tags.at(-1);
  const commits = entries(cwd, tag);
  const level = Math.max(0, ...commits.map(commit => commit.level));
  if (tag && !level) return 'no release\n';

  const pkgPath = `${cwd}/package.json`;
  const lockPath = `${cwd}/package-lock.json`;
  const changelogPath = `${cwd}/CHANGELOG.md`;
  const pkg = readFileSync(pkgPath, 'utf8');
  const lock = readFileSync(lockPath, 'utf8');
  let version: string = JSON.parse(pkg).version;
  if (tag) {
    const parts = tag.slice(1).split('.').map(BigInt);
    const component = 3 - level;
    parts[component]++;
    for (let i = component + 1; i < 3; i++) parts[i] = 0n;
    version = parts.join('.');
  }
  if (typeof version !== 'string' || !stable.test(version)) throw new Error('Expected a stable package version');
  const nextPkg = versionTokens(pkg, [['version']], version);
  const nextLock = versionTokens(lock, [['version'], ['packages', '', 'version']], version);
  let section = `## ${version} - ${date.toISOString().slice(0, 10)}\n`;
  for (const [rank, title] of [[3, 'Breaking changes'], [2, 'Features'], [1, 'Fixes']] as const) {
    const group = commits.filter(commit => commit.level === rank);
    if (group.length) section += `\n### ${title}\n\n` +
      group.map(commit => `- ${commit.description} (${commit.hash})\n`).join('');
  }
  if (!dryRun) {
    if (git(cwd, 'status', '--porcelain')) throw new Error('Release requires a clean working tree and index');
    if (git(cwd, 'tag', '--list', `v${version}`)) throw new Error('Release tag already exists');
    // Compute every buffer before the first mutation.
    const old = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
    writeFileSync(pkgPath, nextPkg);
    writeFileSync(lockPath, nextLock);
    writeFileSync(changelogPath, section + (old ? '\n' + old : ''));
    git(cwd, 'add', '--', 'package.json', 'package-lock.json', 'CHANGELOG.md');
    git(cwd, 'commit', '-m', `chore(release): v${version}`, '--', 'package.json', 'package-lock.json', 'CHANGELOG.md');
    git(cwd, 'tag', '-a', `v${version}`, '-m', `v${version}`);
  }
  return version + '\n' + section;
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Usage: node scripts/release.ts [--dry-run]');
    process.stdout.write(release(process.cwd(), process.argv.includes('--dry-run')));
  } catch (error) {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  }
}
