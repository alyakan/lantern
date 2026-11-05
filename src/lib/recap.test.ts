import { describe, expect, it } from "vitest";
import { AWAY_MS, wantsRecap, type RecapChat } from "./recap";

const chat: RecapChat = { canRecap: true, idle: true, sessionId: "s1", items: 12 };

describe("wantsRecap", () => {
  it("asks after five minutes away from an idle chat with a session", () => {
    expect(wantsRecap(chat, AWAY_MS, undefined)).toBe(true);
    expect(wantsRecap(chat, AWAY_MS - 1, undefined)).toBe(false);
  });

  it("doesn't ask again until the chat changed", () => {
    expect(wantsRecap(chat, AWAY_MS * 3, 12)).toBe(false);
    expect(wantsRecap({ ...chat, items: 14 }, AWAY_MS, 12)).toBe(true);
  });

  it("needs a provider that recaps, an idle chat, a session and something in it", () => {
    expect(wantsRecap({ ...chat, canRecap: false }, AWAY_MS, undefined)).toBe(false);
    expect(wantsRecap({ ...chat, idle: false }, AWAY_MS, undefined)).toBe(false);
    expect(wantsRecap({ ...chat, sessionId: null }, AWAY_MS, undefined)).toBe(false);
    expect(wantsRecap({ ...chat, items: 0 }, AWAY_MS, undefined)).toBe(false);
  });
});
