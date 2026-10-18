#!/usr/bin/env node
/**
 * Built-in `aionui-cockpit` MCP server.
 *
 * Turns the agent-facing `aioncore` CLIs (session, conversation, team) into
 * native MCP tools, and adds `cockpit_delegate`, which hands a task to another
 * agent in a new chat and asks it to report back. Every agent (Claude Code,
 * Codex, Aion CLI) gets the same tools, so they can drive the app and each
 * other.
 *
 * The CLIs authenticate with the per-conversation `AIONUI_*` runtime env that
 * AionCore gives each agent process. The tool schemas come from
 * `aioncore <domain> capabilities`, so they stay in sync with the backend.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { aioncoreBin, buildDelegateMessage, missingRuntimeEnv, parseAgentAliases, runAioncore } from './cockpitCli';
import type { CliTool } from './cockpitCli';

const DOMAINS = ['session', 'conversation', 'team'] as const;

const log = (message: string): void => {
  process.stderr.write(`[builtin-mcp-cockpit] ${message}\n`);
};

/** Convert a JSON-schema `properties` object to a zod shape (flat schemas only, which is all the CLIs use). */
function toZodShape(schema: CliTool['stdin_json_schema']): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  const required = new Set(schema?.required ?? []);
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'string':
        field = z.string();
        break;
      case 'integer':
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(z.any());
        break;
      default:
        field = z.any();
    }
    if (prop.description) field = field.describe(prop.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

async function registerCliTools(server: McpServer, bin: string): Promise<void> {
  for (const domain of DOMAINS) {
    const result = await runAioncore(bin, [domain, 'capabilities']);
    let tools: CliTool[] = [];
    try {
      tools = (JSON.parse(result.stdout) as { data?: { tools?: CliTool[] } }).data?.tools ?? [];
    } catch {
      log(`could not read ${domain} capabilities: ${result.stderr.slice(0, 200)}`);
      continue;
    }
    for (const tool of tools) {
      const description =
        domain === 'team' ? `${tool.description}\n\nOnly works inside a Team chat.` : tool.description;
      server.tool(tool.name, description, toZodShape(tool.stdin_json_schema), async (args) => {
        const run = await runAioncore(bin, [domain, ...tool.cli_command], JSON.stringify(args ?? {}));
        return textResult(run.stdout || run.stderr, run.code !== 0);
      });
    }
  }
}

async function main(): Promise<void> {
  const bin = aioncoreBin(process.env);
  const aliases = parseAgentAliases(process.env.COCKPIT_AGENT_ALIASES);
  const server = new McpServer({ name: 'aionui-cockpit', version: '1.0.0' });

  server.tool(
    'cockpit_whoami',
    'Show which cockpit conversation this agent runs in and whether the app runtime context is available.',
    {},
    async () => {
      const missing = missingRuntimeEnv(process.env);
      return textResult(
        JSON.stringify(
          {
            conversation_id: process.env.AIONUI_CONVERSATION_ID ?? null,
            runtime_context: missing.length === 0 ? 'ok' : 'missing',
            missing_env: missing,
            agents: aliases,
          },
          null,
          2
        )
      );
    }
  );

  server.tool(
    'cockpit_delegate',
    'Hand a task to another agent in a new chat in the same workspace. The new chat is told to report back to this ' +
      'chat with session_send_message when it is done, so you do not need to wait for it. ' +
      `Agents: ${Object.keys(aliases).join(', ') || 'pass an assistant_id'} (aion and qwen both mean Aion CLI on its default model).`,
    {
      agent: z.string().describe('Agent alias (for example claude, codex, qwen) or an assistant_id.'),
      task: z.string().describe('The full task, written so the other agent can do it without this chat.'),
      name: z.string().optional().describe('Short chat name. Defaults to the start of the task.'),
      workspace: z.string().optional().describe('Absolute workspace path. Defaults to this chat’s workspace.'),
    },
    async ({ agent, task, name, workspace }) => {
      const missing = missingRuntimeEnv(process.env);
      if (missing.length) return textResult(`Runtime context missing: ${missing.join(', ')}`, true);
      const assistantId = aliases[agent.toLowerCase()] ?? agent;
      const created = await runAioncore(
        bin,
        ['conversation', 'create'],
        JSON.stringify({
          name: name ?? task.slice(0, 60),
          assistant_id: assistantId,
          ...(workspace ? { workspace } : {}),
        })
      );
      let targetId: string | undefined;
      try {
        targetId = (JSON.parse(created.stdout) as { data?: { id?: string } }).data?.id;
      } catch {
        // fall through to the error below
      }
      if (created.code !== 0 || !targetId) return textResult(created.stdout || created.stderr, true);

      const sent = await runAioncore(
        bin,
        ['session', 'send-message'],
        JSON.stringify({
          to: targetId,
          message: buildDelegateMessage(task, process.env.AIONUI_CONVERSATION_ID ?? ''),
        })
      );
      if (sent.code !== 0) return textResult(sent.stdout || sent.stderr, true);
      return textResult(JSON.stringify({ delegated_to: targetId, agent: assistantId, delivery: sent.stdout.trim() }));
    }
  );

  await registerCliTools(server, bin);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
