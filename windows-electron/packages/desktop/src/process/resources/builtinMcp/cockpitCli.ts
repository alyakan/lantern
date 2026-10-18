/**
 * Helpers for the `aionui-cockpit` MCP server: run `aioncore` agent CLIs and
 * build the delegate message. Kept free of MCP imports so it is easy to test.
 */

import { spawn } from 'node:child_process';

export const RUNTIME_ENV_KEYS = ['AIONUI_BASE_URL', 'AIONUI_USER_ID', 'AIONUI_CONVERSATION_ID', 'AIONUI_RUNTIME_TOKEN'];

export type CliTool = {
  name: string;
  cli_command: string[];
  description: string;
  stdin_json_schema?: {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

export type CliResult = { code: number; stdout: string; stderr: string };

/** AionCore passes its own path to agents as AIONUI_HELPER_BIN; fall back to PATH. */
export function aioncoreBin(env: NodeJS.ProcessEnv): string {
  return env.AIONUI_HELPER_BIN?.trim() || 'aioncore';
}

export function missingRuntimeEnv(env: NodeJS.ProcessEnv): string[] {
  return RUNTIME_ENV_KEYS.filter((key) => !env[key]?.trim());
}

/** `COCKPIT_AGENT_ALIASES` is a JSON map of lower-case alias -> assistant id, set by the app. */
export function parseAgentAliases(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    return {};
  }
}

export function buildDelegateMessage(task: string, replyTo: string): string {
  const lines = [task.trim()];
  if (replyTo) {
    lines.push(
      '',
      `This task was delegated by another agent (conversation ${replyTo}). When you are done, send a short report ` +
        `of what you did and what is left to that conversation with session_send_message (to: "${replyTo}").`
    );
  }
  return lines.join('\n');
}

export function runAioncore(bin: string, args: string[], stdin?: string, timeoutMs = 120_000): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(stdin ?? '');
  });
}
