#!/usr/bin/env node
/**
 * Built-in `aionui-computer-use` MCP server.
 *
 * Lets agents look at and operate desktop windows through Poracode's native
 * computer-use helper (Windows UI Automation + Windows Graphics Capture).
 * Everything runs in the BACKGROUND: input goes to the target window without
 * moving the real cursor, focusing the window or touching the keyboard, so it
 * never interrupts a full-screen game. Foreground control needs the user's
 * explicit request (see resolveInputMode). Launching apps always activates on
 * Windows, so it is gated the same way.
 *
 * Env: COCKPIT_COMPUTER_USE_HELPER = absolute path to poracode-computer-use(.exe),
 *      COCKPIT_COMPUTER_USE_STATE = optional private state dir.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ComputerUseHost, buildHelperInput } from './computerUseHost';

const helperPath = process.env.COCKPIT_COMPUTER_USE_HELPER || 'poracode-computer-use';
const host = new ComputerUseHost(helperPath, process.env.COCKPIT_COMPUTER_USE_STATE || undefined);

const windowRef = z
  .object({
    id: z.union([z.number(), z.string()]).describe('Window id from computer_list_windows'),
    app: z.string().optional(),
    title: z.string().optional(),
  })
  .describe('Target window (from computer_list_windows)');

const foregroundFields = {
  mode: z
    .enum(['background', 'foreground'])
    .optional()
    .describe('Always "background" unless the user explicitly asked you to take over the mouse and keyboard.'),
  user_asked_for_foreground: z
    .boolean()
    .optional()
    .describe('Set true only when the user explicitly asked for foreground control in this chat.'),
};

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** Turn helper screenshots into MCP image blocks and keep the JSON small. */
function toContent(result: unknown): Content[] {
  const content: Content[] = [];
  const record = result as { screenshots?: Array<{ data: string; mimeType: string }> } | undefined;
  if (record?.screenshots?.length) {
    for (const shot of record.screenshots) content.push({ type: 'image', data: shot.data, mimeType: shot.mimeType });
    content.push({
      type: 'text',
      text: JSON.stringify({ ...record, screenshots: `${record.screenshots.length} image(s) above` }),
    });
  } else {
    content.push({ type: 'text', text: JSON.stringify(result ?? null) });
  }
  return content;
}

async function call(action: string, args: Record<string, unknown>) {
  const response = await host.request(action, buildHelperInput(action, args));
  if (!response.ok) {
    return {
      content: [{ type: 'text' as const, text: `${response.code ?? 'error'}: ${response.error ?? 'failed'}` }],
      isError: true,
    };
  }
  return { content: toContent(response.result) };
}

const server = new McpServer({ name: 'aionui-computer-use', version: '1.0.0' });

server.tool('computer_list_windows', 'List visible desktop windows (id, app, title, bounds).', {}, () =>
  call('list_windows', {})
);
server.tool(
  'computer_list_apps',
  'List running apps; with query, search installed Start-menu apps.',
  { query: z.string().optional() },
  (args) => call('list_apps', args)
);
server.tool(
  'computer_get_window_state',
  'Screenshot a window (works when it is covered) and/or read its UI Automation tree. Coordinates in later actions are relative to this screenshot.',
  {
    window: windowRef,
    include_screenshot: z.boolean().optional(),
    include_text: z.boolean().optional().describe('Include the accessibility tree'),
    max_dimension: z.number().optional(),
  },
  (args) => call('get_window_state', args)
);
server.tool(
  'computer_find_elements',
  'Find UI elements in a window by role, name, automation id or text.',
  {
    window: windowRef,
    role: z.string().optional(),
    name: z.string().optional(),
    automation_id: z.string().optional(),
    text: z.string().optional(),
    max_results: z.number().optional(),
  },
  (args) => call('find_elements', args)
);
server.tool(
  'computer_invoke_element',
  'Invoke, toggle, select, expand or collapse a UI element found with computer_find_elements (background).',
  {
    window: windowRef,
    element_id: z.string(),
    action: z.enum(['invoke', 'toggle', 'select', 'expand', 'collapse', 'scroll', 'context_menu', 'click']).optional(),
  },
  (args) => call('invoke_element', args)
);
server.tool(
  'computer_set_element_value',
  'Set the value of an editable UI element (background).',
  { window: windowRef, element_id: z.string(), value: z.string() },
  (args) => call('set_element_value', args)
);
server.tool(
  'computer_click',
  'Click at window-relative coordinates, delivered in the background.',
  {
    window: windowRef,
    x: z.number(),
    y: z.number(),
    click_count: z.number().optional(),
    mouse_button: z.enum(['left', 'right', 'middle']).optional(),
    ...foregroundFields,
  },
  (args) => call('click', args)
);
server.tool(
  'computer_type_text',
  'Type text into a window, delivered in the background.',
  { window: windowRef, text: z.string(), ...foregroundFields },
  (args) => call('type_text', args)
);
server.tool(
  'computer_press_key',
  'Press a key or chord (e.g. "ctrl+s", "enter") in a window, delivered in the background.',
  { window: windowRef, key: z.string(), ...foregroundFields },
  (args) => call('press_key', args)
);
server.tool(
  'computer_scroll',
  'Scroll at window-relative coordinates, delivered in the background.',
  { window: windowRef, x: z.number(), y: z.number(), scrollX: z.number(), scrollY: z.number(), ...foregroundFields },
  (args) => call('scroll', args)
);
server.tool(
  'computer_launch_app',
  'Launch an app. On Windows this brings the app to the front, so only do it when the user explicitly asked; pass user_asked_for_foreground: true.',
  { app: z.string().describe('App id from computer_list_apps'), user_asked_for_foreground: z.boolean().optional() },
  async (args) => {
    if (args.user_asked_for_foreground !== true) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'refused: launching an app takes the foreground on Windows. Ask the user first, then retry with user_asked_for_foreground: true.',
          },
        ],
        isError: true,
      };
    }
    return call('launch_app', { ...args, mode: 'foreground' });
  }
);

async function main(): Promise<void> {
  const hello = await host.request('hello', { protocolVersion: 1, clientVersion: 'aionui-cockpit' }, 15_000);
  if (!hello.ok) process.stderr.write(`[builtin-mcp-computer-use] helper hello failed: ${hello.error}\n`);
  process.on('exit', () => host.stop());
  await server.connect(new StdioServerTransport());
}

void main();
