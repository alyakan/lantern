/**
 * `CLAUDE_CODE_EXECUTABLE` wrapper for the "Claude Code · Mac mini" agent.
 *
 * Bundled to out/main/cockpit-ssh-claude.js (scripts/build-mcp-servers.js). The
 * Claude Agent SDK runs it with node in place of the claude binary. When the
 * cwd is inside a remote-project marker folder it pipes stdio to the remote
 * claude over ssh; otherwise it runs the local `claude` on PATH.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { REMOTE_MARKER_FILE, buildSshClaudeArgs, parseMarker, remoteCwd, type RemoteMarker } from './sshClaudeArgs';

function findMarker(start: string): { marker: RemoteMarker; dir: string } | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, REMOTE_MARKER_FILE);
    if (fs.existsSync(file)) {
      const marker = parseMarker(fs.readFileSync(file, 'utf8'));
      if (marker) return { marker, dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function run(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('error', (error) => {
    process.stderr.write(`[cockpit-ssh-claude] ${command}: ${error.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const args = process.argv.slice(2);
const found = findMarker(process.cwd());
if (found) {
  run('ssh', buildSshClaudeArgs(found.marker, remoteCwd(found.marker, found.dir, process.cwd()), args, process.env));
} else {
  run('claude', args);
}
