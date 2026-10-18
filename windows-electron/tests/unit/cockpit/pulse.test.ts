import { describe, expect, it } from 'vitest';
import { parseClaudeEvent, parseCodexLine } from '@process/cockpit/pulse';
import { exhaustAt, formatIn, formatVram, headroom, levelOf, WEEK } from '@renderer/pages/cockpit/pulse/pulseMath';

describe('pulse parsing', () => {
  it('reads Claude rate_limit_event windows as percentages', () => {
    const usage = parseClaudeEvent(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          isUsingOverage: false,
          unifiedWindows: {
            five_hour: { utilization: 0.08, resetsAt: 100 },
            seven_day: { utilization: 0.4, resetsAt: 200 },
          },
        },
      },
      5
    );
    expect(usage?.fiveHour).toEqual({ usedPercent: 8, resetsAt: 100 });
    expect(usage?.week).toEqual({ usedPercent: 40, resetsAt: 200 });
    expect(usage?.note).toBeUndefined();
  });

  it('flags a rejected Claude status', () => {
    const usage = parseClaudeEvent(
      { rate_limit_info: { status: 'rejected', unifiedWindows: { five_hour: { utilization: 1 } } } },
      1
    );
    expect(usage?.note).toBe('limit reached');
  });

  it('reads Codex rate_limits from a token_count line', () => {
    const line = JSON.stringify({
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 4, window_minutes: 300, resets_at: 10 },
          secondary: { used_percent: 2, window_minutes: 10080, resets_at: 20 },
          plan_type: 'plus',
          rate_limit_reached_type: null,
        },
      },
    });
    const usage = parseCodexLine(line, 3);
    expect(usage).toMatchObject({ fiveHour: { usedPercent: 4 }, week: { usedPercent: 2 }, plan: 'plus' });
    expect(usage?.note).toBeUndefined();
  });

  it('ignores lines without limits', () => {
    expect(parseCodexLine('{"payload":{}}', 1)).toBeUndefined();
    expect(parseCodexLine('not json "rate_limits"', 1)).toBeUndefined();
  });
});

describe('pulse math', () => {
  it('levels', () => {
    expect([levelOf(10), levelOf(70), levelOf(90)]).toEqual(['ok', 'warn', 'hot']);
  });

  it('forecasts running out before the reset when the pace is too fast', () => {
    const now = 1_000_000;
    // Half the week gone, 80 % used: 100 % comes at 62.5 % of the week, before the reset.
    const at = exhaustAt({ usedPercent: 80, resetsAt: now + WEEK / 2 }, WEEK, now);
    expect(at).toBeDefined();
    expect(at! - now).toBeCloseTo(WEEK / 8, -1);
  });

  it('no forecast when the pace finishes the window', () => {
    const now = 1_000_000;
    expect(exhaustAt({ usedPercent: 20, resetsAt: now + WEEK / 2 }, WEEK, now)).toBeUndefined();
  });

  it('headroom is the tighter window', () => {
    expect(headroom({ fiveHour: { usedPercent: 10 }, week: { usedPercent: 70 }, seenAt: 0 })).toBe(30);
    expect(headroom(undefined)).toBeUndefined();
  });

  it('formats', () => {
    expect(formatIn(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatVram(20 * 1024 ** 3, 24 * 1024 ** 3)).toBe('20/24 GB');
  });
});
