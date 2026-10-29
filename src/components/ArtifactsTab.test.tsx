import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ArtifactsTab } from "./ArtifactsTab";
import { ReviewPanel } from "./ReviewPanel";
import { api } from "../api";
import type { Artifact, ArtifactListing } from "../lib/artifacts";

// Every other call the pane makes fails, as it does outside Tauri.
vi.mock("../api", () => {
  const fns: Record<string | symbol, unknown> = {};
  return { api: new Proxy(fns, { get: (all, name) => (all[name] ??= vi.fn(() => Promise.reject(new Error("not in Tauri")))) }) };
});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));
vi.mock("./FullDiff", () => ({ default: () => null }));

const item = (name: string, kind: Artifact["kind"], modified = 1_000): Artifact => ({ name, path: `/p/.lantern/artifacts/${name}`, kind, modified, size: 10 });
const listing = (...items: Artifact[]): ArtifactListing => ({ key: "k1", scripts: true, items });

beforeEach(() => {
  vi.mocked(api.artifactsList).mockReset();
  vi.mocked(api.artifactsRead).mockReset();
  vi.mocked(api.artifactsTheme).mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

describe("ArtifactsTab", () => {
  it("explains itself when the folder has none", async () => {
    vi.mocked(api.artifactsList).mockResolvedValue(listing());
    render(<ArtifactsTab folder="/p" refreshKey={0} />);
    expect(await screen.findByText(/pages Claude makes to show you something/)).toBeInTheDocument();
  });

  it("shows HTML in a frame that may run scripts and nothing else, from the folder's key", async () => {
    vi.mocked(api.artifactsList).mockResolvedValue(listing(item("maps/auth flow.html", "html")));
    render(<ArtifactsTab folder="/p" refreshKey={0} />);
    const frame = (await screen.findByTitle("maps/auth flow.html")) as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toMatch(/^lantern-artifact:\/\/localhost\/k1\/maps\/auth%20flow\.html\?v=\d+$/);
    expect(api.artifactsTheme).toHaveBeenCalledWith(expect.objectContaining({ "--color-scheme": "light" }));
  });

  it("shows HTML without its scripts, and says so, when WebRTC and preconnect couldn't be switched off", async () => {
    vi.mocked(api.artifactsList).mockResolvedValue({ ...listing(item("page.html", "html")), scripts: false });
    render(<ArtifactsTab folder="/p" refreshKey={0} />);
    const frame = await screen.findByTitle("page.html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(screen.getByText(/scripts are off/)).toBeInTheDocument();
  });

  it("draws Markdown in the app, not in a frame, and lets you pick another artifact", async () => {
    vi.mocked(api.artifactsList).mockResolvedValue(listing(item("chart.svg", "svg", 2_000), item("notes.md", "markdown")));
    vi.mocked(api.artifactsRead).mockResolvedValue("# Release notes\n\nAll good.");
    render(<ArtifactsTab folder="/p" refreshKey={0} />);
    expect(await screen.findByTitle("chart.svg")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Artifact" }), { target: { value: "notes.md" } });
    expect(await screen.findByRole("heading", { name: "Release notes" })).toBeInTheDocument();
    expect(api.artifactsRead).toHaveBeenCalledWith("/p", "notes.md");
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("ReviewPanel and artifacts", () => {
  const base = { folder: "/p", ready: true, files: [], refreshKey: 0, selected: null, follow: true, onSelect: () => {}, onFollow: () => {} };

  it("opens Artifacts on an artifact Claude just wrote, but not on one found when the chat comes on screen", async () => {
    vi.mocked(api.artifactsList).mockResolvedValue(listing(item("flow.html", "html", 2_000), item("old.html", "html")));
    const { rerender } = render(<ReviewPanel {...base} lastEdit={{ slot: "s-art", path: "/p/.lantern/artifacts/old.html", count: 3 }} />);
    expect(screen.getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");
    // An edit to another file doesn't.
    rerender(<ReviewPanel {...base} lastEdit={{ slot: "s-art", path: "/p/src/a.ts", count: 4 }} />);
    expect(screen.getByRole("tab", { name: /Changes/ })).toHaveAttribute("aria-selected", "true");
    rerender(<ReviewPanel {...base} lastEdit={{ slot: "s-art", path: "/p/.lantern/artifacts/old.html", count: 5 }} />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Artifacts" })).toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByTitle("old.html")).toBeInTheDocument();
    await act(async () => {});
  });
});
