/**
 * Insights as the screens get them: kept on this phone and shown at once, asked for again behind them once they are older
 * than their stretch allows. How they are kept is the cache's business (cache/), not the screen's.
 */
import type { Insights } from "../protocol/generated/Insights";
import type { InsightsRange } from "../protocol/generated/InsightsRange";
import type { Controller } from "../shell/controller";
import { useController } from "../shell/hooks";
import { useResource, type Loaded } from "./useResource";

const MINUTE = 60_000;

/** How old a stretch's figures may be before looking at them asks again: today's move fastest. */
export const INSIGHTS_FRESH_MS: Record<InsightsRange, number> = { today: 10 * MINUTE, week: 30 * MINUTE, month: 60 * MINUTE };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isArr = (v: unknown, each: (x: unknown) => boolean) => Array.isArray(v) && v.every(each);
const isShare = (v: unknown) => isObj(v) && isStr(v.name) && isNum(v.share);
const isCompare = (v: unknown) => isObj(v) && isNum(v.now) && (v.before === null || isNum(v.before));
const isBar = (v: unknown) => isObj(v) && isStr(v.label) && isNum(v.weighted);
const isChat = (v: unknown) => isObj(v) && isStr(v.title) && isStr(v.project) && isNum(v.weighted) && (v.why === null || isStr(v.why));

/**
 * Whether kept figures still have everything the screen reads, for this stretch (an older Mac's, or an older build's, may
 * not). A field the screen starts reading goes in here too, or figures kept by the build before would reach it without it.
 */
export function isInsights(range: InsightsRange) {
  return (v: unknown): v is Insights => {
    if (!isObj(v) || v.range !== range || !isStr(v.before)) return false;
    const { usage: u, savings: s, done: d, habits: h } = v;
    return (
      isObj(u) && isStr(u.headline) && isNum(u.weighted) && isNum(u.tokens) &&
      isArr(u.bars, isBar) && isArr(u.projects, isShare) && isArr(u.models, isShare) && isArr(u.heavy, isChat) &&
      isObj(s) && isStr(s.headline) && isCompare(s.per_call) && isCompare(s.chat_start) && isCompare(s.cached) &&
      isObj(d) && isStr(d.headline) && [d.chats, d.commits, d.added, d.removed, d.merged, d.releases].every(isNum) &&
      isArr(d.projects, isShare) &&
      isObj(h) && isStr(h.headline) && isArr(h.hours, isNum) && (h.reply_ms === null || isNum(h.reply_ms)) && isNum(h.away)
    );
  };
}

export function insightsResource(c: Controller, range: InsightsRange) {
  return c.cache.resource({ key: `insights.${range}`, fetch: () => c.sync.insights(range), freshMs: INSIGHTS_FRESH_MS[range], check: isInsights(range) });
}

/** A stretch's insights, loaded while `active` (the screen is in view). */
export function useInsights(range: InsightsRange, active = true): Loaded<Insights> {
  return useResource(insightsResource(useController(), range), active);
}
