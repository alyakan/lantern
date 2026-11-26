/** What waits for the user from web Claude: a claude.ai sign-in to Allow, or work to Run (see src-tauri/src/webclaude/store.rs Card). */
export type WebCard =
  | {
      kind: "connect";
      id: string;
      /** The name the client gave itself, which anyone could choose: the card asks for the code on the sign-in page instead. */
      client: string;
      at: number;
    }
  | {
      kind: "run";
      id: string;
      canvas: string;
      title: string;
      message: string;
      /** The project it runs in; null until the user picks one on the card. */
      folder: string | null;
      /** An answer to a chat's question, which goes back to that chat. */
      answer: boolean;
      chat_title: string | null;
      at: number;
    };

export interface WebConnection {
  id: string;
  client: string;
  created_at: number;
  last_used: number;
  expires: number;
}

export interface WebLink {
  canvas: string;
  title: string;
  folder: string;
}

/** Settings › Web Claude. */
export interface WebClaudeView {
  enabled: boolean;
  listening: boolean;
  /** What to paste in claude.ai's Connectors, while it is on. */
  address: string | null;
  error: string | null;
  /** A new chat web Claude's work starts runs on Auto (else Ask). */
  new_chats_auto: boolean;
  /** Web Claude's work runs as soon as it arrives, with no Run card (one with no project to run in still waits for a pick). */
  auto_run: boolean;
  connections: WebConnection[];
  links: WebLink[];
}

/** The last part of a folder, for a card. */
export const folderName = (folder: string): string => folder.split("/").filter(Boolean).pop() ?? folder;

/** A canvas's claude.ai link, when it was named by one (to open it), else null. */
export const canvasLink = (canvas: string): string | null => (/^https:\/\/claude\.ai\//.test(canvas) ? canvas : null);

/** The first line of a message, cut for a row; the card shows the whole message under it. */
export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
