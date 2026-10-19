import { describe, expect, it } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import type { LanternProject } from '@/common/types/cockpitProjects';
import { mergeBoardProjects } from '@renderer/pages/conversation/GroupedHistory/utils/boardProjectGroups';

const project = (dir: string, name: string): LanternProject => ({
  dir,
  name,
  members: [],
  servicePrefixes: [],
  contextFiles: [],
  modules: [],
});
const chat = { id: 'c1' } as TChatConversation;

describe('mergeBoardProjects', () => {
  it('keeps chat folders first and names them like the board', () => {
    const groups = [{ workspace: 'C:\\P\\cockpit\\', displayName: 'cockpit', conversations: [chat] }];
    const merged = mergeBoardProjects(groups, [project('C:/P/cockpit', 'Lantern')]);
    expect(merged).toEqual([
      { workspace: 'C:\\P\\cockpit\\', displayName: 'Lantern', conversations: [chat], boardDir: 'C:/P/cockpit' },
    ]);
  });

  it('adds board projects without chats after them, sorted by name', () => {
    const groups = [{ workspace: 'D:/scratch', displayName: 'scratch', conversations: [chat] }];
    const merged = mergeBoardProjects(groups, [project('C:/P/TV', 'TV Tracker'), project('C:/P/Job', 'Job Hunt')]);
    expect(merged.map((group) => [group.displayName, group.conversations.length, group.boardDir])).toEqual([
      ['scratch', 1, undefined],
      ['Job Hunt', 0, 'C:/P/Job'],
      ['TV Tracker', 0, 'C:/P/TV'],
    ]);
  });
});
