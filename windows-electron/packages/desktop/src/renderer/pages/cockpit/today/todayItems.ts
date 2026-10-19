/**
 * What needs Nezar across all projects, most urgent first. Pure, so it can be tested.
 */
import type { GitStatus, MacService } from '@/common/types/cockpitProjects';

export type NeedsItem = {
  key: string;
  kind: 'waiting' | 'serviceFailed' | 'macUnreachable' | 'unpushed' | 'behind' | 'dirty';
  severity: 'high' | 'medium' | 'low';
  values: Record<string, string | number>;
  conversationId?: string;
};

const RANK = { high: 0, medium: 1, low: 2 };

const baseName = (dir: string) =>
  dir
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() ?? dir;

export function needsYouItems(input: {
  waiting: { id: string; name: string }[];
  git: GitStatus[];
  services: MacService[];
  macError?: string;
}): NeedsItem[] {
  const items: NeedsItem[] = [];
  for (const chat of input.waiting) {
    items.push({
      key: `w:${chat.id}`,
      kind: 'waiting',
      severity: 'high',
      values: { name: chat.name },
      conversationId: chat.id,
    });
  }
  if (input.macError) {
    items.push({ key: 'mac', kind: 'macUnreachable', severity: 'medium', values: {} });
  }
  for (const service of input.services) {
    if (!service.running && service.lastExit !== 0) {
      items.push({
        key: `s:${service.label}`,
        kind: 'serviceFailed',
        severity: 'high',
        values: { label: service.label, code: service.lastExit },
      });
    }
  }
  for (const repo of input.git) {
    const name = baseName(repo.dir);
    if (repo.ahead > 0)
      items.push({ key: `a:${repo.dir}`, kind: 'unpushed', severity: 'medium', values: { name, count: repo.ahead } });
    if (repo.behind > 0)
      items.push({ key: `b:${repo.dir}`, kind: 'behind', severity: 'low', values: { name, count: repo.behind } });
    if (repo.dirty > 0)
      items.push({ key: `d:${repo.dir}`, kind: 'dirty', severity: 'low', values: { name, count: repo.dirty } });
  }
  return items.toSorted((a, b) => RANK[a.severity] - RANK[b.severity]);
}

export function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
