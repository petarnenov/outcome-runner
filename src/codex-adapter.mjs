import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export const codexRestrictions = {
  'approval_policy': 'never', 'web_search': 'disabled', 'agents.enabled': false,
  'features.shell_tool': false, 'features.apps': false, 'features.plugins': false,
  'features.image_generation': false, 'features.computer_use': false,
  'features.browser_use': false, 'features.in_app_browser': false,
  'features.hooks': false, 'features.skill_search': false,
  'features.skill_mcp_dependency_install': false, 'features.request_permissions_tool': false,
  'features.goals': false, 'features.view_image': false,
};

export function codexEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_CI'].includes(name)));
}

export class CodexAdapter {
  constructor({ cwd, tools, handleTool, onHandle = async () => {}, executable = 'codex',
    model = null, effort = null, mcpServers = [], spawnProcess = spawn, environment = process.env }) {
    this.model = model; this.effort = effort;
    this.cwd = cwd; this.tools = tools; this.handleTool = handleTool; this.onHandle = onHandle;
    this.executable = executable; this.mcpServers = mcpServers; this.spawnProcess = spawnProcess;
    this.environment = codexEnvironment(environment);
    this.pending = new Map(); this.sequence = 0; this.events = [];
  }

  probe() {
    const version = execFileSync(this.executable, ['--version'], {
      encoding: 'utf8', timeout: 10000, env: this.environment }).trim();
    if (version !== 'codex-cli 0.167.0') return { status: 'unavailable', reason: 'uncertified-codex-version', version };
    return { status: 'interface-ready', version };
  }

  send(value) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  rpc(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Codex RPC observation timed out'), { code: 'ETIMEDOUT' }));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async connect() {
    const args = ['app-server', '--stdio', '--strict-config'];
    if (this.model) args.push('-c', `model=${JSON.stringify(this.model)}`);
    if (this.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(this.effort)}`);
    for (const [key, value] of Object.entries(codexRestrictions)) {
      args.push('-c', `${key}=${JSON.stringify(value)}`);
    }
    for (const name of this.mcpServers) {
      if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('Unresolved MCP configuration name');
      args.push('-c', `mcp_servers.${name}.enabled=false`);
    }
    this.child = this.spawnProcess(this.executable, args, {
      cwd: this.cwd, env: this.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)).catch(error => this.fail(error)); }
      catch { this.fail(new Error('Malformed Codex transport')); }
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => this.fail(Object.assign(new Error('Codex transport exited'), { code: 'ECONNRESET' })));
    await this.rpc('initialize', { clientInfo: { name: 'backlog_off', version: '2' },
      capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }

  fail(error) {
    for (const promise of this.pending.values()) { clearTimeout(promise.timer); promise.reject(error); }
    this.pending.clear();
    this.turn?.reject(error); this.turn = null;
  }

  async receive(message) {
    if (message.id !== undefined && !message.method) {
      const promise = this.pending.get(message.id);
      if (!promise) return;
      this.pending.delete(message.id);
      clearTimeout(promise.timer);
      if (message.error) promise.reject(Object.assign(new Error('Codex RPC refused'), {
        code: 'adapter-refused', rpcCode: message.error.code }));
      else promise.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      if (message.method === 'item/tool/call' && message.params?.threadId === this.threadId &&
          this.tools.some(tool => tool.name === message.params.tool)) {
        try {
          const result = await this.handleTool(message.params.tool, message.params.arguments,
            { threadId: this.threadId, turnId: message.params.turnId, callId: message.params.callId });
          this.send({ id: message.id, result: { contentItems: [{ type: 'inputText',
            text: JSON.stringify(result) }], success: true } });
        } catch (error) {
          this.send({ id: message.id, result: { contentItems: [{ type: 'inputText',
            text: `Operation denied: ${error.message}. Continue within current authority.` }], success: false } });
        }
      } else {
        this.events.push({ type: 'denied-request', method: message.method });
        this.send({ id: message.id, error: { code: -32000,
          message: 'No human interaction or unbrokered execution is available.' } });
      }
      return;
    }
    if (message.method === 'item/completed' && message.params?.threadId === this.threadId) {
      const item = message.params.item;
      if (item.type === 'agentMessage') this.finalText = item.text;
      this.events.push({ type: item.type });
    }
    if (message.method === 'turn/completed' && message.params?.threadId === this.threadId) {
      const turn = message.params.turn;
      if (turn.status === 'completed') this.turn?.resolve({ status: 'worker-returned',
        threadId: this.threadId, text: this.finalText ?? '', events: this.events });
      else this.turn?.reject(Object.assign(new Error('Codex turn did not complete'), { code: 'adapter-turn-failed' }));
      this.turn = null;
    }
  }

  async startAction(prompt, handle = null) {
    await this.connect();
    const effective = await this.rpc('config/read', { includeLayers: false, cwd: this.cwd });
    if (!effective?.config || typeof effective.config !== 'object') throw new Error('Effective configuration unavailable');
    const config = {};
    for (const name of Object.keys(effective.config.mcp_servers ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('Unresolved inherited MCP name');
      config[`mcp_servers.${name}.enabled`] = false;
    }
    const params = { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', config };
    const result = handle ? await this.rpc('thread/resume', { ...params, threadId: handle.threadId }) :
      await this.rpc('thread/start', { ...params, environments: [], selectedCapabilityRoots: [],
        dynamicTools: this.tools });
    if (this.model && result.model !== this.model) throw new Error('Codex model differs from frozen selection');
    this.threadId = result.thread.id;
    const catalog = await this.rpc('mcpServerStatus/list', { threadId: this.threadId, limit: 100 });
    if (!Array.isArray(catalog.data) || catalog.nextCursor || catalog.data.some(server =>
      server.runtimeStatus !== 'disabled' || Object.keys(server.tools ?? {}).length > 0)) {
      throw new Error('Inherited MCP capabilities remain enabled');
    }
    await this.onHandle({ threadId: this.threadId, pid: this.child.pid, model: result.model, effort: this.effort, harness: 'codex' });
    const complete = new Promise((resolve, reject) => { this.turn = { resolve, reject }; });
    // Handle rejection before the turn-start acknowledgement.
    complete.catch(() => {});
    const turn = await this.rpc('turn/start', { threadId: this.threadId,
      environments: [], input: [{ type: 'text', text: prompt }] });
    this.turnId = turn.turn.id;
    return complete;
  }

  resumeAction(prompt, handle) { return this.startAction(prompt, handle); }
  observe() { return { threadId: this.threadId, turnId: this.turnId, events: [...this.events] }; }
  async cancelAction() {
    if (this.threadId && this.turnId) await this.rpc('turn/interrupt', {
      threadId: this.threadId, turnId: this.turnId });
  }
  close() { this.child?.stdin.end(); this.child?.kill('SIGTERM'); this.lines?.close(); }
}
