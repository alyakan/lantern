import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Markdown from "react-markdown";
import { api } from "../api";
import { FileLinksProvider, markdownComponents, splitMention } from "./fileLinks";

vi.mock("../api", () => ({ api: { resolveFiles: vi.fn() } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

describe("splitMention", () => {
  it("takes paths with an extension, and a line", () => {
    expect(splitMention("src/client/retry.ts")).toEqual({ path: "src/client/retry.ts", line: null });
    expect(splitMention("src/client/retry.ts:42")).toEqual({ path: "src/client/retry.ts", line: 42 });
    expect(splitMention("AppDelegate.swift:12:5")).toEqual({ path: "AppDelegate.swift", line: 12 });
    expect(splitMention("./a.py:3-9")).toEqual({ path: "./a.py", line: 3 });
  });

  it("leaves out what isn't shaped like a file", () => {
    for (const t of ["fetchJson", "res.json()", "docs/", "v1.2.3", "e.preventDefault", "npm test", ""]) expect(splitMention(t)).toBeNull();
  });
});

describe("file links", () => {
  it("links code spans the backend knows as files, and opens them with their line", async () => {
    vi.mocked(api.resolveFiles).mockImplementation(async (_slot, mentions) => mentions.map((m) => (m === "src/a.ts" ? "/p/src/a.ts" : null)));
    const onOpen = vi.fn();
    render(
      <FileLinksProvider slot="s1" folder="/p" epoch={0} onOpen={onOpen}>
        <Markdown components={markdownComponents}>{"See `src/a.ts:12`, `res.json` and [the readme](README.md)."}</Markdown>
      </FileLinksProvider>,
    );
    const link = await screen.findByRole("button", { name: "src/a.ts:12" });
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("/p/src/a.ts", 12);
    // Asked about together, in one batch.
    await waitFor(() => expect(api.resolveFiles).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.resolveFiles).mock.calls[0][1].sort()).toEqual(["README.md", "res.json", "src/a.ts"]);
    // Not files there: plain code, and an ordinary link.
    expect(screen.queryByRole("button", { name: "res.json" })).toBeNull();
    expect(screen.getByText("the readme").closest("a")).not.toBeNull();
  });

  it("is plain code outside a provider", () => {
    render(<Markdown components={markdownComponents}>{"`src/a.ts`"}</Markdown>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
