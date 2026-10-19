/**
 * Register the built-in `aionui-cockpit` MCP server (see
 * process/resources/builtinMcp/cockpitServer.ts) and keep its agent aliases
 * current. Runs on every start, after the backend migrations.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { httpRequest } from '@/common/adapter/httpBridge';
import { mcpService } from '@/common/adapter/ipcBridge';
import { BUILTIN_CUA_DRIVER_NAME, type IMcpServer } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { getBuiltinMcpScriptPath } from '@process/utils/initStorage';

export const COCKPIT_MCP_NAME = 'aionui-cockpit';
export const COMPUTER_USE_MCP_NAME = 'aionui-computer-use';
const COMPUTER_USE_MCP_SCRIPT = 'builtin-mcp-computer-use';
const COMPUTER_USE_HELPER = process.platform === 'win32' ? 'poracode-computer-use.exe' : 'poracode-computer-use';
const COCKPIT_MCP_SCRIPT = 'builtin-mcp-cockpit';
const CUA_DRIVER_MCP_SCRIPT = 'builtin-mcp-cua-driver';
const CUA_DRIVER_BIN = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';

type McpImportServer = Partial<IMcpServer> & Pick<IMcpServer, 'name' | 'transport'>;

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Short names agents can use with `cockpit_delegate` (claude, codex, aion/qwen, custom agents by slug). */
export function buildAgentAliases(assistants: Assistant[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const assistant of assistants) {
    if (assistant.source !== 'generated' || !assistant.enabled) continue;
    const agent = assistant.agent;
    if (agent?.type === 'aionrs') {
      aliases.aion = assistant.id;
      aliases.qwen = assistant.id;
    } else if (agent?.acp_backend === 'claude' && agent.source === 'builtin') {
      aliases.claude = assistant.id;
    } else if (agent?.acp_backend === 'codex' && agent.source === 'builtin') {
      aliases.codex = assistant.id;
    } else {
      aliases[slug(assistant.name)] = assistant.id;
    }
  }
  return aliases;
}

export function buildCockpitMcpServer(scriptPath: string, aliases: Record<string, string>): McpImportServer {
  const config = { command: 'node', args: [scriptPath], env: { COCKPIT_AGENT_ALIASES: JSON.stringify(aliases) } };
  return {
    name: COCKPIT_MCP_NAME,
    description:
      'Cockpit tools: list and message other chats, create chats, work with Teams, and delegate a task to ' +
      'Claude Code, Codex or Aion CLI (Qwen).',
    enabled: true,
    builtin: true,
    transport: { type: 'stdio', ...config },
    original_json: JSON.stringify({ mcpServers: { [COCKPIT_MCP_NAME]: config } }, null, 2),
  };
}

/** The computer-use helper: COCKPIT_COMPUTER_USE_HELPER, else the first match on PATH. */
export function findComputerUseHelper(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env.COCKPIT_COMPUTER_USE_HELPER?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, COMPUTER_USE_HELPER);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function buildComputerUseMcpServer(scriptPath: string, helperPath: string): McpImportServer {
  const config = { command: 'node', args: [scriptPath], env: { COCKPIT_COMPUTER_USE_HELPER: helperPath } };
  return {
    name: COMPUTER_USE_MCP_NAME,
    description:
      'Desktop computer use in the background: screenshot and read windows, click, type and press keys ' +
      'without taking over the real mouse or keyboard.',
    enabled: true,
    builtin: true,
    transport: { type: 'stdio', ...config },
    original_json: JSON.stringify({ mcpServers: { [COMPUTER_USE_MCP_NAME]: config } }, null, 2),
  };
}

/**
 * cua-driver (trycua/cua): COCKPIT_CUA_DRIVER, else ~/.cua-driver/bin (where the
 * cockpit's setup puts the pinned release), else the first match on PATH.
 */
export function findCuaDriver(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
  const explicit = env.COCKPIT_CUA_DRIVER?.trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  const dirs = [path.join(home, '.cua-driver', 'bin'), ...(env.PATH ?? env.Path ?? '').split(path.delimiter)];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, CUA_DRIVER_BIN);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Second computer-use backend, registered disabled. The user turns it on in
 * Settings → Tools; upserts keep whatever they chose.
 */
export function buildCuaDriverMcpServer(scriptPath: string, driverPath: string): McpImportServer {
  const config = { command: 'node', args: [scriptPath], env: { COCKPIT_CUA_DRIVER: driverPath } };
  return {
    name: BUILTIN_CUA_DRIVER_NAME,
    description:
      'cua-driver computer use (experimental): background desktop control with browser and script tools. ' +
      'Foreground actions need the user to ask for them.',
    enabled: false,
    builtin: true,
    transport: { type: 'stdio', ...config },
    original_json: JSON.stringify({ mcpServers: { [BUILTIN_CUA_DRIVER_NAME]: config } }, null, 2),
  };
}

async function upsertBuiltinServer(desired: McpImportServer): Promise<void> {
  const existing = (await mcpService.listServers.invoke())?.find((server) => server.name === desired.name);
  if (!existing) {
    await mcpService.batchImportServers.invoke({ servers: [desired] });
    console.info('[Cockpit] registered %s MCP server', desired.name);
    return;
  }
  if (existing.original_json !== desired.original_json) {
    await mcpService.updateServer.invoke({
      id: existing.id,
      data: { transport: desired.transport, original_json: desired.original_json },
    });
    console.info('[Cockpit] updated %s MCP server', desired.name);
  }
}

export async function ensureCockpitMcpServer(): Promise<void> {
  const assistants = await httpRequest<Assistant[]>('GET', '/api/assistants').catch((): Assistant[] => []);
  await upsertBuiltinServer(
    buildCockpitMcpServer(getBuiltinMcpScriptPath(COCKPIT_MCP_SCRIPT), buildAgentAliases(assistants))
  );
  const helper = findComputerUseHelper();
  if (helper) {
    await upsertBuiltinServer(buildComputerUseMcpServer(getBuiltinMcpScriptPath(COMPUTER_USE_MCP_SCRIPT), helper));
  } else {
    console.info('[Cockpit] %s not found; computer-use MCP not registered', COMPUTER_USE_HELPER);
  }
  const cuaDriver = findCuaDriver();
  if (cuaDriver) {
    await upsertBuiltinServer(buildCuaDriverMcpServer(getBuiltinMcpScriptPath(CUA_DRIVER_MCP_SCRIPT), cuaDriver));
  }
}
