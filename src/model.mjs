import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])])) : value;
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function safePath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') ||
      /[\\\x00-\x1f*?\[\]]/u.test(path) ||
      path.split('/').some(part => !part || ['.', '..', '.git'].includes(part))) {
    throw new Error('Expected a safe repository-relative path');
  }
  return path;
}
export const within = (path, scope) => path === scope || path.startsWith(`${scope}/`);
export function validateQueue(queue, project) {
  const protectedPaths = project ? [project.queue, project.receipts, project.changes] : [];
  if (queue?.version !== 1 || !Array.isArray(queue.tasks) || !queue.tasks.length) {
    throw new Error('Expected a nonempty version 1 outcome queue');
  }
  const ids = new Set(); const changes = new Set();
  for (const task of queue.tasks) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(task.id ?? '') || ids.has(task.id) ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(task.change ?? '') || changes.has(task.change) ||
        typeof task.title !== 'string' || !task.title ||
        !Array.isArray(task.criteria) || !task.criteria.length ||
        task.criteria.some(value => typeof value !== 'string' || !value) ||
        !Array.isArray(task.scopes) || !task.scopes.length ||
        !Array.isArray(task.dependencies) || !Number.isSafeInteger(task.priority)) {
      throw new Error('Invalid or duplicate outcome definition');
    }
    task.scopes.forEach(path => {
      safePath(path);
      if (protectedPaths.some(protectedPath =>
        within(path, protectedPath) || within(protectedPath, path))) {
        throw new Error('Product scope overlaps queue or controller artifacts');
      }
    });
    ids.add(task.id); changes.add(task.change);
  }
  const visiting = new Set(); const visited = new Set();
  const visit = id => {
    if (!ids.has(id) || visiting.has(id)) throw new Error('Unknown or cyclic outcome dependency');
    if (visited.has(id)) return;
    visiting.add(id);
    queue.tasks.find(task => task.id === id).dependencies.forEach(visit);
    visiting.delete(id); visited.add(id);
  };
  ids.forEach(visit); return queue;
}
export function validateConfig(config) {
  const project = config.project;
  if ((config.mode ?? 'OFF') !== 'OFF' || !config.root || !config.stateDirectory ||
      !config.invocation || !config.authority?.reference || !config.authority?.instruction ||
      !project || !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/u.test(project.target ?? '') ||
      project.target.includes('..') || project.target.endsWith('/') ||
      config.authority.target !== project.target || !config.authority.tasks ||
      config.maxAccepted !== undefined && (!Number.isSafeInteger(config.maxAccepted) || config.maxAccepted < 1)) {
    throw new Error('Invalid OFF configuration or authority');
  }
  if (project.commitScope !== undefined && !/^[a-z0-9][a-z0-9-]*$/u.test(project.commitScope) ||
      project.commitSuffix !== undefined && (typeof project.commitSuffix !== 'string' || /[\r\n]/u.test(project.commitSuffix))) {
    throw new Error('Invalid project commit metadata');
  }
  [project.queue, project.changes, project.receipts].forEach(safePath);
  if (!Array.isArray(project.checks) || !project.checks.length || !project.planningCheck) {
    throw new Error('Planning and result checks are mandatory');
  }
  for (const check of [...project.checks, project.planningCheck, ...(project.setup ?? [])]) {
    if (!check || typeof check.command !== 'string' || !check.command ||
        !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string')) {
      throw new Error('Commands must be fixed executable and argument arrays');
    }
  }
  return config;
}
