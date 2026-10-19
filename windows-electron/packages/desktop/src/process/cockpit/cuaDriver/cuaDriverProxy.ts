#!/usr/bin/env node
/**
 * Built-in `aionui-cua-driver` MCP server: a thin stdio proxy in front of
 * `cua-driver mcp` (trycua/cua, MIT).
 *
 * It forwards MCP JSON-RPC both ways and adds the cockpit's rules:
 * - foreground actions need `user_asked_for_foreground: true` (cuaDriverGuard);
 * - the agent-cursor overlay is off (`--no-overlay`), so nothing is drawn over
 *   a full-screen game;
 * - telemetry is off;
 * - tools that install extra software are hidden.
 *
 * Env: COCKPIT_CUA_DRIVER = absolute path to cua-driver(.exe).
 */

import { spawn } from 'child_process';
import readline from 'readline';
import { decorateCuaDriverTools, guardCuaDriverCall } from './cuaDriverGuard';

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: unknown } & Record<string, unknown>;
  result?: { tools?: Array<{ name: string }> } & Record<string, unknown>;
};

export const CUA_DRIVER_ARGS = ['mcp', '--no-overlay'];
export const CUA_DRIVER_ENV = { CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' };

/**
 * Rewrite one client→driver message. Returns the line to forward, or the reply
 * to send straight back to the client when the call is refused.
 */
export function handleClientMessage(
  message: JsonRpcMessage,
  pendingToolLists: Set<JsonRpcMessage['id']>
): { forward?: JsonRpcMessage; reply?: JsonRpcMessage } {
  if (message.method === 'tools/list' && message.id !== undefined) {
    pendingToolLists.add(message.id);
  }
  if (message.method !== 'tools/call' || !message.params?.name) return { forward: message };
  const verdict = guardCuaDriverCall(message.params.name, message.params.arguments);
  if ('message' in verdict) {
    return {
      reply: {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: verdict.message }], isError: true },
      },
    };
  }
  return { forward: { ...message, params: { ...message.params, arguments: verdict.args } } };
}

/** Rewrite one driver→client message: decorate `tools/list` results. */
export function handleDriverMessage(
  message: JsonRpcMessage,
  pendingToolLists: Set<JsonRpcMessage['id']>
): JsonRpcMessage {
  if (message.id === undefined || !pendingToolLists.has(message.id)) return message;
  pendingToolLists.delete(message.id);
  const tools = message.result?.tools;
  if (!Array.isArray(tools)) return message;
  return { ...message, result: { ...message.result, tools: decorateCuaDriverTools(tools) } };
}

function write(stream: NodeJS.WritableStream, message: JsonRpcMessage): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function main(): void {
  const driver = process.env.COCKPIT_CUA_DRIVER || 'cua-driver';
  const child = spawn(driver, CUA_DRIVER_ARGS, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...CUA_DRIVER_ENV },
  });
  const pendingToolLists = new Set<JsonRpcMessage['id']>();

  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[cua-driver] ${chunk.toString()}`));
  child.on('error', (error) => {
    process.stderr.write(`[builtin-mcp-cua-driver] failed to start ${driver}: ${error.message}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));

  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    write(process.stdout, handleDriverMessage(message, pendingToolLists));
  });

  readline
    .createInterface({ input: process.stdin })
    .on('line', (line) => {
      if (!line.trim()) return;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        child.stdin.write(`${line}\n`);
        return;
      }
      const { forward, reply } = handleClientMessage(message, pendingToolLists);
      if (reply) write(process.stdout, reply);
      if (forward) write(child.stdin, forward);
    })
    .on('close', () => child.stdin.end());
}

if (require.main === module) main();
