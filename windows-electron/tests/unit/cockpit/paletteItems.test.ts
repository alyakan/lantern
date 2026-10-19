import { describe, expect, it } from 'vitest';
import type { LanternProject } from '@/common/types/cockpitProjects';
import {
  boardSelectRoute,
  buildPaletteItems,
  filterPalette,
  scoreItem,
  type PaletteItem,
} from '@renderer/pages/cockpit/palette/paletteItems';

const rayak: LanternProject = {
  dir: 'C:/P/Rayak',
  name: 'Rayak',
  summary: 'price comparison',
  members: [],
  servicePrefixes: [],
  contextFiles: [],
  modules: [
    { id: 'web', name: 'Website', kind: 'agent', folder: 'C:/P/Rayak/web', llm: 'Codex' },
    { id: 'scrape', name: 'Daily scraping', kind: 'service', folder: 'C:/P/Rayak', runsOn: 'Mac mini' },
  ],
};
const actions: PaletteItem[] = [{ id: 'a:new', group: 'action', title: 'New chat', route: '/guid' }];
const chats = [
  { id: 'c1', name: 'Old talk', modifiedAt: 1 },
  { id: 'c2', name: 'Website speed', modifiedAt: 5 },
];

describe('palette', () => {
  const items = buildPaletteItems({ projects: [rayak], chats, actions });

  it('builds projects, modules and chats with board routes', () => {
    expect(items.map((item) => item.id)).toEqual([
      'a:new',
      'project:C:/P/Rayak',
      'module:C:/P/Rayak#web',
      'module:C:/P/Rayak#scrape',
      'chat:c2',
      'chat:c1',
    ]);
    expect(items[2].route).toBe(boardSelectRoute('module:C:/P/Rayak#web'));
  });

  it('ranks a title prefix above a match in the meta line', () => {
    const results = filterPalette(items, 'web');
    expect(results[0].id).toBe('module:C:/P/Rayak#web');
    expect(results.map((item) => item.id)).toContain('chat:c2');
  });

  it('needs every word and matches hidden keywords', () => {
    expect(filterPalette(items, 'rayak scraping').map((item) => item.id)).toEqual(['module:C:/P/Rayak#scrape']);
    expect(filterPalette(items, 'mac mini')[0].id).toBe('module:C:/P/Rayak#scrape');
    expect(scoreItem(items[0], 'zzz')).toBe(-1);
  });

  it('shows actions first when the query is empty', () => {
    expect(filterPalette(items, '')[0].group).toBe('action');
  });
});
