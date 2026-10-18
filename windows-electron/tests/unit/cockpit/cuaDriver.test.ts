import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn() }));
vi.mock('@/common/adapter/ipcBridge', () => ({ mcpService: {} }));
vi.mock('@process/utils/initStorage', () => ({ getBuiltinMcpScriptPath: (name: string) => `/out/${name}.js` }));
vi.mock('@/common', () => ({ ipcBridge: {} }));

const { buildCuaDriverMcpServer, findCuaDriver } = await import('@process/cockpit/cockpitMcp');
const { guardCuaDriverCall, decorateCuaDriverTools } = await import('@process/cockpit/cuaDriver/cuaDriverGuard');
const { handleClientMessage, handleDriverMessage, CUA_DRIVER_ARGS, CUA_DRIVER_ENV } =
  await import('@process/cockpit/cuaDriver/cuaDriverProxy');

const BIN = process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';

describe('cua-driver foreground guard', () => {
  it('passes background actions through unchanged', () => {
    const args = { pid: 4, element_token: 's00000001:2', delivery_mode: 'background' };
    expect(guardCuaDriverCall('click', args)).toEqual({ ok: true, args });
    expect(guardCuaDriverCall('get_window_state', { pid: 4 })).toEqual({ ok: true, args: { pid: 4 } });
    expect(guardCuaDriverCall('get_desktop_state', { scope: 'desktop' }).ok).toBe(true);
  });

  it('refuses foreground delivery, activation and desktop-scope input without consent', () => {
    const refused = [
      ['click', { pid: 4, x: 1, y: 2, delivery_mode: 'foreground' }],
      ['bring_to_front', { pid: 4 }],
      ['type_text', { text: 'hi', scope: 'desktop' }],
      ['hotkey', { keys: ['ctrl', 'v'], target: { kind: 'desktop', display_id: 'primary' } }],
      ['click', { pid: 4, x: 1, y: 2, delivery_mode: 'foreground', user_asked_for_foreground: 'yes' }],
    ] as const;
    for (const [tool, args] of refused) {
      const result = guardCuaDriverCall(tool, args);
      expect(result.ok, tool).toBe(false);
      if ('message' in result) expect(result.message).toContain('user_asked_for_foreground: true');
    }
  });

  it('allows foreground with consent and strips the flag before forwarding', () => {
    expect(
      guardCuaDriverCall('click', { pid: 4, delivery_mode: 'foreground', user_asked_for_foreground: true })
    ).toEqual({ ok: true, args: { pid: 4, delivery_mode: 'foreground' } });
    expect(guardCuaDriverCall('click', { pid: 4, user_asked_for_foreground: false })).toEqual({
      ok: true,
      args: { pid: 4 },
    });
  });

  it('checks every run_steps step in both step shapes and the batch defaults', () => {
    const background = { steps: [{ tool: 'click', args: { pid: 1 } }, { type_text: { pid: 1, text: 'a' } }] };
    expect(guardCuaDriverCall('run_steps', background).ok).toBe(true);
    expect(guardCuaDriverCall('run_steps', { steps: [{ click: { pid: 1, delivery_mode: 'foreground' } }] }).ok).toBe(
      false
    );
    expect(guardCuaDriverCall('run_steps', { steps: [{ tool: 'press_key', args: { scope: 'desktop' } }] }).ok).toBe(
      false
    );
    expect(guardCuaDriverCall('run_steps', { ...background, delivery_mode: 'foreground' }).ok).toBe(false);
    expect(guardCuaDriverCall('run_steps', { ...background, foreground_fallback: true }).ok).toBe(false);
    expect(
      guardCuaDriverCall('run_steps', { ...background, foreground_fallback: true, user_asked_for_foreground: true })
    ).toMatchObject({ ok: true });
  });

  it('treats run_script conservatively', () => {
    expect(guardCuaDriverCall('run_script', { script: 'const a = await cua.getApp("Notepad"); return 1;' }).ok).toBe(
      true
    );
    expect(guardCuaDriverCall('run_script', { script: 'cua.call("click", {delivery_mode: "foreground"})' }).ok).toBe(
      false
    );
  });

  it('blocks tools that install software or re-enable the overlay', () => {
    expect(guardCuaDriverCall('install_ffmpeg', {}).ok).toBe(false);
    expect(guardCuaDriverCall('set_agent_cursor_enabled', { session: 's', enabled: true }).ok).toBe(false);
    expect(guardCuaDriverCall('install_extension', { user_asked_for_foreground: true }).ok).toBe(false);
  });

  it('adds the consent flag to tools that can leave the background and hides blocked tools', () => {
    const tools = decorateCuaDriverTools([
      { name: 'click', inputSchema: { properties: { pid: { type: 'integer' } } } },
      { name: 'get_window_state', inputSchema: { properties: {} } },
      { name: 'install_ffmpeg', inputSchema: { properties: {} } },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['click', 'get_window_state']);
    expect(Object.keys(tools[0].inputSchema?.properties ?? {})).toEqual(['pid', 'user_asked_for_foreground']);
    expect(tools[1].inputSchema?.properties).toEqual({});
  });
});

describe('cua-driver MCP proxy', () => {
  it('runs cua-driver without the overlay or telemetry', () => {
    expect(CUA_DRIVER_ARGS).toEqual(['mcp', '--no-overlay']);
    expect(CUA_DRIVER_ENV).toEqual({ CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false' });
  });

  it('answers refused calls itself and forwards allowed ones', () => {
    const pending = new Set<number | string | null | undefined>();
    const refused = handleClientMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'bring_to_front', arguments: { pid: 1 } } },
      pending
    );
    expect(refused.forward).toBeUndefined();
    expect(refused.reply).toMatchObject({ id: 7, result: { isError: true } });

    const allowed = handleClientMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'click', arguments: { pid: 1, user_asked_for_foreground: false } },
      },
      pending
    );
    expect(allowed.forward?.params?.arguments).toEqual({ pid: 1 });
    expect(handleClientMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, pending).forward).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });

  it('decorates only the tools/list responses it asked for', () => {
    const pending = new Set<number | string | null | undefined>();
    handleClientMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, pending);
    const list = handleDriverMessage(
      { jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'install_ffmpeg' }, { name: 'zoom' }] } },
      pending
    );
    expect(list.result?.tools).toEqual([{ name: 'zoom' }]);
    expect(pending.size).toBe(0);
    const other = { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'install_ffmpeg' }] } };
    expect(handleDriverMessage(other, pending)).toBe(other);
  });
});

describe('cua-driver registration', () => {
  it('registers a disabled builtin server that runs the proxy', () => {
    const server = buildCuaDriverMcpServer('/out/builtin-mcp-cua-driver.js', 'C:/u/.cua-driver/bin/cua-driver.exe');
    expect(server.name).toBe('aionui-cua-driver');
    expect(server.enabled).toBe(false);
    expect(server.builtin).toBe(true);
    expect(server.transport).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/out/builtin-mcp-cua-driver.js'],
      env: { COCKPIT_CUA_DRIVER: 'C:/u/.cua-driver/bin/cua-driver.exe' },
    });
  });

  it('finds cua-driver from the env, ~/.cua-driver/bin, then PATH', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-home-'));
    const onPath = await fs.mkdtemp(path.join(os.tmpdir(), 'cua-path-'));
    try {
      expect(findCuaDriver({ PATH: onPath }, home)).toBeUndefined();
      await fs.writeFile(path.join(onPath, BIN), '');
      expect(findCuaDriver({ PATH: onPath }, home)).toBe(path.join(onPath, BIN));
      await fs.mkdir(path.join(home, '.cua-driver', 'bin'), { recursive: true });
      await fs.writeFile(path.join(home, '.cua-driver', 'bin', BIN), '');
      expect(findCuaDriver({ PATH: onPath }, home)).toBe(path.join(home, '.cua-driver', 'bin', BIN));
      expect(findCuaDriver({ COCKPIT_CUA_DRIVER: path.join(onPath, BIN) }, home)).toBe(path.join(onPath, BIN));
      expect(findCuaDriver({ COCKPIT_CUA_DRIVER: path.join(onPath, 'missing.exe') }, home)).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(onPath, { recursive: true, force: true });
    }
  });
});
