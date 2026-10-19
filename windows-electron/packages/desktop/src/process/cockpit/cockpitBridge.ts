/**
 * Main-process handlers for the cockpit fork additions.
 */
import type { Dirent } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ipcBridge } from '@/common';
import { getSystemDir } from '@process/utils/initStorage';
import {
  gitStatus,
  listLanternProjects,
  macServices,
  projectsRoot,
  readContextFile,
  readHiddenProjects,
} from './lanternProjects';
import { journalStreak, lifeDir, localDate, readJournal, saveJournal } from './lifeJournal';
import { loadModel, Pulse, unloadModel } from './pulse';
import type { JournalState } from '@/common/types/cockpitLife';
import { createRemoteProject, ensureRemoteClaudeAgent, listRemoteDir } from './remote/remoteProject';

/** Keep only filename-safe characters from an id. */
export function safeFileStem(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'conversation';
}

export async function writeHandoffTranscript(
  cacheDir: string,
  conversationId: string,
  content: string
): Promise<string> {
  const dir = path.join(cacheDir, 'handoff');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeFileStem(conversationId)}-${Date.now()}.md`);
  await fs.writeFile(file, content, 'utf8');
  return file;
}

/** Same rule as AionCore's `shared_skills_dir()`: AIONUI_SHARED_SKILLS_DIR, else ~/.agents/skills. */
export function sharedSkillsDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.AIONUI_SHARED_SKILLS_DIR?.trim();
  return override || path.join(home, '.agents', 'skills');
}

/** Folder names in `dir` that contain a SKILL.md. */
export async function listSkillFolders(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
  const names = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        (await fs.stat(path.join(dir, entry.name, 'SKILL.md')).then(
          () => true,
          () => false
        ))
          ? entry.name
          : undefined
      )
  );
  return names.filter((name): name is string => Boolean(name)).toSorted();
}

type BoardPositions = Record<string, { x: number; y: number }>;
type BoardLayoutFile = Record<string, BoardPositions>;

/** Board layouts for every project, keyed by normalized project folder. */
export function boardLayoutKey(project: string): string {
  return project.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function readBoardLayouts(file: string): Promise<BoardLayoutFile> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as BoardLayoutFile;
  } catch {
    return {};
  }
}

export async function getBoardLayout(file: string, project: string): Promise<BoardPositions> {
  return (await readBoardLayouts(file))[boardLayoutKey(project)] ?? {};
}

export async function saveBoardLayout(file: string, project: string, positions: BoardPositions): Promise<void> {
  const all = await readBoardLayouts(file);
  all[boardLayoutKey(project)] = positions;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all, null, 2), 'utf8');
}

const boardLayoutFile = () => path.join(getSystemDir().workDir, 'cockpit-board.json');
const sideChatsFile = () => path.join(getSystemDir().workDir, 'cockpit-side-chats.json');

async function readSideChats(file: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function setSideChat(file: string, target: string, conversationId: string | null): Promise<void> {
  const all = await readSideChats(file);
  if (conversationId) all[target] = conversationId;
  else delete all[target];
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(all, null, 2), 'utf8');
}

let pulse: Pulse | undefined;

/** The app-wide Pulse (budgets, local model, GPU), created on first use. */
export async function getPulse(): Promise<Pulse> {
  if (!pulse) {
    const dir = getSystemDir().workDir;
    pulse = new Pulse({
      claudeFile: path.join(dir, 'cockpit-pulse-claude.json'),
      settingsFile: path.join(dir, 'cockpit-pulse-settings.json'),
    });
    await pulse.init();
  }
  return pulse;
}

type DispatchPrefsFile = Record<string, Record<string, number>>;
const dispatchPrefsFile = () => path.join(getSystemDir().workDir, 'cockpit-dispatch-prefs.json');
const dispatchLogFile = () => path.join(getSystemDir().workDir, 'cockpit-dispatch-log.jsonl');

async function readDispatchPrefs(): Promise<DispatchPrefsFile> {
  try {
    return JSON.parse(await fs.readFile(dispatchPrefsFile(), 'utf8')) as DispatchPrefsFile;
  } catch {
    return {};
  }
}

/** Log every decision; count overrides per kind so the dispatcher learns Nezar's preferences. */
export async function recordDispatch(entry: {
  kind: string;
  goal: string;
  picked: string;
  chosen: string;
  where: string;
}): Promise<DispatchPrefsFile> {
  const dir = getSystemDir().workDir;
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(dispatchLogFile(), `${JSON.stringify({ ...entry, at: Date.now() })}\n`, 'utf8');
  const prefs = await readDispatchPrefs();
  if (entry.picked !== entry.chosen) {
    prefs[entry.kind] = { ...prefs[entry.kind], [entry.chosen]: (prefs[entry.kind]?.[entry.chosen] ?? 0) + 1 };
    await fs.writeFile(dispatchPrefsFile(), JSON.stringify(prefs, null, 2), 'utf8');
  }
  return prefs;
}

async function journalState(date: string): Promise<JournalState> {
  const root = projectsRoot();
  const yesterday = new Date(`${date}T12:00:00`);
  yesterday.setDate(yesterday.getDate() - 1);
  const [day, before, streak] = await Promise.all([
    readJournal(root, date),
    readJournal(root, localDate(yesterday)),
    journalStreak(root, date),
  ]);
  return { day, carried: before.tomorrow, streak, dir: lifeDir(root) };
}

export function initCockpitBridge(): void {
  ipcBridge.cockpit.getJournal.provider(({ date }) => journalState(date));
  ipcBridge.cockpit.saveJournal.provider(async (day) => {
    await saveJournal(projectsRoot(), day);
    return journalState(day.date);
  });
  ipcBridge.cockpit.getDispatchPrefs.provider(() => readDispatchPrefs());
  ipcBridge.cockpit.recordDispatch.provider((entry) => recordDispatch(entry));
  ipcBridge.cockpit.pulse.provider(async ({ force }) => (await getPulse()).snapshot(Boolean(force)));
  ipcBridge.cockpit.setGameMode.provider(async ({ on }) => (await getPulse()).setGameMode(on));
  ipcBridge.cockpit.setModelLoaded.provider(async ({ model, loaded }) => {
    await (loaded ? loadModel(model) : unloadModel(model));
    return (await getPulse()).snapshot();
  });
  ipcBridge.cockpit.listProjects.provider(async () => {
    const root = projectsRoot();
    const hidden = await readHiddenProjects(path.join(getSystemDir().workDir, 'cockpit-hidden-projects.json'));
    return { root, projects: await listLanternProjects(root, hidden) };
  });
  ipcBridge.cockpit.gitStatus.provider(async ({ dirs }) =>
    Object.fromEntries(await Promise.all(dirs.map(async (dir) => [dir, await gitStatus(dir)] as const)))
  );
  ipcBridge.cockpit.readContextFile.provider(({ file }) => readContextFile(projectsRoot(), file));
  ipcBridge.cockpit.macServices.provider(({ prefixes }) => macServices(prefixes));
  ipcBridge.cockpit.getSideChats.provider(() => readSideChats(sideChatsFile()));
  ipcBridge.cockpit.setSideChat.provider(({ target, conversation_id }) =>
    setSideChat(sideChatsFile(), target, conversation_id)
  );
  ipcBridge.cockpit.getBoardLayout.provider(({ project }) => getBoardLayout(boardLayoutFile(), project));
  ipcBridge.cockpit.saveBoardLayout.provider(({ project, positions }) =>
    saveBoardLayout(boardLayoutFile(), project, positions)
  );
  ipcBridge.cockpit.getSharedSkillsDir.provider(async () => {
    const dir = sharedSkillsDir();
    await fs.mkdir(dir, { recursive: true });
    return { path: dir, skills: await listSkillFolders(dir) };
  });
  ipcBridge.cockpit.listRemoteDir.provider(({ dir, ...host }) =>
    listRemoteDir(host, dir).catch((error: Error) => ({ path: dir, dirs: [] as string[], error: error.message }))
  );
  ipcBridge.cockpit.openRemoteProject.provider(async (marker) => {
    try {
      return { workspace: await createRemoteProject(marker), agent_id: await ensureRemoteClaudeAgent() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcBridge.cockpit.writeHandoffTranscript.provider(({ conversation_id, content }) =>
    writeHandoffTranscript(getSystemDir().cacheDir, conversation_id, content)
  );
}
