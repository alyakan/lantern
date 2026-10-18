/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SINGLE_SESSION_ID,
  SINGLE_TARGET_ID,
  buildReannounceEvents,
  buildTargetInfo,
} from '@process/resources/builtinMcp/cdpTargetProtocol';

describe('buildReannounceEvents', () => {
  const info = buildTargetInfo('Cairo', 'https://en.wikipedia.org/wiki/Cairo');

  it('drops the old page before announcing it again', () => {
    expect(buildReannounceEvents(info).map((e) => e.method)).toEqual([
      'Target.detachedFromTarget',
      'Target.targetDestroyed',
      'Target.targetCreated',
      'Target.attachedToTarget',
    ]);
  });

  it('reuses the single target and session ids with the current page info', () => {
    const events = buildReannounceEvents(info);
    expect(events[0].params).toEqual({ sessionId: SINGLE_SESSION_ID, targetId: SINGLE_TARGET_ID });
    expect(events[1].params).toEqual({ targetId: SINGLE_TARGET_ID });
    expect(events[2].params).toEqual({ targetInfo: info });
    expect(events[3].params).toEqual({ sessionId: SINGLE_SESSION_ID, targetInfo: info, waitingForDebugger: false });
  });
});
