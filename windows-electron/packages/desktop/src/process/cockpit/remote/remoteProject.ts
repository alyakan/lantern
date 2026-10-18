/**
 * Remote projects over SSH (main process).
 *
 * A remote project is a local marker folder `~/cockpit-remote/<host>/<name>/`
 * with `.cockpit-remote.json`. Chats opened there with the
 * "Claude Code · Mac mini" agent run Claude Code on the remote host through
 * the ssh wrapper (sshClaudeMain.ts).
 */

import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { acpConversation } from '@/common/adapter/ipcBridge';
import { getBuiltinMcpScriptPath } from '@process/utils/initStorage';
import { REMOTE_MARKER_FILE, isSafeHostPart, shellQuote, sshBaseArgs, type RemoteMarker } from './sshClaudeArgs';

export const REMOTE_AGENT_NAME = 'Claude Code · Mac mini';
export const CLAUDE_AGENT_ACP_PACKAGE = '@agentclientprotocol/claude-agent-acp@0.93.0';
const SSH_WRAPPER_SCRIPT = 'cockpit-ssh-claude';

export type RemoteDirListing = { path: string; dirs: string[] };

/** Folder-name-safe version of a host or project name. */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_') || 'project';
}

export function remoteProjectsRoot(home: string = os.homedir()): string {
  return path.join(home, 'cockpit-remote');
}

export function markerDirFor(marker: RemoteMarker, home: string = os.homedir()): string {
  const name = path.posix.basename(marker.remotePath.replace(/\/+$/, '')) || 'home';
  return path.join(remoteProjectsRoot(home), safeSegment(marker.host), safeSegment(name));
}

function validate(marker: RemoteMarker): void {
  if (!isSafeHostPart(marker.host) || !isSafeHostPart(marker.user)) {
    throw new Error('Host and user may only contain letters, digits, dots, dashes and underscores');
  }
  if (!marker.remotePath.startsWith('/')) throw new Error('Remote path must be absolute');
}

/** Create (or refresh) the marker folder for a remote project and return its local path. */
export async function createRemoteProject(marker: RemoteMarker, home: string = os.homedir()): Promise<string> {
  validate(marker);
  const dir = markerDirFor(marker, home);
  await fs.mkdir(dir, { recursive: true });
  const data: RemoteMarker = {
    host: marker.host,
    user: marker.user,
    key: marker.key || undefined,
    remotePath: marker.remotePath,
    claudePath: marker.claudePath || undefined,
  };
  await fs.writeFile(path.join(dir, REMOTE_MARKER_FILE), JSON.stringify(data, null, 2), 'utf8');
  return dir;
}

/** Parse `pwd` + `ls -1p` output into the folder and its sub-folders. */
export function parseRemoteListing(stdout: string): RemoteDirListing {
  const [first = '', ...rest] = stdout.split('\n').map((line) => line.trimEnd());
  const dirs = rest
    .filter((line) => line.endsWith('/') && !line.startsWith('.'))
    .map((line) => line.slice(0, -1))
    .toSorted((a, b) => a.localeCompare(b));
  return { path: first, dirs };
}

/** List sub-folders of `dir` on the remote host (`~` when empty). */
export function listRemoteDir(marker: Omit<RemoteMarker, 'remotePath'>, dir: string): Promise<RemoteDirListing> {
  if (!isSafeHostPart(marker.host) || !isSafeHostPart(marker.user)) {
    return Promise.reject(new Error('Invalid host or user'));
  }
  const trimmed = dir.trim();
  const target =
    !trimmed || trimmed === '~'
      ? '~'
      : trimmed.startsWith('~/')
        ? `~/${shellQuote(trimmed.slice(2))}`
        : shellQuote(trimmed);
  const command = `cd ${target} && pwd && ls -1p`;
  return new Promise((resolve, reject) => {
    execFile(
      'ssh',
      [...sshBaseArgs(marker), command],
      { timeout: 20_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr.trim() || error.message));
        else resolve(parseRemoteListing(stdout));
      }
    );
  });
}

/** Register the "Claude Code · Mac mini" custom agent once; returns its id. */
export async function ensureRemoteClaudeAgent(): Promise<string> {
  const wrapper = getBuiltinMcpScriptPath(SSH_WRAPPER_SCRIPT);
  const agents = await acpConversation.getManagedAgents.invoke();
  const existing = agents.find((agent) => agent.name === REMOTE_AGENT_NAME);
  if (existing) return existing.id;
  const created = await acpConversation.createCustomAgent.invoke({
    name: REMOTE_AGENT_NAME,
    command: 'npx',
    args: ['-y', CLAUDE_AGENT_ACP_PACKAGE],
    env: [{ name: 'CLAUDE_CODE_EXECUTABLE', value: wrapper }],
    advanced: {
      yolo_id: 'bypassPermissions',
      description: 'Claude Code running on the Mac mini over SSH (open a remote project first).',
    },
  });
  return created.id;
}
