import { tokenUsage } from './statistics.ts';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Interface } from 'node:readline';
import { isAtLeast } from './harness-version.ts';
import { assertSelection, claudeCatalog, defaultSelection } from './harness-catalog.ts';
import type { AdapterEvent, AdapterOptions, HarnessAdapter, HarnessOptions, ProbeResult, SessionHandle,
  SpawnProcess, ToolDefinition, ToolInput, WorkerProcess, WorkerReply } from './harness-adapter.ts';

interface RpcRequest {
  jsonrpc: string;
  id?: unknown;
  method: string;
  params: { protocolVersion: string; name: string; arguments: ToolInput };
}

interface ClaudeMessage {
  type: string;
  subtype?: string;
  session_id: string;
  model: string;
  claude_code_version: string;
  permissionMode: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  skills: unknown[];
  slash_commands: unknown[];
  plugins: { name: string; path: string }[];
  message?: { model?: string };
  is_error?: boolean;
  modelUsage?: Record<string, { canonicalModel: string }>;
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

const minimumVersion = '2.1.321';
const builtins = ['cc-plugin-agents-md', 'cc-plugin-telemetry', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'];
export function claudeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !name.startsWith('CLAUDE') || ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR'].includes(name))),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', MCP_TOOL_TIMEOUT: '3600000' };
}
export class ClaudeAdapter implements HarnessAdapter {
  cwd: string;
  tools: ToolDefinition[];
  handleTool: HarnessOptions['handleTool'];
  onHandle: NonNullable<HarnessOptions['onHandle']>;
  onUsage?: HarnessOptions['onUsage'];
  executable: string;
  model: string;
  effort: string;
  spawnProcess: SpawnProcess;
  environment: NodeJS.ProcessEnv;
  events: AdapterEvent[];
  certified: boolean;
  token!: string;
  server!: Server;
  child!: WorkerProcess;
  lines!: Interface;
  threadId!: string;
  expectedSession?: string;
  stderrTail!: string;
  result!: WorkerReply | null;
  reject?: (reason: unknown) => void;

  constructor({ cwd, tools, handleTool, onHandle = async () => {}, onUsage, executable = 'claude',
    model = defaultSelection.model, effort = defaultSelection.effort, spawnProcess = spawn,
    environment = process.env }: AdapterOptions) {
    assertSelection('claude', claudeCatalog, String(model), String(effort));
    if (!tools.length || new Set(tools.map(tool => tool.name)).size !== tools.length || tools.some(tool => !/^[a-zA-Z0-9_-]+$/u.test(tool.name))) throw new Error('Invalid private tool catalog');
    this.onUsage = onUsage;
    this.cwd = cwd; this.tools = tools; this.handleTool = handleTool; this.onHandle = onHandle;
    this.executable = executable; this.model = String(model); this.effort = String(effort); this.spawnProcess = spawnProcess;
    this.environment = claudeEnvironment(environment); this.events = []; this.certified = false;
  }
  probe(): ProbeResult {
    const observed = execFileSync(this.executable, ['--version'], {
      encoding: 'utf8', timeout: 10000, env: this.environment }).trim();
    const installed = /^(.+) \(Claude Code\)$/u.exec(observed)?.[1];
    return isAtLeast(installed, minimumVersion) ? { status: 'interface-ready', version: observed } :
      { status: 'unavailable', reason: 'uncertified-claude-version', version: observed };
  }
  async serve(): Promise<string> {
    this.token = randomBytes(32).toString('hex');
    this.server = createServer((request, response) => this.receive(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject); this.server.listen(0, '127.0.0.1', () => resolve());
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/${this.token}`;
  }
  async receive(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url !== `/${this.token}` || request.headers.origin || request.method !== 'POST') {
      response.writeHead(403); response.end(); return;
    }
    let message!: RpcRequest;
    const send = (payload: object) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }));
    };
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk; if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Private request too large');
      }
      message = JSON.parse(body);
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid private request');
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      if (message.method === 'initialize') send({ result: { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'outcome', version: '1' } } });
      else if (['server/discover', 'ping'].includes(message.method)) send({ result: {} });
      else if (message.method === 'tools/list') send({ result: { tools: this.tools.map(({ name, description, inputSchema }) =>
        ({ name, description, inputSchema })) } });
      else if (message.method === 'tools/call' && this.certified &&
        this.tools.some(tool => tool.name === message.params?.name)) {
        try {
          this.events.push({ type: 'tool-call', name: message.params.name });
          const result = await this.handleTool(message.params.name, message.params.arguments,
            { threadId: this.threadId });
          send({ result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
        } catch (error) {
          send({ result: { isError: true, content: [{ type: 'text',
            text: `Operation denied: ${(error as Error).message}. Continue within current authority.` }] } });
        }
      } else send({ error: { code: -32601, message: 'Only the current private tool catalog is available.' } });
    } catch {
      response.writeHead(400); response.end();
    }
  }
  arguments(url: string, handle: SessionHandle | null): string[] {
    const allowed = this.tools.map(tool => `mcp__outcome__${tool.name}`);
    return ['-p', '--model', this.model, '--effort', this.effort, '--tools', '',
      '--allowedTools', allowed.join(','), '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
      '--restricted', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {
        outcome: { type: 'http', url } } }), '--setting-sources', '', '--settings', JSON.stringify({
        disableAllHooks: true, hooks: {}, enabledPlugins: {}, autoMemoryEnabled: false,
        syncClaudeAiSkills: false, syncClaudeAiPlugins: false }), '--disable-slash-commands', '--no-chrome',
      '--output-format', 'stream-json', '--verbose', '--include-hook-events',
      ...(handle ? ['--resume', handle.threadId] : [])];
  }
  async observeMessage(message: ClaudeMessage): Promise<void> {
    if (message.type === 'system' && message.subtype === 'init') {
      const allowed = this.tools.map(tool => `mcp__outcome__${tool.name}`);
      if (message.model !== this.model || !isAtLeast(message.claude_code_version, minimumVersion) ||
          message.permissionMode !== 'dontAsk' || !Array.isArray(message.tools) ||
          message.tools.length !== allowed.length || message.tools.some(name => !allowed.includes(name)) ||
          message.mcp_servers?.length !== 1 || message.mcp_servers[0].name !== 'outcome' ||
          message.mcp_servers[0].status !== 'connected' || message.skills?.length || message.slash_commands?.length ||
          !Array.isArray(message.plugins) || message.plugins.some(plugin =>
            plugin.path !== 'builtin' || !builtins.includes(plugin.name))) throw new Error('Claude capabilities differ from certified scope');
      if (this.expectedSession && message.session_id !== this.expectedSession) throw new Error('Claude resume session changed');
      this.threadId = message.session_id;
      if (!/^[a-f0-9-]{36}$/u.test(this.threadId ?? '')) throw new Error('Claude session identity unavailable');
      this.events.push({ type: 'init', model: message.model, requestedEffort: this.effort,
        tools: message.tools, mcpServers: message.mcp_servers, plugins: message.plugins });
      await this.onHandle({ threadId: this.threadId, pid: this.child.pid, model: this.model, effort: this.effort,
        harness: 'claude' }); this.certified = true;
    } else if (message.type === 'system' && message.subtype?.startsWith('hook_')) {
      throw new Error('Unexpected Claude hook activity');
    } else if (message.type === 'assistant') {
      if (message.message?.model && message.message.model !== this.model) throw new Error('Claude model changed');
      this.events.push({ type: 'assistant' });
    } else if (message.type === 'result') {
      if (!this.certified || message.session_id !== this.threadId || message.is_error ||
          message.subtype !== 'success' || !message.modelUsage || !Object.keys(message.modelUsage).length ||
          Object.values(message.modelUsage).some(value => value.canonicalModel !== this.model)) {
        throw new Error('Claude worker did not complete with the pinned model');
      }
      const usage = tokenUsage({ inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
        totalTokens: undefined });
      this.onUsage?.(usage);
      if (usage) this.events.push({ type: 'token-usage', ...usage });
      this.result = { status: 'worker-returned', threadId: this.threadId, text: message.result ?? '', events: this.events };
    }
  }
  async startAction(prompt: string, handle: SessionHandle | null = null): Promise<WorkerReply> {
    if (handle && !/^[a-f0-9-]{36}$/u.test(handle.threadId ?? '')) throw new Error('Invalid Claude resume identity');
    this.result = null; this.events = []; this.certified = false;
    this.expectedSession = handle?.threadId; this.stderrTail = '';
    const url = await this.serve();
    return new Promise((resolve, reject) => {
      let messages = Promise.resolve();
      this.reject = reject;
      this.child = this.spawnProcess(this.executable, this.arguments(url, handle), {
        cwd: this.cwd, env: this.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child.stderr.on('data', chunk => { this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4096); });
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on('line', line => {
        messages = messages.then(() => this.observeMessage(JSON.parse(line))).catch(error => {
          reject(error); this.close();
        });
      });
      this.child.on('error', error => { reject(error); this.close(); });
      this.child.on('exit', async code => {
        await messages;
        if (code === 0 && this.result) resolve(this.result);
        else reject(new Error(`Claude transport exited (${code}) without a complete private result: ${this.stderrTail}`));
        this.close();
      });
      this.child.stdin.end(`${prompt}\nUse the matching mcp__outcome__ prefixed private tools.\n`);
    });
  }
  resumeAction(prompt: string, handle: SessionHandle): Promise<WorkerReply> { return this.startAction(prompt, handle); }
  async cancelAction(): Promise<void> { this.reject?.(new Error('Claude action interrupted')); this.close(); }
  close(): void {
    this.certified = false; this.child?.kill('SIGTERM'); this.lines?.close();
    this.server?.closeAllConnections(); this.server?.close();
  }
}
