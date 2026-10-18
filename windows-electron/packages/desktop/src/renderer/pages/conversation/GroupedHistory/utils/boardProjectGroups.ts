import type { TChatConversation } from '@/common/config/storage';
import type { LanternProject } from '@/common/types/cockpitProjects';

export type ProjectGroup = {
  workspace: string;
  displayName: string;
  conversations: TChatConversation[];
  /** Set when the folder is a Lantern board project. */
  boardDir?: string;
};

const normalizeDir = (dir: string) =>
  dir
    .replace(/[\\/]+$/, '')
    .replace(/\\/g, '/')
    .toLowerCase();

/**
 * Adds the board's projects to the sidebar's project groups. Folders that
 * already have chats keep their place and take the board name; board projects
 * with no chats yet follow, sorted by name, so imported projects show up too.
 */
export function mergeBoardProjects(groups: ProjectGroup[], projects: LanternProject[]): ProjectGroup[] {
  const byDir = new Map(projects.map((project) => [normalizeDir(project.dir), project]));
  const seen = new Set<string>();
  const merged = groups.map((group) => {
    const key = normalizeDir(group.workspace);
    const project = byDir.get(key);
    if (!project) return group;
    seen.add(key);
    return { ...group, displayName: project.name, boardDir: project.dir };
  });
  const empty = projects
    .filter((project) => !seen.has(normalizeDir(project.dir)))
    .map((project) => ({
      workspace: project.dir,
      displayName: project.name,
      conversations: [] as TChatConversation[],
      boardDir: project.dir,
    }))
    .toSorted((a, b) => a.displayName.localeCompare(b.displayName));
  return [...merged, ...empty];
}
