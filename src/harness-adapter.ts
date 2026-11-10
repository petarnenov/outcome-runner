import type { ChildProcessByStdio, SpawnOptionsWithStdioTuple, StdioPipe } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { Harness } from './model.ts';

export interface ToolDefinition {
  type: 'function';
  name: string;
  description: string;
  inputSchema: object;
}

export interface BrokerInput {
  path: string;
  content?: string;
  expectedHash?: string | null;
  offset?: number;
  section?: string;
}

export interface ToolInput {
  operation?: string;
  input?: BrokerInput;
  outcome?: string;
  summary?: string;
  findings?: string[];
  inspected?: string[];
}

export interface ToolContext {
  threadId: string;
  turnId?: string;
  callId?: string;
}

export interface SessionHandle {
  threadId: string;
  pid?: number;
  model?: string | null;
  effort?: string | null;
  harness?: Harness;
}

export interface AdapterEvent {
  type: string;
  [detail: string]: unknown;
}

export interface WorkerReply {
  status: 'worker-returned';
  threadId: string;
  text: string;
  events: AdapterEvent[];
}

export interface ProbeResult {
  status: string;
  reason?: string;
  version?: string;
}

export interface HarnessAdapter {
  probe(): ProbeResult;
  startAction(prompt: string, handle?: SessionHandle | null): Promise<WorkerReply>;
  close(): void;
}

export type WorkerProcess = ChildProcessByStdio<Writable, Readable, Readable>;
export type SpawnProcess = (command: string, args: string[],
  options: SpawnOptionsWithStdioTuple<StdioPipe, StdioPipe, StdioPipe>) => WorkerProcess;

export interface HarnessOptions {
  cwd: string;
  tools: ToolDefinition[];
  handleTool: (name: string, input: ToolInput, context: ToolContext) => Promise<unknown>;
  onHandle?: (handle: SessionHandle) => unknown;
}

export interface AdapterOptions extends HarnessOptions {
  executable?: string;
  model?: string | null;
  effort?: string | null;
  spawnProcess?: SpawnProcess;
  environment?: NodeJS.ProcessEnv;
}
