/**
 * Pure helpers for running Claude Code on a remote machine over SSH.
 *
 * A remote project is a local "marker" folder holding `.cockpit-remote.json`.
 * The SSH wrapper (sshClaudeMain.ts) finds that file from its cwd and runs the
 * remote `claude` with the arguments the Claude Agent SDK passed, minus the
 * ones that point at local Windows files.
 */

import path from 'path';

export const REMOTE_MARKER_FILE = '.cockpit-remote.json';
export const DEFAULT_REMOTE_CLAUDE = '~/.local/bin/claude';

export type RemoteMarker = {
  host: string;
  user: string;
  /** Private key path on this PC. */
  key?: string;
  /** Absolute project path on the remote machine. */
  remotePath: string;
  /** Remote claude binary; defaults to ~/.local/bin/claude. */
  claudePath?: string;
};

/** SDK env vars worth forwarding to the remote claude. */
const FORWARDED_ENV = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION', 'MAX_THINKING_TOKENS'];

/** Quote one word for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function parseMarker(raw: string): RemoteMarker | undefined {
  try {
    const data = JSON.parse(raw) as Partial<RemoteMarker>;
    if (!data.host || !data.user || !data.remotePath) return undefined;
    if (!isSafeHostPart(data.host) || !isSafeHostPart(data.user)) return undefined;
    return {
      host: data.host,
      user: data.user,
      key: data.key,
      remotePath: data.remotePath,
      claudePath: data.claudePath,
    };
  } catch {
    return undefined;
  }
}

/** Host and user names go on the ssh command line unquoted, so only allow plain names. */
export function isSafeHostPart(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * Keep only MCP servers the SDK serves itself over stdio (`type: "sdk"`).
 * Local stdio/http servers point at this PC and cannot run on the remote host.
 */
function remoteSafeMcpConfig(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { type?: string }> };
    const kept = Object.fromEntries(
      Object.entries(parsed.mcpServers ?? {}).filter(([, server]) => server?.type === 'sdk')
    );
    return Object.keys(kept).length > 0 ? JSON.stringify({ mcpServers: kept }) : undefined;
  } catch {
    return undefined;
  }
}

/** Drop arguments that reference local files; trim --mcp-config to SDK servers. */
export function filterClaudeArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--plugin-dir' || arg === '--debug-file') {
      i++;
      continue;
    }
    if (arg === '--settings' && next !== undefined && !next.trim().startsWith('{')) {
      i++;
      continue;
    }
    if (arg === '--mcp-config' && next !== undefined) {
      i++;
      const kept = remoteSafeMcpConfig(next);
      if (kept) out.push(arg, kept);
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Map a local cwd inside the marker folder to the matching remote folder. */
export function remoteCwd(marker: RemoteMarker, markerDir: string, cwd: string): string {
  const relative = path.relative(markerDir, cwd);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return marker.remotePath;
  return path.posix.join(marker.remotePath, ...relative.split(path.sep));
}

/** Base ssh options shared by the wrapper and the folder browser. */
export function sshBaseArgs(marker: Pick<RemoteMarker, 'host' | 'user' | 'key'>): string[] {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (marker.key) args.push('-i', marker.key);
  args.push(`${marker.user}@${marker.host}`);
  return args;
}

/** Full ssh argv that runs the remote claude in `dir` with `claudeArgs`. */
export function buildSshClaudeArgs(
  marker: RemoteMarker,
  dir: string,
  claudeArgs: string[],
  env: NodeJS.ProcessEnv = {}
): string[] {
  const envPrefix = FORWARDED_ENV.filter((name) => env[name])
    .map((name) => `${name}=${shellQuote(env[name] as string)}`)
    .join(' ');
  const claude = marker.claudePath || DEFAULT_REMOTE_CLAUDE;
  // `~/` must stay unquoted so the remote shell expands it.
  const claudeWord = claude.startsWith('~/') ? `~/${shellQuote(claude.slice(2))}` : shellQuote(claude);
  const command = [
    `cd ${shellQuote(dir)} &&`,
    envPrefix ? `exec env ${envPrefix}` : 'exec',
    claudeWord,
    ...filterClaudeArgs(claudeArgs).map(shellQuote),
  ].join(' ');
  return [...sshBaseArgs(marker), command];
}
