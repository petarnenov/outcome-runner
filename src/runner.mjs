import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { hash, digest, within, safePath, validateConfig, validateQueue } from './model.mjs';
import { command, git, fileAt, receiptAt, GitHubHost } from './git.mjs';
import { RunStore } from './run-store.mjs';
import { ClaimLedger } from './claims.mjs';
import { CodexFiles, brokerTool } from './codex-files.mjs';
import { resolveHarness, createHarness } from './harness.mjs';

const checkRecords = rows => rows.map(({ command, args, outcome }) => ({ command, args, outcome }));
const reviewRecord = ({ reviewer, outcome }) => ({ reviewer, outcome });
const scopesOverlap = (first, second) => first.some(path =>
  second.some(other => within(path, other) || within(other, path)));

const reportTool = { type: 'function', name: 'outcome_report',
  description: 'Return a private structured result to the automatic controller.',
  inputSchema: { type: 'object', additionalProperties: false,
    properties: { outcome: { type: 'string', enum: ['ready', 'accepted', 'changes-required', 'blocked'] },
      summary: { type: 'string' }, inspected: { type: 'array', items: { type: 'string' } },
      findings: { type: 'array', items: { type: 'string' } } }, required: ['outcome', 'summary', 'findings'] } };

export function packet(root, directory) {
  const paths = ['proposal.md', 'design.md'];
  const walk = path => {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Specification symlink is forbidden');
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) paths.push(child.slice(directory.length + 1));
    }
  };
  walk(`${directory}/specs`);
  if (!paths.some(path => path.startsWith('specs/') && path.endsWith('/spec.md')) ||
      !existsSync(join(root, directory, 'tasks.md'))) throw new Error('Incomplete OpenSpec packet');
  return Object.fromEntries(paths.sort().map(path => {
    const file = `${directory}/${safePath(path)}`;
    if (lstatSync(join(root, file)).isSymbolicLink()) throw new Error('Specification symlink is forbidden');
    const content = readFileSync(join(root, file));
    if (!content.length) throw new Error('Empty OpenSpec artifact');
    return [file, digest(content)];
  }));
}

export async function runQueue(config, { host, createAdapter,
  afterEffect = async () => {}, report = () => {} } = {}) {
  config = await resolveHarness(config);
  validateConfig(config);
  createAdapter ??= options => createHarness(options, config);
  const root = realpathSync(config.root); const project = config.project;
  const primary = dirname(resolve(root, git(root, 'rev-parse', '--git-common-dir')));
  let stateAncestor = resolve(config.stateDirectory); const missing = [];
  while (!existsSync(stateAncestor)) { missing.unshift(stateAncestor.split('/').at(-1)); stateAncestor = dirname(stateAncestor); }
  const statePath = join(realpathSync(stateAncestor), ...missing);
  if (within(statePath, primary)) throw new Error('State must be outside the primary checkout');
  const lockRoot = join(dirname(primary), '.work-queue-locks');
  mkdirSync(lockRoot, { recursive: true, mode: 0o700 });
  const lock = new DatabaseSync(join(lockRoot, `${hash(primary)}.sqlite`));
  let store; let adapter; let stopped = false;
  const ownershipFile = join(lockRoot, `${hash(primary)}-owner.json`);
  const stop = () => { stopped = true; adapter?.close(); };
  try {
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
    if (existsSync(ownershipFile)) {
      const previous = JSON.parse(readFileSync(ownershipFile, 'utf8'));
      if (!previous.released && (previous.identity !== hash(config) ||
          previous.stateDirectory !== resolve(config.stateDirectory))) {
        throw new Error('Another durable invocation owns unfinished work in this repository');
      }
    }
    const ownership = { identity: hash(config), stateDirectory: resolve(config.stateDirectory), released: false };
    const release = () => writeFileSync(ownershipFile, JSON.stringify({ ...ownership, released: true }));
    const refresh = () => {
      git(root, 'fetch', 'origin', project.target);
      const target = git(root, 'rev-parse', `origin/${project.target}`);
      const queue = validateQueue(JSON.parse(fileAt(root, target, project.queue)), project);
      return { target, queue };
    };
    const initial = refresh();
    const ids = config.leaves ?? Object.keys(config.authority.tasks);
    if (!ids.length || ids.some(id => !initial.queue.tasks.some(task => task.id === id) ||
        !config.authority.tasks[id])) throw new Error('Selected outcomes lack authority');
    ids.forEach(id => {
      if (hash(initial.queue.tasks.find(task => task.id === id)) !== config.authority.tasks[id]) {
        throw new Error('Task source differs from frozen authority');
      }
    });
    store = new RunStore(config.stateDirectory, { ...config, root, leaves: ids }, { repositoryRoot: root });
    writeFileSync(ownershipFile, JSON.stringify(ownership), { mode: 0o600 });
    host ??= new GitHubHost(root, project);
    const ledger = new ClaimLedger(root, project.target);
    if (!store.state.claimant) store.update({ claimant: randomUUID() });
    const claimant = store.state.claimant;
    const commitSubject = (type, text) => `${type}(${project.commitScope ?? 'work-queue'}): ${text}${project.commitSuffix ?? ''}`;
    const save = fields => store.update({ current: { ...store.state.current, ...fields } });
    const authorized = (queue, id) => {
      const task = queue.tasks.find(item => item.id === id);
      if (!task || hash(task) !== config.authority.tasks[id]) throw new Error('Task source differs from frozen authority');
      return task;
    };
    const receiptPath = id => `${project.receipts}/${id}.json`;
    const accepted = (target, task) => receiptAt(root, target, receiptPath(task.id),
      hash(task), null);
    const assertWork = work => {
      const { queue } = refresh(); authorized(queue, work.id);
      if (git(work.path, 'branch', '--show-current') !== work.branch) throw new Error('Work branch changed');
      if (work.specification && hash(packet(work.path, work.directory)) !== hash(work.specification)) {
        throw new Error('Exact specification changed after authorization');
      }
      return true;
    };
    const checks = (work, definitions) => definitions.map(check => {
      const args = check.args.map(arg => arg.replaceAll('{change}', work.change)
        .replaceAll('{target}', project.target).replaceAll('{scope}', work.scopes[0]));
      const output = command(work.path, check.command, args);
      return { command: check.command, args, outcome: 'passed', output: output.slice(-16000) };
    });
    const commit = work => {
      git(work.path, 'add', '--', ...work.scopes, work.directory);
      if (git(work.path, 'diff', '--cached', '--name-only')) {
        git(work.path, 'commit', '-m', `feat(${project.commitScope ?? 'work-queue'}): implement ${work.id}${project.commitSuffix ?? ''}`);
      }
    };
    const integrateTarget = (work, target) => {
      if (git(work.path, 'merge-base', target, 'HEAD') === target) return;
      const changed = git(work.path, 'diff', '--name-only', work.base, target).split('\n').filter(Boolean);
      if (scopesOverlap(changed, [...work.scopes, work.directory])) throw new Error('Target changed outcome scope');
      git(work.path, 'merge', '--no-edit', '-m', commitSubject('chore', `integrate ${project.target} into ${work.id}`), target);
      checks(work, project.setup ?? []);
    };
    const session = async (work, purpose, prompt) => {
      let result;
      const files = git(work.path, 'ls-files', '-z').split('\0').filter(Boolean);
      const instructionPaths = [...new Set(['AGENTS.md', ...[...work.scopes, work.directory].flatMap(path =>
        path.split('/').map((_, index, parts) => `${parts.slice(0, index + 1).join('/')}/AGENTS.md`))])];
      const writable = purpose === 'plan' ? [work.directory] : purpose === 'work' ?
        [...work.scopes, `${work.directory}/tasks.md`, `${work.directory}/compliance.md`,
          `${work.directory}/verification.md`] : [];
      const broker = new CodexFiles({ root: work.path,
        scopes: [...files.map(path => ({ path, mode: 'read' })),
          ...instructionPaths.map(path => ({ path, mode: 'read' })), ...work.scopes.map(path => ({ path, mode: 'read' })),
          { path: work.directory, mode: 'read' }, ...writable.map(path => ({ path, mode: 'write' }))],
        store, identity: { id: work.id, operation: work.operation, purpose },
        revalidate: async () => assertWork(store.state.current) });
      adapter = createAdapter({ cwd: work.path, tools: [brokerTool, reportTool],
        onHandle: handle => save({ session: { purpose, ...handle } }),
        handleTool: async (name, input) => {
          if (name === brokerTool.name && input.operation === 'run_checks') {
            if (!['work', 'review'].includes(purpose) || !store.state.current.specification) {
              throw new Error('Product checks require a bound specification');
            }
            assertWork(store.state.current); commit(work);
            const evidence = checks(work, project.checks); save({ checks: evidence });
            return { checks: evidence };
          }
          if (name === brokerTool.name && input.operation === 'context') {
            const offset = input.input?.offset ?? 0;
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid file offset');
            return { files: files.slice(offset, offset + 200),
              nextOffset: offset + 200 < files.length ? offset + 200 : null,
              history: git(work.path, 'log', '-5', '--oneline'),
              diff: git(work.path, 'diff', work.base), findings: store.state.current.findings ?? [],
              checks: store.state.current.checks ?? [] };
          }
          if (name === brokerTool.name) {
            try { return await broker.call(name, input); }
            catch (error) { save({ lastToolError: { purpose, input, message: error.message } }); throw error; }
          }
          if (name === reportTool.name) save({ lastReportAttempt: { purpose, input } });
          if (name !== reportTool.name || !['ready', 'accepted', 'changes-required', 'blocked'].includes(input.outcome) ||
              !input.summary || !Array.isArray(input.findings) ||
              input.findings.some(f => typeof f !== 'string' || !f)) throw new Error('Invalid private report');
          if (purpose === 'investigate' && !input.inspected?.length) throw new Error('Investigation references required');
          result = input; return { status: 'recorded' };
        } });
      try {
        if (adapter.probe().status !== 'interface-ready') throw new Error('Selected harness interface unavailable');
        const reply = await adapter.startAction('OFF. Never ask a person anything. All output is private. ' +
          'Use only backlog_tool operations read_file/write_file/context/run_checks and outcome_report. ' +
          'Read files with input {path}; write with {path,content,expectedHash} from the read result. ' +
          'context takes input {offset} for paginated paths, diff, history and findings. ' +
          'run_checks takes input {} and runs only frozen project checks after specification binding. ' +
          'Read applicable AGENTS.md. Report blockers privately. No shell or approval tools.\n' + prompt);
        save({ sessions: [...(store.state.current.sessions ?? []), {
          purpose, threadId: reply.threadId, events: reply.events, privateText: reply.text }] });
        if (!result || result.outcome === 'blocked') throw new Error(`Worker ${purpose} incomplete`);
        return { ...result, reviewer: `${config.harness}:${reply.threadId}` };
      } finally { adapter.close(); adapter = null; }
    };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const recovery = Object.values(store.state.blocked ?? {}).map(entry => entry.work).filter(Boolean);
    store.update({ blocked: {} });
    for (;;) {
      await yieldLoop();
      const { target, queue } = refresh();
      const completed = { ...(store.state.completed ?? {}) };
      const done = new Set();
      for (const task of queue.tasks) {
        if (ids.includes(task.id)) authorized(queue, task.id);
        if (accepted(target, task)) done.add(task.id);
      }
      if (!store.state.baselineDone) store.update({ baselineDone: [...done] });
      const current = store.state.current;
      if (current && done.has(current.id)) {
        completed[current.id] = { ...current, acceptedTarget: target };
        store.update({ current: null, completed });
        report({ status: 'accepted', id: current.id });
      }
      const newlyAccepted = Object.keys(completed).filter(id => done.has(id) && !store.state.baselineDone.includes(id));
      const remaining = ids.filter(id => !done.has(id));
      if (config.maxAccepted && newlyAccepted.length >= config.maxAccepted) {
        if (!Object.keys(store.state.blocked).length && !store.state.current && !recovery.length) release();
        return { status: 'limit-reached', accepted: newlyAccepted, remaining };
      }
      if (!remaining.length) {
        release();
        return { status: config.maxAccepted ? 'incomplete' : 'exhausted', accepted: newlyAccepted, remaining };
      }
      if (stopped) return { status: 'cancelled', accepted: newlyAccepted, remaining };
      if (!store.state.current && recovery.length) save(recovery.shift());
      let work = store.state.current;
      if (!work) {
        const ledgerSnapshot = ledger.pull();
        const foreignClaims = [...ledgerSnapshot.claims.values()]
          .filter(claim => claim.claimant !== claimant && !done.has(claim.id));
        const task = queue.tasks.filter(task => remaining.includes(task.id) && !store.state.blocked[task.id] &&
          task.dependencies.every(id => done.has(id)) &&
          !foreignClaims.some(claim => claim.id === task.id || scopesOverlap(claim.scopes, task.scopes)) &&
          !Object.values(store.state.blocked).some(entry => entry.work && scopesOverlap(entry.work.scopes, task.scopes)))
          .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))[0];
        if (!task) return { status: 'incomplete', accepted: newlyAccepted, remaining,
          blockers: Object.fromEntries(Object.entries(store.state.blocked).map(([id, entry]) =>
            [id, { stage: entry.work?.stage, reason: 'operation-incomplete',
              diagnostics: join(store.directory, 'state.json') }])),
          claimedElsewhere: Object.fromEntries(foreignClaims.map(claim => [claim.id, { host: claim.host }])) };
        const operation = hash({ invocation: config.invocation, id: task.id, authority: config.authority.reference });
        const branch = `outcome/${task.id}-${operation.slice(0, 12)}`;
        if (!ledgerSnapshot.claims.has(task.id) && !ledger.acquire(ledgerSnapshot, {
          version: 1, id: task.id, taskHash: hash(task), scopes: task.scopes, claimant,
          host: hostname(), branch, claimedAt: new Date().toISOString(),
        }, commitSubject('chore', `claim ${task.id}`))) continue;
        save({ ...task, taskHash: hash(task), operation, stage: 'claim', base: target, branch,
          path: join(dirname(primary), `${primary.split('/').at(-1)}-outcomes`, operation),
          directory: `${project.changes}/${task.change}` });
        work = store.state.current;
      }
      try {
        const prompt = `Task ${work.id}; OpenSpec directory ${work.directory}. ` +
          `Exact source: ${JSON.stringify(authorized(queue, work.id))}\n`;
        if (prompt.length > 65536) throw new Error('Selected outcome prompt is too large');
        if (work.stage === 'claim') {
          if (!existsSync(work.path)) {
            git(root, 'worktree', 'add', '-b', work.branch, work.path, work.base);
            await afterEffect('claim', work);
          }
          if (git(work.path, 'rev-parse', 'HEAD') !== work.base || git(work.path, 'status', '--porcelain')) {
            throw new Error('Initial worktree differs from recorded base');
          }
          save({ stage: 'investigate' });
        }
        if (store.state.current.stage === 'investigate') {
          checks(work, project.setup ?? []);
          const investigation = await session(work, 'investigate', prompt +
            'Inspect current files and history before edits. Call outcome_report with outcome ready, summary, ' +
            'inspected containing actual inspected repository paths, and findings array. Do not edit files. ' +
            'Do not use a final message as a substitute for outcome_report.');
          save({ investigation, stage: 'plan' });
        }
        if (store.state.current.stage === 'plan') {
          let bound = false;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await session(work, 'plan', prompt + 'Create proposal.md, design.md, tasks.md and specs/<capability>/spec.md. ' +
              'Use OpenSpec delta headings and WHEN/THEN scenarios. Stay within task scope; do not edit product files. ' +
              'Address private findings: ' + JSON.stringify(store.state.current.findings ?? []));
            let specification;
            try {
              specification = packet(work.path, work.directory);
              checks(work, [project.planningCheck]);
            } catch (error) {
              save({ findings: [String(error.stderr ?? error.message).slice(-16000)] }); continue;
            }
            const review = await session(work, 'review', prompt +
              'Review planning artifacts independently against exact source criteria, scope and decisions. ' +
              'Report accepted only with zero findings; otherwise changes-required with concrete findings.');
            save({ planningReviews: [...(store.state.current.planningReviews ?? []), review] });
            if (review.outcome === 'accepted' && !review.findings.length) {
              save({ specification, stage: 'work', findings: [] }); bound = true; break;
            }
            save({ findings: review.findings });
          }
          if (!bound) throw new Error('Planning review remains unresolved');
        }
        if (store.state.current.stage === 'work') {
          let passed = false;
          for (let attempt = 0; attempt < 4; attempt += 1) {
            await session(store.state.current, 'work', prompt +
              'Implement all approved OpenSpec scenarios and tests within product scope. Preserve bound specs. ' +
              'Address private findings: ' + JSON.stringify(store.state.current.findings ?? []));
            await afterEffect('implementation', store.state.current);
            assertWork(store.state.current); commit(work);
            try { save({ checks: checks(work, project.checks) }); }
            catch (error) { save({ findings: [String(error.stderr ?? error.message).slice(-16000)] }); continue; }
            const review = await session(store.state.current, 'review', prompt +
              'Review actual implementation independently against every criterion, scope, security and test evidence. ' +
              'Read files and context. Report accepted with zero findings only when complete; otherwise changes-required.');
            save({ reviews: [...(store.state.current.reviews ?? []), review] });
            if (review.outcome === 'accepted' && !review.findings.length) {
              save({ review: { ...review, accepted: true }, stage: 'receipt', findings: [] }); passed = true; break;
            }
            save({ findings: review.findings });
          }
          if (!passed) throw new Error('Implementation checks or review remain unresolved');
        }
        if (store.state.current.stage === 'receipt') {
          const now = store.state.current; assertWork(now);
          const paths = git(work.path, 'diff', '--name-only', work.base, 'HEAD').split('\n').filter(Boolean);
          if (!paths.length || paths.some(path => ![...work.scopes, work.directory].some(scope => within(path, scope)))) {
            throw new Error('Empty or out-of-scope result manifest');
          }
          const manifest = paths.map(path => ({ path, hash: digest(readFileSync(join(work.path, path))) }));
          const receipt = { version: 1, id: work.id, taskHash: work.taskHash,
            authority: config.authority.reference, specification: now.specification,
            review: { ...reviewRecord(now.review), accepted: true }, checks: checkRecords(now.checks), manifest,
            head: git(work.path, 'rev-parse', 'HEAD'), base: work.base };
          const path = join(work.path, receiptPath(work.id)); mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
          git(work.path, 'add', '--', receiptPath(work.id));
          git(work.path, 'commit', '-m', `docs(${project.commitScope ?? 'work-queue'}): record ${work.id} acceptance evidence${project.commitSuffix ?? ''}`);
          save({ stage: 'publish' });
        }
        if (store.state.current.stage === 'publish') {
          assertWork(store.state.current);
          const targetNow = refresh().target;
          integrateTarget(work, targetNow);
          save({ finalChecks: checks(work, project.checks) });
          if (git(work.path, 'status', '--porcelain')) throw new Error('Final checks changed tracked inputs');
          const head = git(work.path, 'rev-parse', 'HEAD');
          git(work.path, 'push', 'origin', `HEAD:refs/heads/${work.branch}`);
          save({ head, testedTarget: targetNow, stage: 'pr' });
        }
        if (store.state.current.stage === 'pr') {
          const now = store.state.current;
          const body = join(store.directory, `${work.id}-pr.md`);
          writeFileSync(body, `Outcome: ${work.id}\nOpenSpec change: ${work.change}\n` +
            `Authority: ${config.authority.reference}\nTested head: ${now.head}\nTarget: ${now.testedTarget}\n` +
            `Checks: ${JSON.stringify(checkRecords(now.finalChecks))}\n` +
            `Reviews: ${JSON.stringify(now.reviews.map(reviewRecord))}\n`);
          let pr = await host.find(work.branch);
          if (!pr) { pr = await host.create(now, body); await afterEffect('pr', pr); }
          if (!pr || pr.state === 'CLOSED') throw new Error('PR unavailable or closed');
          save({ pr, stage: 'merge' });
        }
        if (store.state.current.stage === 'merge') {
          const now = store.state.current; const pr = await host.find(work.branch);
          if (!pr) throw new Error('Recorded PR missing');
          if (pr.state !== 'MERGED') {
            assertWork(now);
            if (refresh().target !== now.testedTarget) { save({ stage: 'publish' }); continue; }
            if (git(work.path, 'rev-parse', 'HEAD') !== now.head || pr.headRefOid !== now.head) {
              throw new Error('Checked head or target changed');
            }
            await host.merge(pr, now.head); await afterEffect('merge', pr);
          }
          const targetNow = refresh().target;
          if (!accepted(targetNow, authorized(refresh().queue, work.id))) throw new Error('Merged result lacks valid receipt');
        }
      } catch (error) {
        if (error.interrupted) throw error;
        store.update({ blocked: { ...store.state.blocked, [work.id]: {
          reason: error.message, work: store.state.current } }, current: null });
        report({ status: 'blocked', id: work.id });
      }
    }
  } finally {
    adapter?.close(); store?.close(); lock.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
