import { describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('@/common/adapter/ipcBridge', () => ({ acpConversation: {} }));
vi.mock('@process/utils/initStorage', () => ({ getBuiltinMcpScriptPath: (name: string) => `/out/${name}.js` }));

const { buildSshClaudeArgs, filterClaudeArgs, parseMarker, remoteCwd, shellQuote } =
  await import('@process/cockpit/remote/sshClaudeArgs');
const { createRemoteProject, markerDirFor, parseRemoteListing } = await import('@process/cockpit/remote/remoteProject');

describe('sshClaudeArgs', () => {
  describe('shellQuote', () => {
    it('escapes single quotes inside the value', () => {
      expect(shellQuote("it's")).toBe("'it'\\''s'");
    });
  });

  describe('parseMarker', () => {
    it('returns undefined when required fields are missing', () => {
      expect(parseMarker(JSON.stringify({ host: 'h', user: 'u' }))).toBeUndefined();
      expect(parseMarker(JSON.stringify({ user: 'u', remotePath: '/p' }))).toBeUndefined();
      expect(parseMarker(JSON.stringify({ host: 'h', remotePath: '/p' }))).toBeUndefined();
    });

    it('returns undefined for hosts or users containing spaces or semicolons', () => {
      expect(parseMarker(JSON.stringify({ host: 'a b', user: 'u', remotePath: '/p' }))).toBeUndefined();
      expect(parseMarker(JSON.stringify({ host: 'a;b', user: 'u', remotePath: '/p' }))).toBeUndefined();
      expect(parseMarker(JSON.stringify({ host: 'h', user: 'a b', remotePath: '/p' }))).toBeUndefined();
      expect(parseMarker(JSON.stringify({ host: 'h', user: 'a;b', remotePath: '/p' }))).toBeUndefined();
    });
  });

  describe('filterClaudeArgs', () => {
    it('drops --plugin-dir and its value', () => {
      expect(filterClaudeArgs(['--plugin-dir', '/local/path', 'arg'])).toEqual(['arg']);
    });

    it('keeps only type "sdk" servers in --mcp-config and drops the flag if none remain', () => {
      const config = JSON.stringify({
        mcpServers: {
          local: { type: 'stdio' },
          remote: { type: 'sdk' },
        },
      });
      expect(filterClaudeArgs(['--mcp-config', config])).toEqual([
        '--mcp-config',
        JSON.stringify({ mcpServers: { remote: { type: 'sdk' } } }),
      ]);

      const onlyLocal = JSON.stringify({
        mcpServers: {
          local: { type: 'stdio' },
        },
      });
      expect(filterClaudeArgs(['--mcp-config', onlyLocal])).toEqual([]);
    });

    it('drops --settings with a file path but keeps --settings with inline JSON', () => {
      expect(filterClaudeArgs(['--settings', '/path/to/settings.json', 'arg'])).toEqual(['arg']);
      expect(filterClaudeArgs(['--settings', '{"key":"value"}', 'arg'])).toEqual([
        '--settings',
        '{"key":"value"}',
        'arg',
      ]);
    });
  });

  describe('remoteCwd', () => {
    it('maps a sub folder inside the marker dir to the remote path', () => {
      const marker = { host: 'h', user: 'u', remotePath: '/remote/root' };
      const markerDir = '/local/marker';
      const cwd = path.join(markerDir, 'sub', 'folder');
      expect(remoteCwd(marker, markerDir, cwd)).toBe('/remote/root/sub/folder');
    });

    it('falls back to remotePath when cwd is outside the marker dir', () => {
      const marker = { host: 'h', user: 'u', remotePath: '/remote/root' };
      const markerDir = '/local/marker';
      const cwd = '/other/location';
      expect(remoteCwd(marker, markerDir, cwd)).toBe('/remote/root');
    });
  });

  describe('buildSshClaudeArgs', () => {
    it('constructs the command with cd, exec, and claude path', () => {
      const marker = { host: 'h', user: 'u', remotePath: '/r/p' };
      const args = buildSshClaudeArgs(marker, '/r/p', []);
      const last = args[args.length - 1];
      expect(last).toMatch(/^cd '\/r\/p' && exec/);
      expect(last).toContain("~/'.local/bin/claude'");
    });

    it('includes -i key when key is set', () => {
      const marker = { host: 'h', user: 'u', key: '/path/to/key', remotePath: '/r/p' };
      const args = buildSshClaudeArgs(marker, '/r/p', []);
      expect(args).toContain('-i');
      expect(args).toContain('/path/to/key');
    });

    it('forwards CLAUDE_CODE_ENTRYPOINT but not other env vars', () => {
      const marker = { host: 'h', user: 'u', remotePath: '/r/p' };
      const env = {
        CLAUDE_CODE_ENTRYPOINT: 'test-entry',
        OTHER_VAR: 'should-not-appear',
      };
      const args = buildSshClaudeArgs(marker, '/r/p', [], env);
      const last = args[args.length - 1];
      expect(last).toContain("CLAUDE_CODE_ENTRYPOINT='test-entry'");
      expect(last).not.toContain('OTHER_VAR');
    });
  });
});

describe('remoteProject', () => {
  describe('parseRemoteListing', () => {
    it('parses path and directories from listing output', () => {
      const input = '/Users/me\nb/\na.txt\n.git/\na/\n';
      expect(parseRemoteListing(input)).toEqual({ path: '/Users/me', dirs: ['a', 'b'] });
    });
  });

  describe('markerDirFor', () => {
    it('constructs path using home, cockpit-remote, host, and basename', () => {
      const marker = { host: 'myhost', user: 'u', remotePath: '/remote/projects/myproj' };
      const home = '/home/user';
      expect(markerDirFor(marker, home)).toBe(path.join(home, 'cockpit-remote', 'myhost', 'myproj'));
    });
  });

  describe('createRemoteProject', () => {
    it('writes .cockpit-remote.json in a temp home directory', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-test-'));
      const marker = { host: 'validhost', user: 'validuser', remotePath: '/remote/path' };
      const dir = await createRemoteProject(marker, tempHome);
      const markerFile = path.join(dir, '.cockpit-remote.json');
      const content = await fs.readFile(markerFile, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.host).toBe('validhost');
      expect(parsed.user).toBe('validuser');
      expect(parsed.remotePath).toBe('/remote/path');
      await fs.rm(tempHome, { recursive: true, force: true });
    });

    it('rejects a relative remotePath', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-test-'));
      const marker = { host: 'validhost', user: 'validuser', remotePath: 'relative/path' };
      await expect(createRemoteProject(marker, tempHome)).rejects.toThrow('Remote path must be absolute');
      await fs.rm(tempHome, { recursive: true, force: true });
    });

    it('rejects a host with spaces', async () => {
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-test-'));
      const marker = { host: 'a b', user: 'validuser', remotePath: '/remote/path' };
      await expect(createRemoteProject(marker, tempHome)).rejects.toThrow(
        'Host and user may only contain letters, digits, dots, dashes and underscores'
      );
      await fs.rm(tempHome, { recursive: true, force: true });
    });
  });
});
