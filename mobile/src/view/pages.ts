/**
 * Step by step's pages, as a phone reads them. A page is a message of Claude's whose first line is a heading in one of
 * Lantern's shapes ("# Step 2 of 4 — Bump the version"); the phone shows it as a card with its buttons, and the button
 * says what the Mac's own buttons say, so Claude can't tell them apart.
 */

export type PageKind = "frame" | "plan" | "plan-complete" | "plan-update" | "step" | "done" | "file" | "summary" | "evidence" | "fix" | "overview" | "part" | "switch";

export interface PageAction {
  label: string;
  /** What is sent to Claude when it is pressed (null: it only dismisses). */
  reply: string | null;
  primary: boolean;
  /** Done on the phone itself, not sent to Claude: open what the chat changed, or start a new chat in its project. It stays pressable. */
  go?: "changes" | "new";
}

export interface Page {
  kind: PageKind;
  /** "Step 2 of 4", "Frame", "Part 3 of 9". */
  kicker: string;
  title: string;
  /** The rest of the message after the heading line. */
  body: string;
  actions: PageAction[];
}

const NEXT: PageAction = { label: "Next", reply: "Next", primary: true };

const SHAPES: [RegExp, PageKind, (m: RegExpExecArray) => string][] = [
  [/^#\s+Frame\s+[—–-]\s+(.+)$/, "frame", () => "Frame"],
  [/^#\s+Plan step (\d+)\s+[—–-]\s+(.+)$/, "plan", (m) => `Plan step ${m[1]}`],
  [/^#\s+Plan complete\s+[—–-]\s+(.+)$/, "plan-complete", () => "Plan complete"],
  [/^#\s+Plan update\s+[—–-]\s+(.+)$/, "plan-update", () => "Plan update"],
  [/^#\s+Step (\d+) of (\d+)\s+[—–-]\s+(.+)$/, "step", (m) => `Step ${m[1]} of ${m[2]}`],
  [/^#\s+Done\s+[—–-]\s+(.+)$/, "done", () => "Done"],
  [/^#\s+File (\d+) of (\d+)\s+[—–-]\s+(.+)$/, "file", (m) => `File ${m[1]} of ${m[2]}`],
  [/^#\s+Summary\s+[—–-]\s+(.+)$/, "summary", () => "Summary"],
  [/^#\s+Evidence (\d+)\s+[—–-]\s+(.+)$/, "evidence", (m) => `Evidence ${m[1]}`],
  [/^#\s+Fix\s+[—–-]\s+(.+)$/, "fix", () => "Fix"],
  [/^#\s+Overview\s+[—–-]\s+(.+)$/, "overview", () => "Overview"],
  [/^#\s+Part (\d+) of (\d+)\s+[—–-]\s+(.+)$/, "part", (m) => `Part ${m[1]} of ${m[2]}`],
  [/^#\s+Switch to (Build|Review|Debug|Design)(, explaining as you go)?\s+[—–-]\s+(.+)$/, "switch", (m) => `Switch to ${m[1]}`],
];

/** The page a message is, or null when it is an ordinary message. */
export function readPage(text: string): Page | null {
  const [first, ...rest] = text.trimStart().split("\n");
  const line = first.trim();
  for (const [re, kind, kicker] of SHAPES) {
    const m = re.exec(line);
    if (!m) continue;
    const title = m[m.length - 1].trim();
    return { kind, kicker: kicker(m), title, body: rest.join("\n").trim(), actions: actionsFor(kind, m) };
  }
  return null;
}

function actionsFor(kind: PageKind, m: RegExpExecArray): PageAction[] {
  switch (kind) {
    case "step":
      // A Build step's two buttons answer the commit question at once, as the Mac's do.
      return [
        { label: "Don't commit", reply: "Next. Don't commit this step.", primary: false },
        { label: "Commit, next", reply: "Next. Commit this step first.", primary: true },
      ];
    case "switch": {
      const flavour = m[1];
      const explain = !!m[2];
      return [
        { label: "Not now", reply: null, primary: false },
        { label: `Start ${flavour}`, reply: `Start ${flavour}${explain ? ", explaining as you go" : ""}.`, primary: true },
      ];
    }
    case "done":
      // The end of a Build: what the Mac's "What next?" offers that the phone can do by itself.
      return [
        { label: "Review the changes", reply: null, primary: false, go: "changes" },
        { label: "Start something new", reply: null, primary: true, go: "new" },
      ];
    case "summary":
      return [];
    default:
      return [NEXT];
  }
}

/** Only the last page can be answered: an earlier one is history. */
export function livePage(items: { kind: string; text?: string; streaming?: boolean }[], index: number): boolean {
  for (let i = items.length - 1; i > index; i--) {
    const it = items[i];
    if (it.kind === "user" || (it.kind === "assistant" && it.text && readPage(it.text))) return false;
  }
  return true;
}
