/**
 * The dispatcher: which agent should do this task, given what it is, what Nezar cares about right now
 * (tokens, quality or speed) and how much of each plan is left. Pure and local: it never calls a model.
 */
import type { PulseSnapshot } from '@/common/types/cockpitPulse';
import { headroom } from '../pulse/pulseMath';

export type TaskKind = 'quick' | 'writing' | 'codeSmall' | 'codeLarge' | 'research' | 'personal' | 'ops' | 'mechanical';

export type Goal = 'auto' | 'thrifty' | 'balanced' | 'best' | 'fast';
export type Tone = 'claude' | 'codex' | 'qwen' | 'remote' | 'other';

export type DispatchCandidate = {
  key: string;
  label: string;
  tone: Tone;
  assistantId: string;
};

/** A reason is an i18n key under `cockpit.dispatch.reason` plus its values. */
export type Reason = { key: string; values?: Record<string, string | number> };

export type Ranked = {
  candidate: DispatchCandidate;
  score: number;
  reasons: Reason[];
  /** Rough share of the plan's 5-hour window the task may use, when the plan has limits. */
  costPercent?: number;
};

export type DispatchResult = { kind: TaskKind; goal: Exclude<Goal, 'auto'>; ranked: Ranked[] };

/** How often Nezar overrode the pick, per kind: which tone he chose instead. */
export type DispatchPrefs = Partial<Record<TaskKind, Partial<Record<Tone, number>>>>;

const RULES: [TaskKind, RegExp][] = [
  [
    'personal',
    /\b(journal|diary|feel(ing)?s?|anxious|stress(ed)?|sleep|health|workout|diet|relationship|my (wife|partner|family|mom|dad|friend)|reflect(ion)?|therapy|habit|motivation|private|personal)\b/i,
  ],
  [
    'ops',
    /\b(mac ?mini|launchd|launchctl|server|deploy|cron|pipeline|scraper|scraping|ssh|service(s)? (is |are )?(down|failing)|logs?|meilisearch|supabase)\b/i,
  ],
  [
    'research',
    /\b(research|look up|search( the web)?|find out|compare|latest|news|what('s| is) new|browse|website|docs? for|pricing of)\b/i,
  ],
  [
    'mechanical',
    /\b(rename|reformat|format|convert|boilerplate|bump|lint|typo|sort|dedupe|translate|regex|csv|json to|yaml|extract (the )?(list|table))\b/i,
  ],
  [
    'codeLarge',
    /\b(refactor|architect(ure)?|redesign|rewrite (the|a) (module|app|system)|migrate|implement( a| the)? (feature|system)|build (a|an|the) (app|feature|service)|across (the )?(codebase|files|repo)|multi-?file|phase \d)\b/i,
  ],
  [
    'codeSmall',
    /\b(bug|fix|error|exception|stack ?trace|function|component|test(s)?|typescript|python|rust|css|sql|query|endpoint|script)\b/i,
  ],
  [
    'writing',
    /\b(write|draft|blog|article|post|copy|email|newsletter|tweet|linkedin|essay|edit (my|this)|proofread|headline|invoice|proposal|cover letter|outline)\b/i,
  ],
];

/** Best-effort task kind from the words used. Short questions with no other signal are "quick". */
export function classifyTask(text: string): TaskKind {
  for (const [kind, pattern] of RULES) if (pattern.test(text)) return kind;
  return text.trim().split(/\s+/).length <= 25 ? 'quick' : 'writing';
}

/** Quality per kind, 0–10. Qwen 27B is strong for its size but not a frontier model and has no web. */
const QUALITY: Record<Tone, Record<TaskKind, number>> = {
  claude: { quick: 8, writing: 10, codeSmall: 9, codeLarge: 10, research: 9, personal: 9, ops: 9, mechanical: 8 },
  codex: { quick: 8, writing: 7, codeSmall: 9, codeLarge: 9, research: 8, personal: 7, ops: 8, mechanical: 8 },
  qwen: { quick: 6, writing: 5, codeSmall: 6, codeLarge: 4, research: 2, personal: 7, ops: 4, mechanical: 7 },
  remote: { quick: 7, writing: 8, codeSmall: 8, codeLarge: 8, research: 7, personal: 5, ops: 10, mechanical: 7 },
  other: { quick: 6, writing: 6, codeSmall: 6, codeLarge: 6, research: 6, personal: 5, ops: 6, mechanical: 6 },
};

/** Rough share of a 5-hour window each kind of task uses on a subscription plan. */
const COST_PERCENT: Record<TaskKind, number> = {
  quick: 0.5,
  writing: 3,
  codeSmall: 3,
  codeLarge: 12,
  research: 4,
  personal: 1,
  ops: 4,
  mechanical: 2,
};

const WEIGHTS: Record<Exclude<Goal, 'auto'>, { quality: number; speed: number; cost: number }> = {
  thrifty: { quality: 0.3, speed: 0.1, cost: 0.6 },
  balanced: { quality: 0.55, speed: 0.15, cost: 0.3 },
  best: { quality: 0.85, speed: 0.05, cost: 0.1 },
  fast: { quality: 0.35, speed: 0.55, cost: 0.1 },
};

/** What "Auto" means for each kind of task. */
export const AUTO_GOAL: Record<TaskKind, Exclude<Goal, 'auto'>> = {
  quick: 'thrifty',
  writing: 'best',
  codeSmall: 'balanced',
  codeLarge: 'best',
  research: 'balanced',
  personal: 'thrifty',
  ops: 'balanced',
  mechanical: 'thrifty',
};

export function toneOf(name: string, backend?: string): Tone {
  const n = `${backend ?? ''} ${name}`.toLowerCase();
  if (n.includes('mac mini') || n.includes('remote')) return 'remote';
  if (n.includes('claude')) return 'claude';
  if (n.includes('codex')) return 'codex';
  if (n.includes('aionrs') || n.includes('aion') || n.includes('qwen') || n.includes('ollama')) return 'qwen';
  return 'other';
}

export function dispatch(
  text: string,
  goal: Goal,
  candidates: DispatchCandidate[],
  pulse: PulseSnapshot | undefined,
  prefs: DispatchPrefs = {}
): DispatchResult {
  const kind = classifyTask(text);
  const resolved = goal === 'auto' ? AUTO_GOAL[kind] : goal;
  const weights = WEIGHTS[resolved];
  const qwenLoaded = (pulse?.qwen.loaded.length ?? 0) > 0;
  const qwenUp = pulse?.qwen.running ?? true;
  const bestQuality = Math.max(0, ...candidates.map((c) => QUALITY[c.tone][kind]));

  const ranked: Ranked[] = candidates.map((candidate) => {
    const reasons: Reason[] = [];
    const tone = candidate.tone;
    let quality = QUALITY[tone][kind];
    let speed = 6;
    let cost: number;
    let costPercent: number | undefined;
    let penalty = 0;

    if (tone === 'qwen') {
      cost = 10;
      speed = qwenLoaded ? 6 : 3;
      reasons.push({ key: 'free' });
      if (!qwenLoaded && qwenUp) reasons.push({ key: 'coldStart' });
      if (!qwenUp) {
        penalty += 100;
        reasons.push({ key: 'ollamaOff' });
      }
      if (pulse?.gameMode) {
        penalty += 100;
        reasons.push({ key: 'gameMode' });
      }
      if (kind === 'research') reasons.push({ key: 'noWeb' });
    } else {
      const plan = tone === 'codex' ? pulse?.codex : tone === 'claude' || tone === 'remote' ? pulse?.claude : undefined;
      const left = headroom(plan);
      costPercent = COST_PERCENT[kind];
      // Spending plan tokens is never free: a full plan scores 7 against the local model's 10.
      cost = left === undefined ? 4 : (7 * left) / 100;
      if (left !== undefined) {
        reasons.push({ key: 'headroom', values: { left: Math.round(left), cost: costPercent } });
        if (left < 10) {
          penalty += 50;
          reasons.push({ key: 'nearLimit' });
        } else if (left < costPercent * 2) {
          penalty += 4;
        }
      }
    }

    if (kind === 'personal') {
      if (tone === 'qwen') {
        quality += 4;
        reasons.unshift({ key: 'private' });
      } else {
        reasons.push({ key: 'leavesPc' });
      }
    }
    if (kind === 'ops' && tone === 'remote') reasons.unshift({ key: 'onMac' });
    const own = QUALITY[tone][kind];
    if (own === bestQuality && own >= 8) reasons.unshift({ key: `strong.${kind}` });
    else if (own >= bestQuality - 1 && own >= 7) reasons.unshift({ key: 'close' });
    else if (own <= 4) reasons.push({ key: `weak.${kind}` });

    const learned = prefs[kind]?.[tone] ?? 0;
    if (learned >= 3) reasons.push({ key: 'learned', values: { count: learned } });
    const bonus = learned >= 3 ? Math.min(3, learned / 2) : 0;

    const score = weights.quality * quality + weights.speed * speed + weights.cost * cost + bonus - penalty;
    return { candidate, score, reasons, costPercent };
  });

  ranked.sort((a, b) => b.score - a.score);
  return { kind, goal: resolved, ranked };
}

/** Record an override in the preference counts (only when Nezar chose something other than the pick). */
export function learn(prefs: DispatchPrefs, kind: TaskKind, picked: Tone, chosen: Tone): DispatchPrefs {
  if (picked === chosen) return prefs;
  const forKind = { ...prefs[kind] };
  forKind[chosen] = (forKind[chosen] ?? 0) + 1;
  return { ...prefs, [kind]: forKind };
}
