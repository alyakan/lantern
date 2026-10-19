/**
 * Build a Markdown transcript of a conversation so another agent can pick the
 * work up ("Continue in another agent"). Modelled on Poracode's handoff
 * transcript (Apache-2.0): the first user message is always kept, then rows
 * are filled newest-first until the character budget runs out, and the result
 * is printed oldest-first with a marker where earlier rows were dropped.
 */

import type { TMessage } from '@/common/chat/chatLib';

/** Default budget: ~35% of a 300k-token window at ~4 chars per token. */
export const DEFAULT_HANDOFF_MAX_CHARS = 400_000;

/** Single rows longer than this are cut so one huge tool dump cannot eat the budget. */
const MAX_ROW_CHARS = 20_000;

export type HandoffSource = {
  id: string;
  name: string;
  agentName: string;
  workspace?: string;
};

export type HandoffRow = {
  role: 'user' | 'agent' | 'tool';
  text: string;
};

function clip(text: string, max = MAX_ROW_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${text.length - max} more characters cut]`;
}

function toolLabel(message: TMessage): string | undefined {
  switch (message.type) {
    case 'tool_call': {
      const { name, description, status } = message.content;
      return `${name}${description ? ` — ${description}` : ''}${status ? ` (${status})` : ''}`;
    }
    case 'tool_group':
      return message.content
        .map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`)
        .join('; ');
    case 'acp_tool_call': {
      const update = (message.content as { update?: { title?: string; kind?: string; status?: string } }).update;
      if (!update?.title) return undefined;
      return `${update.title}${update.status ? ` (${update.status})` : ''}`;
    }
    default:
      return undefined;
  }
}

/** Reduce raw chat messages to transcript rows (text turns and tool activity only). */
export function toHandoffRows(messages: TMessage[]): HandoffRow[] {
  const rows: HandoffRow[] = [];
  for (const message of messages) {
    if (message.hidden) continue;
    if (message.type === 'text') {
      const text = message.content.content?.trim();
      if (!text) continue;
      rows.push({ role: message.position === 'right' ? 'user' : 'agent', text: clip(text) });
      continue;
    }
    const label = toolLabel(message);
    if (label) rows.push({ role: 'tool', text: clip(label, 500) });
  }
  return rows;
}

function renderRow(row: HandoffRow, agentName: string): string {
  if (row.role === 'tool') return `- tool: ${row.text}`;
  const who = row.role === 'user' ? 'User' : agentName;
  return `### ${who}\n\n${row.text}`;
}

/**
 * Render the transcript. Keeps the first user row, then as many of the newest
 * rows as fit in `maxChars`, in chronological order.
 */
export function buildHandoffTranscript(
  source: HandoffSource,
  messages: TMessage[],
  maxChars: number = DEFAULT_HANDOFF_MAX_CHARS
): string {
  const rows = toHandoffRows(messages);
  const header = [
    `# Handoff transcript: ${source.name}`,
    '',
    `- Source chat: ${source.id}`,
    `- Previous agent: ${source.agentName}`,
    source.workspace ? `- Workspace: ${source.workspace}` : undefined,
    '',
    'Earlier rows may be omitted to fit the budget. The project files are the source of truth.',
    '',
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');

  const firstUserIndex = rows.findIndex((row) => row.role === 'user');
  const first = firstUserIndex >= 0 ? renderRow(rows[firstUserIndex], source.agentName) : undefined;
  let budget = maxChars - header.length - (first?.length ?? 0);

  const kept: string[] = [];
  let index = rows.length - 1;
  for (; index > firstUserIndex; index--) {
    const rendered = renderRow(rows[index], source.agentName);
    if (rendered.length + 2 > budget) break;
    budget -= rendered.length + 2;
    kept.push(rendered);
  }
  kept.reverse();

  const omitted = index - firstUserIndex;
  const parts = [header];
  if (first) parts.push(first);
  if (omitted > 0) parts.push(`… [${omitted} earlier rows omitted] …`);
  parts.push(...kept);
  return `${parts.join('\n\n')}\n`;
}

/** The first message sent to the target agent; the transcript itself is attached as a file. */
export function buildHandoffPrompt(source: HandoffSource, transcriptPath: string): string {
  return [
    `You are taking over a task from another agent (${source.agentName}), chat "${source.name}".`,
    `The transcript of that chat is attached: ${transcriptPath}`,
    'Read it, sum up in a few lines where the work stands, then carry on with the next step.',
  ].join('\n');
}
