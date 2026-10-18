/**
 * JSON-lines client for Poracode's computer-use helper
 * (native/computer-use-helper, Apache-2.0) plus the background-only policy the
 * cockpit enforces on top of it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';

export type HelperResponse = { id: number; ok: boolean; result?: unknown; error?: string; code?: string };

/** Actions that send input to a window and accept `mode`. */
export const INPUT_ACTIONS = new Set(['click', 'press_key', 'type_text', 'scroll', 'drag', 'launch_app']);

/**
 * Background unless the user explicitly asked for foreground control. The
 * agent has to pass both `mode: "foreground"` and
 * `user_asked_for_foreground: true`; anything else stays in the background so
 * the real mouse and keyboard are never taken over by surprise.
 */
export function resolveInputMode(args: {
  mode?: string;
  user_asked_for_foreground?: boolean;
}): 'background' | 'foreground' {
  return args.mode === 'foreground' && args.user_asked_for_foreground === true ? 'foreground' : 'background';
}

/** Build the helper input for an action: drop cockpit-only fields and pin the mode. */
export function buildHelperInput(action: string, args: Record<string, unknown>): Record<string, unknown> {
  const { user_asked_for_foreground: _confirmed, mode: _mode, ...rest } = args;
  if (!INPUT_ACTIONS.has(action)) return rest;
  return { ...rest, mode: resolveInputMode(args as { mode?: string; user_asked_for_foreground?: boolean }) };
}

export class ComputerUseHost {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, (response: HelperResponse) => void>();

  constructor(
    private readonly binary: string,
    private readonly stateDir?: string
  ) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const args = this.stateDir ? ['--state-dir', this.stateDir] : [];
    const child = spawn(this.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[computer-use-helper] ${chunk.toString()}`));
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let response: HelperResponse;
      try {
        response = JSON.parse(line) as HelperResponse;
      } catch {
        return;
      }
      this.pending.get(response.id)?.(response);
      this.pending.delete(response.id);
    });
    const failAll = (error: string) => {
      for (const [id, resolve] of this.pending) resolve({ id, ok: false, error, code: 'helper_exited' });
      this.pending.clear();
    };
    child.on('exit', (code) => failAll(`computer-use helper exited (${code ?? 'signal'})`));
    child.on('error', (error) => failAll(`computer-use helper failed to start: ${error.message}`));
    this.child = child;
    return child;
  }

  request(action: string, input: Record<string, unknown>, timeoutMs = 30_000): Promise<HelperResponse> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: `${action} timed out`, code: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      child.stdin.write(`${JSON.stringify({ id, action, input })}\n`);
    });
  }

  stop(): void {
    this.child?.stdin.write(`${JSON.stringify({ id: 0, action: 'shutdown', input: {} })}\n`);
    this.child?.kill();
  }
}
