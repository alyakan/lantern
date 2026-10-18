/**
 * Lantern look: "classic" (today's layout, graphite + signal orange) or "hud"
 * (the space board with cream module plates). It is a second axis next to
 * light/dark: `data-lantern-style` on <html> picks the style, `data-theme`
 * still picks light or dark. Persisted in config and mirrored to localStorage
 * so the first paint already has the right look.
 */

import { useSyncExternalStore } from 'react';
import { configService } from '@/common/config/configService';

export type LanternStyle = 'classic' | 'hud';

export const LANTERN_STYLES: LanternStyle[] = ['classic', 'hud'];
const DEFAULT_STYLE: LanternStyle = 'hud';
const CACHE_KEY = '__lantern_style';

const listeners = new Set<() => void>();
let current: LanternStyle = DEFAULT_STYLE;

const isStyle = (value: unknown): value is LanternStyle => value === 'classic' || value === 'hud';

function apply(style: LanternStyle): void {
  current = style;
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-lantern-style', style);
  listeners.forEach((listener) => listener());
}

function readCache(): LanternStyle {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    return isStyle(cached) ? cached : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

if (typeof window !== 'undefined') {
  apply(readCache());
  void configService
    .whenReady()
    .then(() => {
      const saved = configService.get('ui.lanternStyle');
      if (isStyle(saved) && saved !== current) apply(saved);
    })
    .catch(() => {});
  // Other windows (and the settings page) change it through config.
  configService.subscribe('ui.lanternStyle', (value) => {
    if (isStyle(value) && value !== current) apply(value);
  });
}

export function getLanternStyle(): LanternStyle {
  return current;
}

export async function setLanternStyle(style: LanternStyle): Promise<void> {
  apply(style);
  try {
    localStorage.setItem(CACHE_KEY, style);
  } catch {
    /* noop */
  }
  await configService.set('ui.lanternStyle', style);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The active Lantern style; re-renders when it changes. */
export function useLanternStyle(): LanternStyle {
  return useSyncExternalStore(subscribe, getLanternStyle, () => DEFAULT_STYLE);
}
