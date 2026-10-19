/**
 * Project board data (Phase 3): every folder under the projects root is a
 * frame; folders with `.lantern/project.json` bring their modules. Also git
 * status per folder and live launchd services on the Mac mini over SSH.
 * Context stays in the project as files; this only reports where it is.
 */
import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Dirent } from 'fs';
import type { GitStatus, LanternModule, LanternProject, MacService } from '@/common/types/cockpitProjects';

export type { GitStatus, LanternModule, LanternProject, MacService };

const CONTEXT_NAMES = ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md', '.cockpit/CONTEXT.md'];
const MODULE_KINDS = new Set(['operator', 'agent', 'service', 'tool']);

export function projectsRoot(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return env.COCKPIT_PROJECTS_ROOT?.trim() || path.join(home, 'Projects');
}

const exists = (file: string) =>
  fs.stat(file).then(
    () => true,
    () => false
  );

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Parse one `.lantern/project.json` (already JSON-decoded) into a project; tolerant of missing fields. */
export async function parseLanternProject(dir: string, raw: unknown): Promise<LanternProject> {
  const data = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const contextFiles: string[] = [];
  const candidates = [...CONTEXT_NAMES, asString(data.context)].filter((name): name is string => Boolean(name));
  for (const name of new Set(candidates)) {
    const file = path.resolve(dir, name);
    if (await exists(file)) contextFiles.push(file);
  }
  const modules: LanternModule[] = [];
  for (const item of Array.isArray(data.modules) ? data.modules : []) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const id = asString(m.id);
    if (!id) continue;
    const kind = asString(m.kind) ?? 'agent';
    const contextPath = asString(m.context) ? path.resolve(dir, m.context as string) : undefined;
    modules.push({
      id,
      name: asString(m.name) ?? id,
      kind: (MODULE_KINDS.has(kind) ? kind : 'agent') as LanternModule['kind'],
      icon: asString(m.icon),
      color: asString(m.color),
      runsOn: asString(m.runsOn),
      llm: asString(m.llm),
      summary: asString(m.summary),
      tools: asStrings(m.tools),
      links: asStrings(m.links),
      context: contextPath && (await exists(contextPath)) ? contextPath : undefined,
      folder: path.resolve(dir, asString(m.folder) ?? '.'),
      services: asStrings(m.services),
    });
  }
  return {
    dir,
    name: asString(data.name) ?? path.basename(dir),
    color: asString(data.color),
    summary: asString(data.summary),
    members: asStrings(data.members).map((member) => path.resolve(dir, member)),
    servicePrefixes: asStrings(data.servicePrefixes),
    contextFiles,
    modules,
  };
}

/** The cockpit's own folder in a project; `.lantern` is read as a fallback for older projects. */
export const PROJECT_FOLDERS = ['.cockpit', '.lantern'];

async function readProjectFile(dir: string): Promise<unknown> {
  for (const folder of PROJECT_FOLDERS) {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, folder, 'project.json'), 'utf8')) as unknown;
    } catch {
      // try the next folder
    }
  }
  return {};
}

const MAX_CONTEXT_BYTES = 200_000;

/**
 * Read a project's Markdown context file for the side panel. Only `.md`
 * files inside the projects root are served.
 */
export async function readContextFile(root: string, file: string): Promise<{ content?: string; error?: string }> {
  const resolved = path.resolve(file);
  const base = path.resolve(root) + path.sep;
  if (!resolved.toLowerCase().startsWith(base.toLowerCase()) || path.extname(resolved).toLowerCase() !== '.md')
    return { error: 'not a project context file' };
  try {
    const text = await fs.readFile(resolved, 'utf8');
    return { content: text.length > MAX_CONTEXT_BYTES ? `${text.slice(0, MAX_CONTEXT_BYTES)}\n\n…` : text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Folders left off the board by default (names, case-insensitive). Lantern was replaced by the cockpit. */
export const DEFAULT_HIDDEN_PROJECTS = ['Lantern'];

/** Every folder in `root` as a project, except hidden ones; `.lantern/project.json` adds modules. */
export async function listLanternProjects(
  root: string,
  hidden: string[] = DEFAULT_HIDDEN_PROJECTS
): Promise<LanternProject[]> {
  const skip = new Set(hidden.map((name) => name.toLowerCase()));
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((): Dirent[] => []);
  const projects = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name.toLowerCase()))
      .map(async (entry) => {
        const dir = path.join(root, entry.name);
        return parseLanternProject(dir, await readProjectFile(dir));
      })
  );
  // Projects with modules first (largest first), then the rest by name.
  return projects.toSorted(
    (a, b) => b.modules.length - a.modules.length || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}

function run(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
  });
}

/** Parse `git status --porcelain=v2 --branch`. */
export function parseGitStatus(dir: string, output: string): GitStatus {
  let branch = '';
  let ahead = 0;
  let behind = 0;
  let dirty = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      if (match) [ahead, behind] = [Number(match[1]), Number(match[2])];
    } else if (line && !line.startsWith('#')) dirty += 1;
  }
  return { dir, branch, ahead, behind, dirty };
}

export async function gitStatus(dir: string): Promise<GitStatus | null> {
  if (!(await exists(path.join(dir, '.git')))) return null;
  try {
    return parseGitStatus(dir, await run('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'], 5000));
  } catch {
    return null;
  }
}

/** Parse `launchctl list` (PID, Status, Label columns), keeping labels with one of the prefixes. */
export function parseLaunchctlList(output: string, prefixes: string[]): MacService[] {
  const services: MacService[] = [];
  for (const line of output.split(/\r?\n/).slice(1)) {
    const [pid, status, label] = line.trim().split(/\s+/);
    if (!label || !prefixes.some((prefix) => label.startsWith(prefix))) continue;
    const pidNumber = pid === '-' ? null : Number(pid);
    services.push({ label, pid: pidNumber, lastExit: Number(status) || 0, running: pidNumber !== null });
  }
  return services.toSorted((a, b) => a.label.localeCompare(b.label));
}

type MacHost = { host: string; user: string; key: string };

/** The Mac mini SSH target: ~/.ssh/lantern_macmini plus its .host/.user files. */
export async function macHost(home: string = os.homedir()): Promise<MacHost> {
  const key = path.join(home, '.ssh', 'lantern_macmini');
  const read = (suffix: string, fallback: string) =>
    fs
      .readFile(`${key}.${suffix}`, 'utf8')
      .then((text) => text.trim() || fallback)
      .catch(() => fallback);
  return { key, host: await read('host', 'mac-mini.local'), user: await read('user', os.userInfo().username) };
}

/** Hidden folder names from `<file>` (a JSON array); written with the defaults when missing. */
export async function readHiddenProjects(file: string): Promise<string[]> {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    return asStrings(value);
  } catch {
    await fs.mkdir(path.dirname(file), { recursive: true }).catch((): void => undefined);
    await fs.writeFile(file, JSON.stringify(DEFAULT_HIDDEN_PROJECTS, null, 2), 'utf8').catch((): void => undefined);
    return DEFAULT_HIDDEN_PROJECTS;
  }
}

let serviceCache: { at: number; output: string } | undefined;
const SERVICE_TTL_MS = 20_000;

export async function macServices(prefixes: string[]): Promise<{ services: MacService[]; error?: string }> {
  if (prefixes.length === 0) return { services: [] };
  try {
    if (!serviceCache || Date.now() - serviceCache.at > SERVICE_TTL_MS) {
      const { host, user, key } = await macHost();
      const output = await run(
        'ssh',
        ['-i', key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6', `${user}@${host}`, 'launchctl list'],
        12_000
      );
      serviceCache = { at: Date.now(), output };
    }
    return { services: parseLaunchctlList(serviceCache.output, prefixes) };
  } catch (error) {
    return { services: [], error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
  }
}
