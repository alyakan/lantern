/**
 * Ctrl+K palette entries: projects, modules, chats and actions, plus the
 * matcher that ranks them. Pure, so it can be tested.
 */

import type { LanternProject } from '@/common/types/cockpitProjects';

export type PaletteGroup = 'project' | 'module' | 'chat' | 'action';

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  title: string;
  /** Second line: project name, folder or a hint. */
  meta?: string;
  /** Extra words that match but are not shown (aliases). */
  keywords?: string;
  /** Where it goes: a route, or an action id for the palette to run. */
  route?: string;
  action?: string;
};

export type PaletteChat = { id: string; name: string; workspace?: string; modifiedAt?: number };

const GROUP_ORDER: PaletteGroup[] = ['action', 'project', 'module', 'chat'];

/** Board link that opens the board with this project or module selected in the side panel. */
export const boardSelectRoute = (key: string) => `/board?select=${encodeURIComponent(key)}`;

export function buildPaletteItems(input: {
  projects: LanternProject[];
  chats: PaletteChat[];
  actions: PaletteItem[];
}): PaletteItem[] {
  const items: PaletteItem[] = [...input.actions];
  for (const project of input.projects) {
    items.push({
      id: `project:${project.dir}`,
      group: 'project',
      title: project.name,
      meta: project.summary ?? project.dir,
      route: boardSelectRoute(`project:${project.dir}`),
    });
    for (const module of project.modules) {
      items.push({
        id: `module:${project.dir}#${module.id}`,
        group: 'module',
        title: module.name,
        meta: project.name,
        keywords: [module.summary, module.llm, module.runsOn].filter(Boolean).join(' '),
        route: boardSelectRoute(`module:${project.dir}#${module.id}`),
      });
    }
  }
  const chats = input.chats.toSorted((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  for (const chat of chats) {
    items.push({
      id: `chat:${chat.id}`,
      group: 'chat',
      title: chat.name,
      meta: chat.workspace,
      route: `/conversation/${chat.id}`,
    });
  }
  return items;
}

/**
 * Score one item against the query: every word must appear somewhere; a title
 * that starts with the query beats a word start, which beats a match inside a
 * word or in the meta line. Returns -1 when it does not match.
 */
export function scoreItem(item: PaletteItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const title = item.title.toLowerCase();
  const haystack = `${title} ${(item.meta ?? '').toLowerCase()} ${(item.keywords ?? '').toLowerCase()}`;
  const words = q.split(/\s+/);
  if (!words.every((word) => haystack.includes(word))) return -1;
  if (title.startsWith(q)) return 100;
  if (title.split(/[\s·\-_/]+/).some((part) => part.startsWith(words[0]))) return 60;
  if (title.includes(words[0])) return 40;
  return 10;
}

/**
 * Filter and rank. With no query: actions first, then projects, modules and the
 * most recent chats. With a query: best score first, group order breaks ties.
 */
export function filterPalette(items: PaletteItem[], query: string, limit = 40): PaletteItem[] {
  const rank = (item: PaletteItem) => GROUP_ORDER.indexOf(item.group);
  if (!query.trim()) {
    const recentChats = items.filter((item) => item.group === 'chat').slice(0, 8);
    return [...items.filter((item) => item.group !== 'chat'), ...recentChats]
      .toSorted((a, b) => rank(a) - rank(b))
      .slice(0, limit);
  }
  return items
    .map((item) => ({ item, score: scoreItem(item, query) }))
    .filter((entry) => entry.score >= 0)
    .toSorted((a, b) => b.score - a.score || rank(a.item) - rank(b.item))
    .slice(0, limit)
    .map((entry) => entry.item);
}
