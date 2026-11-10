import type { EventEmitter } from 'node:events';
import type { PassThrough, Writable } from 'node:stream';

export interface FakeChild extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  killed?: boolean;
  kill: () => void;
}
