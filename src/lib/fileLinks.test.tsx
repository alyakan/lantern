import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Markdown from "react-markdown";
import { api } from "../api";
import { FileLinksProvider, markdownComponents, pathBreaks, splitMention, useFileLinks } from "./fileLinks";

vi.mock("../api", () => ({ api: { resolveFiles: vi.fn() } }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

describe("pathBreaks", () => {
  it("keeps the path's text whole and lets it break after each folder", () => {
    const { container } = render(<code>{pathBreaks("src/server/app.ts")}</code>);
    expect(container.textContent).toBe("src/server/app.ts");
    expect(container.querySelectorAll("wbr")).toHaveLength(3);
    expect(container.querySelector("code")!.innerHTML).toBe("src/<wbr>server/<wbr>app.ts<wbr>");
  });
});

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

  it("draws a link whose address has a malformed escape, instead of throwing", async () => {
    vi.mocked(api.resolveFiles).mockResolvedValue([null]);
    render(
      <FileLinksProvider slot="s1" folder="/p" epoch={0} onOpen={() => {}}>
        <Markdown components={markdownComponents}>{"[notes](a%E9.md)"}</Markdown>
      </FileLinksProvider>,
    );
    expect(screen.getByText("notes").closest("a")).toHaveAttribute("href", "a%E9.md");
  });

  it("drops a lookup that finishes after the chat switched, so the other chat doesn't get its answer", async () => {
    let answerA: (paths: (string | null)[]) => void = () => {};
    // Chat B's own lookup never answers, so B's view can only change through the answer meant for A.
    vi.mocked(api.resolveFiles).mockImplementation((slot) => new Promise<(string | null)[]>((r) => { if (slot === "A") answerA = r; }));
    const seen: (string | null | undefined)[] = [];
    const chat = (slot: string, folder: string) => (
      <FileLinksProvider slot={slot} folder={folder} epoch={0} onOpen={() => {}}>
        <Probe mention="x.ts" seen={(v) => seen.push(v)} />
      </FileLinksProvider>
    );
    const { rerender } = render(chat("A", "/a"));
    await waitFor(() => expect(api.resolveFiles).toHaveBeenCalledWith("A", ["x.ts"], false));
    rerender(chat("B", "/b"));
    await act(async () => answerA(["/a/x.ts"]));
    expect(seen).not.toContain("/a/x.ts");
    expect(seen[seen.length - 1]).toBeUndefined();
    // B asks about its own files.
    await waitFor(() => expect(api.resolveFiles).toHaveBeenCalledWith("B", ["x.ts"], false));
  });

  describe("in a review", () => {
    const changed = ["/p/Lumiform/User/User.swift", "/p/Lumiform/Cart/Item.swift", "/p/Lumiform/Cart/User.swift"];
    it("takes a changed file as it is, and asks the backend about the rest, for whole paths only", async () => {
      vi.mocked(api.resolveFiles).mockClear();
      vi.mocked(api.resolveFiles).mockImplementation(async (_slot, mentions) => mentions.map(() => null));
      const seen = new Map<string, string | null | undefined>();
      render(
        <FileLinksProvider slot="s1" folder="/p" epoch={0} onOpen={() => {}} changed={changed}>
          {["Item.swift", "User.swift", "Lumiform/User/User.swift", "Lumiform/Other.swift"].map((m) => (
            <Probe key={m} mention={m} seen={(v) => seen.set(m, v)} />
          ))}
        </FileLinksProvider>,
      );
      await waitFor(() => expect(api.resolveFiles).toHaveBeenCalledTimes(1));
      const [, asked, wholeOnly] = vi.mocked(api.resolveFiles).mock.calls[0];
      // Item.swift is one changed file, so it means that one; a whole path is the changed file it names. User.swift is two,
      // so it is left to the backend, asked for whole paths only, which finds no file of that name.
      expect([...asked].sort()).toEqual(["Lumiform/Other.swift", "User.swift"]);
      expect(wholeOnly).toBe(true);
      await waitFor(() => expect(seen.get("Item.swift")).toBe("/p/Lumiform/Cart/Item.swift"));
      expect(seen.get("Lumiform/User/User.swift")).toBe("/p/Lumiform/User/User.swift");
      expect(seen.get("User.swift")).toBeNull();
    });

    it("links a reviewed file in a worktree outside the chat's folder, without asking the backend", async () => {
      vi.mocked(api.resolveFiles).mockClear();
      vi.mocked(api.resolveFiles).mockImplementation(async (_slot, mentions) => mentions.map(() => null));
      const onOpen = vi.fn();
      render(
        <FileLinksProvider slot="s1" folder="/p/ios-app" epoch={0} onOpen={onOpen} changed={["/p/ios-app-wt/Lumiform/Utils/PhotoDecoder+UIKit.swift"]}>
          <Markdown components={markdownComponents}>{"See `Lumiform/Utils/PhotoDecoder+UIKit.swift:21`."}</Markdown>
        </FileLinksProvider>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Lumiform/Utils/PhotoDecoder+UIKit.swift:21" }));
      expect(onOpen).toHaveBeenCalledWith("/p/ios-app-wt/Lumiform/Utils/PhotoDecoder+UIKit.swift", 21);
      expect(api.resolveFiles).not.toHaveBeenCalled();
    });

    it("starts again when the reviewed files change (the pull request's files arrive after its pages)", async () => {
      vi.mocked(api.resolveFiles).mockClear();
      vi.mocked(api.resolveFiles).mockImplementation(async (_slot, mentions) => mentions.map((m) => (m.startsWith("/p/") ? m : null)));
      const seen: (string | null | undefined)[] = [];
      const view = (list: string[]) => (
        <FileLinksProvider slot="s1" folder="/p" epoch={0} onOpen={() => {}} changed={list}>
          <Probe mention="Item.swift" seen={(v) => seen.push(v)} />
        </FileLinksProvider>
      );
      const { rerender } = render(view([]));
      await waitFor(() => expect(seen[seen.length - 1]).toBeNull());
      rerender(view(changed));
      await waitFor(() => expect(seen[seen.length - 1]).toBe("/p/Lumiform/Cart/Item.swift"));
    });
  });
});

function Probe({ mention, seen }: { mention: string; seen: (value: string | null | undefined) => void }) {
  seen(useFileLinks()?.resolve(mention));
  return null;
}
