import type { RemoteArtifact } from "../protocol/generated/RemoteArtifact";
import type { Palette } from "../ui/theme";

export type ArtifactKind = "html" | "svg" | "markdown" | "mermaid";

/** What the Mac listed, with a kind this app knows (a newer Mac may have more kinds: those are left out, not guessed at). */
export interface Artifact {
  name: string;
  kind: ArtifactKind;
  modified: number;
  size: number;
}

const KINDS: ArtifactKind[] = ["html", "svg", "markdown", "mermaid"];

/** The list as the Mac sent it, checked: a row that isn't well formed, or a name that goes up or out, is dropped. Newest first. */
export function artifactList(raw: unknown): Artifact[] {
  if (!Array.isArray(raw)) return [];
  const items: Artifact[] = [];
  for (const r of raw as Partial<RemoteArtifact>[]) {
    if (!r || typeof r.name !== "string" || typeof r.kind !== "string" || !KINDS.includes(r.kind as ArtifactKind)) continue;
    if (!r.name || r.name.startsWith("/") || r.name.split("/").some((p) => p === "" || p === "." || p === "..")) continue;
    items.push({ name: r.name, kind: r.kind as ArtifactKind, modified: typeof r.modified === "number" ? r.modified : 0, size: typeof r.size === "number" ? r.size : 0 });
  }
  return items.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
}

/** `maps/auth-flow.html` as a title: `auth flow`. */
export function artifactTitle(name: string): string {
  const file = name.slice(name.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  return file.replace(/[-_]+/g, " ").trim() || name;
}

/** The folders above it, as `maps/`: none for one at the top. */
export function artifactFolder(name: string): string {
  const i = name.lastIndexOf("/");
  return i < 0 ? "" : name.slice(0, i + 1);
}

export const KIND_LABEL: Record<ArtifactKind, string> = { html: "Page", svg: "Picture", markdown: "Notes", mermaid: "Diagram" };

/** The words of a page that is drawn here, and what the page can't do on a phone. */
export const WEB_NOTE = "Shown without scripts, and nothing it links to is loaded.";
export const MERMAID_NOTE = "A diagram is drawn on your Mac. Its source is here.";

/** What a page may do in the web view: show what it carries, style itself, nothing else (no scripts, no requests, no forms). */
export const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

/** The phone's own colours as the variables `lantern.css` gives a page on the Mac, so a page written for one looks right on the other. */
export function themeCss(p: Palette): string {
  const series = p.isDark ? ["#5aa2ff", "#f0914a", "#5fd08a", "#b48bf0", "#4ccfd0", "#f074b0", "#e3c341"] : ["#1d6fd6", "#c4570c", "#1f8a4c", "#8a4fc7", "#0f8a8f", "#c2307a", "#8a7a10"];
  const vars: Record<string, string> = {
    "--color-scheme": p.isDark ? "dark" : "light",
    "--bg": p.paper,
    "--pane": p.card,
    "--sidebar": p.paper,
    "--field": p.card,
    "--bg-subtle": p.wash,
    "--bg-hover": p.wash,
    "--line": p.rule,
    "--line-strong": p.shapeStrong,
    "--text": p.ink,
    "--text-2": p.ink2,
    "--muted": p.ink2,
    "--faint": p.ink3,
    "--accent": p.cobalt,
    "--accent-text": p.cobalt,
    "--add": p.go,
    "--del": p.stop,
    "--attn": p.hi,
    "--ui": "-apple-system, system-ui, sans-serif",
    "--mono": "Menlo, ui-monospace, monospace",
    "--radius": "6px",
    "--radius-md": "10px",
  };
  series.forEach((c, i) => (vars[`--series-${i + 1}`] = c));
  return `:root{${Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";")}}`;
}

/** The page for the web view: the policy first, then the phone's colours and plain defaults, then the artifact as the Mac sent it. */
export function artifactDocument(body: string, p: Palette): string {
  const base = `html{color-scheme:var(--color-scheme)}body{margin:0;padding:16px;background:var(--pane);color:var(--text);font:15px/1.5 var(--ui);overflow-wrap:anywhere}img,svg,canvas,video{max-width:100%;height:auto}pre,code{font-family:var(--mono)}table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:4px 8px}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_POLICY}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${themeCss(p)}${base}</style></head><body>${body}</body></html>`;
}

/** Whether a load the web view asks for is the page itself, or a place in it (nothing else may load or open from it). */
export function isOwnPage(url: string): boolean {
  return url === "about:blank" || url.startsWith("about:blank#");
}
