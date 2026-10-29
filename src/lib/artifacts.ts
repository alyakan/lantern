/** Artifacts: pages Claude writes into a folder's `.lantern/artifacts/` for the Artifacts tab (see src-tauri/src/artifacts.rs). */

export type ArtifactKind = "html" | "svg" | "markdown" | "mermaid";

export interface Artifact {
  /** From the artifacts folder, with `/` between folders: `maps/auth.html`. */
  name: string;
  /** The full path, as the chat's edits name it. */
  path: string;
  kind: ArtifactKind;
  /** Last changed, in milliseconds since 1970. */
  modified: number;
  size: number;
}

export interface ArtifactListing {
  /** The key the folder's HTML and SVG are served under. */
  key: string;
  /** Newest first. */
  items: Artifact[];
}

export const ARTIFACTS_DIR = ".lantern/artifacts";
const EXTENSIONS = /\.(html?|svg|md|markdown|mmd|mermaid)$/i;

/** The artifact's name if `path` is one of the folder's artifacts (an HTML, SVG, Markdown or Mermaid file under `.lantern/artifacts/`). */
export function artifactName(path: string, folder: string | null): string | null {
  if (!folder || !EXTENSIONS.test(path)) return null;
  const dir = `${folder.replace(/\/+$/, "")}/${ARTIFACTS_DIR}/`;
  if (!path.startsWith(dir)) return null;
  const name = path.slice(dir.length);
  return name.split("/").some((part) => part === "" || part === "." || part === "..") ? null : name;
}

/** Where the sandboxed frame loads an HTML or SVG artifact from. */
export function artifactUrl(key: string, name: string, stamp = 0): string {
  const path = name.split("/").map(encodeURIComponent).join("/");
  // The stamp makes a changed file load again rather than come from the frame's cache.
  return `lantern-artifact://localhost/${key}/${path}${stamp ? `?v=${stamp}` : ""}`;
}

/** The app's variables an artifact gets in `lantern.css`, by the name it gets them under. */
const SHARED: Record<string, string> = {
  "--bg": "--bg",
  "--pane": "--pane",
  "--sidebar": "--sidebar",
  "--field": "--field",
  "--bg-subtle": "--bg-subtle",
  "--bg-hover": "--bg-hover",
  "--line": "--line",
  "--line-strong": "--line-strong",
  "--text": "--text",
  "--text-2": "--text-2",
  "--muted": "--muted",
  "--faint": "--faint",
  "--accent": "--accent",
  "--accent-soft": "--accent-soft",
  "--accent-text": "--accent-text",
  "--working": "--working",
  "--attn": "--attn",
  "--add": "--add",
  "--del": "--del",
  "--warn": "--warn",
  "--info-bg": "--info-bg",
  "--error-bg": "--error-bg",
  "--code-bg": "--code-bg",
  "--sev-blocker": "--sev-blocker",
  "--sev-should": "--sev-should",
  "--ui": "--ui",
  "--mono": "--mono",
  "--radius": "--radius",
  "--radius-md": "--radius-md",
  "--radius-float": "--radius-float",
  "--card-shadow": "--card-shadow",
  "--shadow": "--shadow",
  // The Storage tab's categorical colours, as a chart's series colours.
  "--storage-1": "--series-1",
  "--storage-2": "--series-2",
  "--storage-3": "--series-3",
  "--storage-4": "--series-4",
  "--storage-5": "--series-5",
  "--storage-6": "--series-6",
  "--storage-7": "--series-7",
};

/** The current theme as `lantern.css` gives it to artifacts: the shared variables' values, and whether it's dark. */
export function themeVars(dark: boolean, root: Element = document.documentElement): Record<string, string> {
  const style = getComputedStyle(root);
  const vars: Record<string, string> = { "--color-scheme": dark ? "dark" : "light" };
  for (const [from, to] of Object.entries(SHARED)) {
    const value = style.getPropertyValue(from).trim();
    if (value) vars[to] = value;
  }
  return vars;
}
