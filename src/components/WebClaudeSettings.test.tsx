import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebClaudeView } from "../lib/webClaude";

let view: WebClaudeView;
const calls: unknown[] = [];
let failOn: string | null = null;
vi.mock("../api", () => ({
  api: {
    webclaudeView: () => Promise.resolve(view),
    onWebclaudeChanged: () => Promise.resolve(() => {}),
    webclaudeSetEnabled: (on: boolean) => {
      calls.push(["enabled", on]);
      if (failOn) return Promise.reject(failOn);
      view = { ...view, enabled: on, listening: on, address: on ? "https://mac.tail0.ts.net/mcp" : null };
      return Promise.resolve(view);
    },
    webclaudeSetAuto: (on: boolean) => {
      calls.push(["auto", on]);
      view = { ...view, new_chats_auto: on };
      return Promise.resolve(view);
    },
    webclaudeSetAutoRun: (on: boolean) => {
      calls.push(["auto_run", on]);
      view = { ...view, auto_run: on };
      return Promise.resolve(view);
    },
    webclaudeRevoke: (id: string) => {
      calls.push(["revoke", id]);
      view = { ...view, connections: [] };
      return Promise.resolve();
    },
  },
}));

const { WebClaudeSettings } = await import("./WebClaudeSettings");

const off = (): WebClaudeView => ({ enabled: false, listening: false, address: null, error: null, new_chats_auto: true, auto_run: false, connections: [], links: [] });

describe("Settings › Web Claude", () => {
  it("runs web Claude's work as it arrives only once turned on, and says what that lets through", async () => {
    render(<WebClaudeSettings />);
    await act(async () => {});
    const box = screen.getByRole("checkbox", { name: "Run web Claude's work as soon as it arrives" });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/whatever gets it to send work runs on this Mac unseen/)).toBeInTheDocument();
    fireEvent.click(box);
    await act(async () => {});
    expect(calls).toEqual([["auto_run", true]]);
    expect(screen.getByRole("checkbox", { name: "Run web Claude's work as soon as it arrives" })).toBeChecked();
  });

  beforeEach(() => {
    view = off();
    calls.length = 0;
    failOn = null;
  });

  it("turns on and shows the address to paste in claude.ai", async () => {
    render(<WebClaudeSettings />);
    await act(async () => {});
    expect(screen.queryByText("https://mac.tail0.ts.net/mcp")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Let web Claude reach Lantern" }));
    await act(async () => {});
    expect(calls).toEqual([["enabled", true]]);
    expect(screen.getByText("https://mac.tail0.ts.net/mcp")).toBeInTheDocument();
    expect(screen.getByText(/type the code on it, then Allow/)).toBeInTheDocument();
  });

  it("says why it couldn't turn on, and stays off", async () => {
    failOn = "Funnel isn't allowed for this Mac in your tailnet.";
    render(<WebClaudeSettings />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("checkbox", { name: "Let web Claude reach Lantern" }));
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("Funnel isn't allowed");
    expect(screen.getByRole("checkbox", { name: "Let web Claude reach Lantern" })).not.toBeChecked();
  });

  it("switches new chats between Auto and Ask", async () => {
    render(<WebClaudeSettings />);
    await act(async () => {});
    const box = screen.getByRole("checkbox", { name: "Start web Claude's chats on Auto" });
    expect(box).toBeChecked();
    fireEvent.click(box);
    await act(async () => {});
    expect(calls).toEqual([["auto", false]]);
    expect(box).not.toBeChecked();
  });

  it("lists connections and the canvases' projects, and disconnects one", async () => {
    view = { ...off(), enabled: true, listening: true, connections: [{ id: "g1", client: "Claude", created_at: 1, last_used: Date.now(), expires: Date.now() + 1e9 }], links: [{ canvas: "https://claude.ai/artifact/abc", title: "Rayak", folder: "/dev/rayak" }] };
    render(<WebClaudeSettings />);
    await act(async () => {});
    expect(screen.getByText("→ rayak", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Claude" }));
    await act(async () => {});
    expect(calls).toEqual([["revoke", "g1"]]);
    expect(screen.getByText("Nothing is connected.")).toBeInTheDocument();
  });
});
