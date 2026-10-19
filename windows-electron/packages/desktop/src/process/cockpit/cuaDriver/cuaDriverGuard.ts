/**
 * The cockpit's foreground-consent rule applied to cua-driver tool calls.
 *
 * cua-driver defaults to `delivery_mode: "background"`, but an agent can ask
 * for `"foreground"` (activate the window, move the real pointer) on its own,
 * and cua's capability manifest only allows or denies whole tools. So the
 * proxy checks each call here: anything that would take the user's mouse,
 * keyboard or focus needs `user_asked_for_foreground: true`, the same flag
 * the `aionui-computer-use` server requires.
 */

export const CONSENT_FIELD = 'user_asked_for_foreground';

/** Tools that always take focus. */
const FOREGROUND_TOOLS = new Set(['bring_to_front']);

/** Tools that install extra software or turn the cursor overlay back on. Never exposed. */
export const BLOCKED_TOOLS = new Set(['install_extension', 'install_ffmpeg', 'set_agent_cursor_enabled']);

/** Input tools whose `scope: "desktop"` sends input to whatever app is in front. */
const INPUT_TOOLS = new Set([
  'click',
  'double_click',
  'right_click',
  'drag',
  'scroll',
  'type_text',
  'press_key',
  'hotkey',
  'set_value',
  'move_cursor',
]);

/** Tools that accept the consent flag in their schema. */
export const CONSENT_TOOLS = new Set([...INPUT_TOOLS, ...FOREGROUND_TOOLS, 'run_steps', 'run_script']);

type Args = Record<string, unknown>;

export type GuardResult = { ok: true; args: Args } | { ok: false; message: string };

function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetsDesktop(args: Args): boolean {
  return args.scope === 'desktop' || (isRecord(args.target) && args.target.kind === 'desktop');
}

/** Why a single action would leave the background, or undefined when it stays there. */
function actionReason(tool: string, args: Args): string | undefined {
  if (FOREGROUND_TOOLS.has(tool)) return `${tool} activates a window`;
  if (args.delivery_mode === 'foreground') return 'delivery_mode "foreground" takes the real mouse and keyboard';
  if (INPUT_TOOLS.has(tool) && targetsDesktop(args)) return 'desktop-scope input goes to the app in front';
  return undefined;
}

/** run_steps accepts `{tool, args}` and `{<tool>: args}` steps; batch fields are defaults. */
function runStepsReason(args: Args): string | undefined {
  if (args.foreground_fallback === true) return 'foreground_fallback retries steps in the foreground';
  if (args.delivery_mode === 'foreground') return 'delivery_mode "foreground" takes the real mouse and keyboard';
  const steps = Array.isArray(args.steps) ? args.steps : [];
  for (const step of steps) {
    if (!isRecord(step)) continue;
    const entries =
      typeof step.tool === 'string'
        ? [[step.tool, step.args] as const]
        : Object.entries(step).filter(([key]) => INPUT_TOOLS.has(key) || FOREGROUND_TOOLS.has(key));
    for (const [tool, stepArgs] of entries) {
      const reason = actionReason(tool, isRecord(stepArgs) ? stepArgs : {});
      if (reason) return `a step would leave the background (${reason})`;
    }
  }
  return undefined;
}

/**
 * run_script source can't be evaluated here, so be conservative: any mention
 * of foreground delivery, activation or desktop scope needs consent.
 */
function runScriptReason(args: Args): string | undefined {
  const source = typeof args.script === 'string' ? args.script : JSON.stringify(args);
  return /foreground|bring_to_front|desktop/i.test(source)
    ? 'the script mentions foreground, bring_to_front or desktop scope'
    : undefined;
}

/**
 * Check one `tools/call`. Returns the arguments to forward (with the consent
 * flag removed, since cua-driver rejects unknown fields) or a refusal message.
 */
export function guardCuaDriverCall(tool: string, rawArgs: unknown): GuardResult {
  if (BLOCKED_TOOLS.has(tool)) {
    return { ok: false, message: `${tool} is disabled in the cockpit.` };
  }
  const { [CONSENT_FIELD]: consent, ...args } = isRecord(rawArgs) ? rawArgs : {};
  const reason =
    tool === 'run_steps'
      ? runStepsReason(args)
      : tool === 'run_script'
        ? runScriptReason(args)
        : actionReason(tool, args);
  if (reason && consent !== true) {
    return {
      ok: false,
      message:
        `Refused: ${reason}. Use delivery_mode "background" (the default). Only if the user explicitly asked ` +
        `you in this chat to take over the mouse and keyboard, repeat the call with ${CONSENT_FIELD}: true.`,
    };
  }
  return { ok: true, args };
}

type Tool = { name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } };

/** Hide blocked tools and add the consent flag to every tool that can leave the background. */
export function decorateCuaDriverTools<T extends Tool>(tools: T[]): T[] {
  return tools
    .filter((tool) => !BLOCKED_TOOLS.has(tool.name))
    .map((tool) => {
      if (!CONSENT_TOOLS.has(tool.name) || !tool.inputSchema) return tool;
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            [CONSENT_FIELD]: {
              type: 'boolean',
              description:
                'Set true only when the user explicitly asked in this chat for foreground control. Required for ' +
                'delivery_mode "foreground", bring_to_front and desktop-scope input.',
            },
          },
        },
      };
    });
}
