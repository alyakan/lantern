/**
 * Project board (Phase 3) data shared by the main process and the renderer.
 */

export type LanternModule = {
  id: string;
  name: string;
  kind: 'operator' | 'agent' | 'service' | 'tool';
  icon?: string;
  color?: string;
  runsOn?: string;
  llm?: string;
  summary?: string;
  tools?: string[];
  links?: string[];
  /** Absolute path of the module's notes file, when it exists. */
  context?: string;
  /** Absolute working folder for the module's chats. */
  folder: string;
  services?: string[];
};

export type LanternProject = {
  dir: string;
  name: string;
  color?: string;
  summary?: string;
  members: string[];
  servicePrefixes: string[];
  /** Absolute paths of CLAUDE.md / AGENTS.md / CONTEXT.md / project context that exist. */
  contextFiles: string[];
  modules: LanternModule[];
};

export type GitStatus = { dir: string; branch: string; ahead: number; behind: number; dirty: number };
export type MacService = { label: string; pid: number | null; lastExit: number; running: boolean };
