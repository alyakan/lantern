/**
 * Life: a daily intention and an evening check-in, kept as plain Markdown in Projects\Life\journal\YYYY-MM-DD.md.
 * The Life folder is an ordinary cockpit project (a frame on the board with a Coach module), so any agent
 * Nezar invites can read it, and he can open the notes in any editor.
 */
import fs from 'fs/promises';
import path from 'path';
import type { JournalDay } from '@/common/types/cockpitLife';

const FIELDS: [keyof Omit<JournalDay, 'date'>, string][] = [
  ['intention', 'Intention'],
  ['wins', 'What went well'],
  ['drains', 'What drained me'],
  ['tomorrow', 'One thing for tomorrow'],
];

export function lifeDir(projectsRoot: string): string {
  return path.join(projectsRoot, 'Life');
}

export function journalFile(projectsRoot: string, date: string): string {
  return path.join(lifeDir(projectsRoot), 'journal', `${date}.md`);
}

/** `## Heading` sections of a journal day, matched by the headings this module writes. */
export function parseJournal(date: string, text: string): JournalDay {
  const day: JournalDay = { date };
  for (const [key, heading] of FIELDS) {
    const match = text.match(new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
    const value = match?.[1].trim();
    if (value) day[key] = value;
  }
  return day;
}

export function renderJournal(day: JournalDay): string {
  const lines = [`# ${day.date}`, ''];
  for (const [key, heading] of FIELDS) {
    const value = day[key]?.trim();
    if (value) lines.push(`## ${heading}`, '', value, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

const PROJECT_JSON = {
  name: 'Life',
  color: '#7FB77E',
  summary: 'Daily intention, evening check-ins and weekly reviews. Private: stays on this PC.',
  modules: [
    {
      id: 'coach',
      name: 'Coach',
      kind: 'operator',
      icon: 'pulse',
      runsOn: 'PC',
      llm: 'Qwen (local)',
      summary: 'Helps with the weekly review and the plan for next week. Reads journal/ and nothing else unless asked.',
    },
  ],
};

const README = `# Life

Private notes for the cockpit's Today page. Everything here stays on this PC.

- \`journal/YYYY-MM-DD.md\`: the day's intention and evening check-in.
- The Coach module (local Qwen) reads \`journal/\` for the weekly review.

Agents: treat these notes as private. Read them only when Nezar asks, never send them to a cloud model
unless he says so, and don't copy them into other projects.
`;

/** Creates the Life project (journal folder, board frame, agent notes) the first time it is needed. */
export async function ensureLifeProject(projectsRoot: string): Promise<void> {
  const dir = lifeDir(projectsRoot);
  await fs.mkdir(path.join(dir, 'journal'), { recursive: true });
  await fs.mkdir(path.join(dir, '.cockpit', 'modules'), { recursive: true });
  const write = async (file: string, content: string) => {
    await fs
      .writeFile(path.join(dir, file), content, { encoding: 'utf8', flag: 'wx' })
      .catch((): undefined => undefined);
  };
  await write(path.join('.cockpit', 'project.json'), `${JSON.stringify(PROJECT_JSON, null, 2)}\n`);
  await write('CLAUDE.md', README);
  await write('AGENTS.md', README);
  await write(
    path.join('.cockpit', 'modules', 'coach.md'),
    '# Coach\n\nWeekly review: read the last 7 files in journal/, notice patterns (energy, wins, drains),\n' +
      'ask one or two good questions, then help set three intentions for next week. Be warm and brief.\n'
  );
}

export async function readJournal(projectsRoot: string, date: string): Promise<JournalDay> {
  try {
    return parseJournal(date, await fs.readFile(journalFile(projectsRoot, date), 'utf8'));
  } catch {
    return { date };
  }
}

export async function saveJournal(projectsRoot: string, day: JournalDay): Promise<JournalDay> {
  await ensureLifeProject(projectsRoot);
  const merged = { ...(await readJournal(projectsRoot, day.date)), ...day };
  await fs.writeFile(journalFile(projectsRoot, day.date), renderJournal(merged), 'utf8');
  return merged;
}

/** Consecutive days up to `today` (or yesterday, if today has no entry yet) that have a journal entry. */
export async function journalStreak(projectsRoot: string, today: string): Promise<number> {
  const files = new Set(await fs.readdir(path.join(lifeDir(projectsRoot), 'journal')).catch((): string[] => []));
  const day = new Date(`${today}T12:00:00`);
  if (!files.has(`${today}.md`)) day.setDate(day.getDate() - 1);
  let streak = 0;
  while (files.has(`${localDate(day)}.md`)) {
    streak++;
    day.setDate(day.getDate() - 1);
  }
  return streak;
}

export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
