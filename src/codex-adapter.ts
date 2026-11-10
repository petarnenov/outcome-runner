import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import { isAtLeast } from './harness-version.ts';
import { codexModels } from './harness-catalog.ts';
import type { Catalog, CodexModels } from './harness-catalog.ts';
import type { AdapterEvent, AdapterOptions, HarnessAdapter, ProbeResult, SessionHandle, SpawnProcess,
  ToolDefinition, ToolInput, WorkerProcess, WorkerReply, HarnessOptions } from './harness-adapter.ts';

interface CodexAdapterOptions extends AdapterOptions { mcpServers?: string[] }

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

interface PendingTurn {
  resolve: (reply: WorkerReply) => void;
  reject: (reason: unknown) => void;
}

interface CodexMessage {
  id?: number;
  method?: string;
  error?: { code: number };
  result?: unknown;
  params: {
    threadId: string;
    tool: string;
    arguments: ToolInput;
    turnId: string;
    callId: string;
    item: { type: string; text?: string };
    turn: { status: string };
  };
}

interface EffectiveConfig { config?: { mcp_servers?: Record<string, unknown> } }
interface ThreadResult { model: string; thread: { id: string } }
interface McpServerCatalog {
  data: { runtimeStatus: string; tools?: Record<string, unknown> }[];
  nextCursor?: string;
}
interface TurnResult { turn: { id: string } }

const minimumVersion = '0.167.0';

export const codexRestrictions = {
  'approval_policy': 'never', 'web_search': 'disabled', 'agents.enabled': false,
  'features.shell_tool': false, 'features.apps': false, 'features.plugins': false,
  'features.image_generation': false, 'features.computer_use': false,
  'features.browser_use': false, 'features.in_app_browser': false,
  'features.hooks': false, 'features.skill_search': false,
  'features.skill_mcp_dependency_install': false, 'features.request_permissions_tool': false,
  'features.goals': false, 'features.view_image': false,
};

export function codexEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_TOOL_CALL_ID', 'CODEX_CI'].includes(name)));
}

export class CodexAdapter implements HarnessAdapter {
  cwd: string;
  tools: ToolDefinition[];
  handleTool: HarnessOptions['handleTool'];
  onHandle: NonNullable<HarnessOptions['onHandle']>;
  executable: string;
  model: string | null;
  effort: string | null;
  mcpServers: string[];
  spawnProcess: SpawnProcess;
  environment: NodeJS.ProcessEnv;
  pending: Map<number, PendingRpc>;
  sequence: number;
  events: AdapterEvent[];
  connected: boolean;
  child!: WorkerProcess;
  lines!: Interface;
  threadId!: string;
  turnId?: string;
  finalText?: string;
  turn?: PendingTurn | null;

  constructor({ cwd, tools, handleTool, onHandle = async () => {}, executable = 'codex',
    model = null, effort = null, mcpServers = [], spawnProcess = spawn, environment = process.env }: CodexAdapterOptions) {
    this.model = model; this.effort = effort;
    this.cwd = cwd; this.tools = tools; this.handleTool = handleTool; this.onHandle = onHandle;
    this.executable = executable; this.mcpServers = mcpServers; this.spawnProcess = spawnProcess;
    this.environment = codexEnvironment(environment);
    this.pending = new Map(); this.sequence = 0; this.events = []; this.connected = false;
  }

  probe(): ProbeResult {
    const version = execFileSync(this.executable, ['--version'], {
      encoding: 'utf8', timeout: 10000, env: this.environment }).trim();
    if (!isAtLeast(/^codex-cli (.+)$/u.exec(version)?.[1], minimumVersion)) return { status: 'unavailable', reason: 'uncertified-codex-version', version };
    return { status: 'interface-ready', version };
  }

  send(value: object): void { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  rpc<Result = unknown>(method: string, params: object): Promise<Result> {
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('Codex RPC observation timed out'), { code: 'ETIMEDOUT' }));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    }) as Promise<Result>;
  }

  /** Lists the models, efforts and marked defaults this Codex offers over the already connected app-server session. */
  async modelList(): Promise<CodexModels> {
    if (!this.connected) throw new Error('Codex adapter is not connected');
    return codexModels(<Result>(method: string, params: object) => this.rpc<Result>(method, params));
  }

  /** Lists the models and efforts this Codex offers over the already connected app-server session. */
  async models(): Promise<Catalog> {
    return (await this.modelList()).catalog;
  }

  async connect(): Promise<void> {
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
    this.connected = true;
    this.child.stderr.on('data', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)).catch(error => this.fail(error)); }
      catch { this.fail(new Error('Malformed Codex transport')); }
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', () => {
      this.connected = false;
      this.fail(Object.assign(new Error('Codex transport exited'), { code: 'ECONNRESET' }));
    });
    await this.rpc('initialize', { clientInfo: { name: 'backlog_off', version: '2' },
      capabilities: { experimentalApi: true } });
    this.send({ method: 'initialized', params: {} });
  }

  fail(error: unknown): void {
    for (const promise of this.pending.values()) { clearTimeout(promise.timer); promise.reject(error); }
    this.pending.clear();
    this.turn?.reject(error); this.turn = null;
  }

  async receive(message: CodexMessage): Promise<void> {
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
            text: `Operation denied: ${(error as Error).message}. Continue within current authority.` }], success: false } });
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

  async startAction(prompt: string, handle: SessionHandle | null = null): Promise<WorkerReply> {
    await this.connect();
    const effective = await this.rpc<EffectiveConfig>('config/read', { includeLayers: false, cwd: this.cwd });
    if (!effective?.config || typeof effective.config !== 'object') throw new Error('Effective configuration unavailable');
    const config: Record<string, boolean> = {};
    for (const name of Object.keys(effective.config.mcp_servers ?? {})) {
      if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw new Error('Unresolved inherited MCP name');
      config[`mcp_servers.${name}.enabled`] = false;
    }
    const params = { cwd: this.cwd, approvalPolicy: 'never', sandbox: 'read-only', config };
    const result = handle ? await this.rpc<ThreadResult>('thread/resume', { ...params, threadId: handle.threadId }) :
      await this.rpc<ThreadResult>('thread/start', { ...params, environments: [], selectedCapabilityRoots: [],
        dynamicTools: this.tools });
    if (this.model && result.model !== this.model) throw new Error('Codex model differs from frozen selection');
    this.threadId = result.thread.id;
    const catalog = await this.rpc<McpServerCatalog>('mcpServerStatus/list', { threadId: this.threadId, limit: 100 });
    if (!Array.isArray(catalog.data) || catalog.nextCursor || catalog.data.some(server =>
      server.runtimeStatus !== 'disabled' || Object.keys(server.tools ?? {}).length > 0)) {
      throw new Error('Inherited MCP capabilities remain enabled');
    }
    await this.onHandle({ threadId: this.threadId, pid: this.child.pid, model: result.model, effort: this.effort, harness: 'codex' });
    const complete = new Promise<WorkerReply>((resolve, reject) => { this.turn = { resolve, reject }; });
    // Handle rejection before the turn-start acknowledgement.
    complete.catch(() => {});
    const turn = await this.rpc<TurnResult>('turn/start', { threadId: this.threadId,
      environments: [], input: [{ type: 'text', text: prompt }] });
    this.turnId = turn.turn.id;
    return complete;
  }

  resumeAction(prompt: string, handle: SessionHandle): Promise<WorkerReply> { return this.startAction(prompt, handle); }
  observe() { return { threadId: this.threadId, turnId: this.turnId, events: [...this.events] }; }
  async cancelAction(): Promise<void> {
    if (this.threadId && this.turnId) await this.rpc('turn/interrupt', {
      threadId: this.threadId, turnId: this.turnId });
  }
  close(): void { this.connected = false; this.child?.stdin.end(); this.child?.kill('SIGTERM'); this.lines?.close(); }
}
