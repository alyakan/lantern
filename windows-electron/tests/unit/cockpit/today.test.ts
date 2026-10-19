import { describe, expect, it } from 'vitest';
import { parseJournal, renderJournal } from '@process/cockpit/lifeJournal';
import { needsYouItems } from '@renderer/pages/cockpit/today/todayItems';

describe('life journal', () => {
  it('round-trips a day through Markdown', () => {
    const day = { date: '2026-10-18', intention: 'Ship it', wins: 'Pulse works\nDispatch too', tomorrow: 'Rest' };
    const text = renderJournal(day);
    expect(text).toContain('## What went well');
    expect(text).not.toContain('## What drained me');
    expect(parseJournal('2026-10-18', text)).toEqual(day);
  });

  it('ignores unknown sections', () => {
    const day = parseJournal('d', '# d\n\n## Intention\n\nFocus\n\n## Notes\n\nextra\n');
    expect(day.intention).toBe('Focus');
  });
});

describe('needs you', () => {
  it('puts waiting chats and failed services first', () => {
    const items = needsYouItems({
      waiting: [{ id: 'c1', name: 'Weekly review' }],
      git: [{ dir: 'C:\\Users\\Nezar\\Projects\\Rayak', branch: 'main', ahead: 2, behind: 0, dirty: 3 }],
      services: [
        { label: 'com.rayak.grocery.refresh', pid: null, lastExit: 1, running: false },
        { label: 'com.rayak.ok', pid: 12, lastExit: 0, running: true },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(['waiting', 'serviceFailed', 'unpushed', 'dirty']);
    expect(items[2].values).toEqual({ name: 'Rayak', count: 2 });
    expect(items[0].conversationId).toBe('c1');
  });

  it('is empty when all is clear', () => {
    expect(needsYouItems({ waiting: [], git: [], services: [] })).toEqual([]);
  });
});
