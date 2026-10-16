import { describe, expect, it } from "vitest";
import { initialState, type State } from "../store";
import { contextShare, windowOf } from "./contextShare";

const chat = (over: Partial<State>): State => ({ ...initialState, ...over });

describe("windowOf: what a chat's context window is, and when nothing says", () => {
  it("is the window the CLI reported for the chat", () => {
    expect(windowOf(chat({ model: "claude-sonnet-5-5", contextWindow: 200_000, contextUsed: 10_000 }))).toBe(200_000);
  });

  it("is not guessed: no report, no known model window, no 1M name means null", () => {
    expect(windowOf(chat({ model: "claude-sonnet-5-5", contextWindow: null, contextUsed: 10_000 }))).toBeNull();
    expect(windowOf(chat({ model: null, contextWindow: null, contextUsed: 10_000 }))).toBeNull();
  });

  it("uses what another chat on the same model has said, before this one's first turn ends", () => {
    expect(windowOf(chat({ model: "claude-opus-5-5[1m]", contextWindow: null, contextUsed: 300_000 }), { "claude-opus-5-5[1m]": 1_000_000 })).toBe(1_000_000);
    // Not another model's.
    expect(windowOf(chat({ model: "claude-sonnet-5-5", contextWindow: null, contextUsed: 10_000 }), { "claude-opus-5-5[1m]": 1_000_000 })).toBeNull();
  });

  it("takes the model's own 1M name as saying so", () => {
    expect(windowOf(chat({ model: "claude-opus-5-5[1m]", contextWindow: null, contextUsed: 300_000 }))).toBe(1_000_000);
  });

  it("prefers the model's window to an older chat-wide one (the model changed since)", () => {
    expect(windowOf(chat({ model: "claude-opus-5-5[1m]", contextWindow: 200_000, contextUsed: 10_000 }), { "claude-opus-5-5[1m]": 1_000_000 })).toBe(1_000_000);
  });

  it("doesn't say a window the chat already holds more than: that one is wrong", () => {
    expect(windowOf(chat({ model: "m", contextWindow: 200_000, contextUsed: 312_000 }))).toBeNull();
  });
});

describe("contextShare", () => {
  it("is null before the first reply", () => {
    expect(contextShare(chat({ contextUsed: null, contextWindow: 200_000 }))).toBeNull();
    expect(contextShare(undefined)).toBeNull();
  });

  it("has a percent and a warning level when the window is known", () => {
    expect(contextShare(chat({ contextUsed: 100_000, contextWindow: 200_000 }))).toEqual({ used: 100_000, window: 200_000, percent: 50, level: null });
    expect(contextShare(chat({ contextUsed: 160_000, contextWindow: 200_000 }))).toMatchObject({ percent: 80, level: "warn" });
    expect(contextShare(chat({ contextUsed: 190_000, contextWindow: 200_000 }))).toMatchObject({ percent: 95, level: "full" });
  });

  it("has only the tokens, no percent and no warning, when nothing says what the window is", () => {
    expect(contextShare(chat({ model: "claude-sonnet-5-5", contextUsed: 312_000, contextWindow: null }))).toEqual({ used: 312_000, window: null, percent: null, level: null });
  });
});
