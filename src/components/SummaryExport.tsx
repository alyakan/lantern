import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { usePersistentState } from "../lib/layout";
import { useMenuKeys } from "./useMenuKeys";
import { useMenuInside } from "../lib/useMenuInside";

type Status = { kind: "copied" } | { kind: "saved"; path: string } | { kind: "failed"; message: string };

const baseName = (path: string) => path.split("/").pop() ?? path;

/**
 * The Summary tab's Export button: the finished plan as markdown, copied or saved as a file. A menu choice says whether
 * the document has what each step did or only the plan; the outcome is said beside the button for a few seconds.
 */
export function SummaryExport({ markdown, fileName, label = "Export", className = "" }: { markdown: (results: boolean) => string; fileName: string; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = usePersistentState("summary.exportResults", true);
  const [status, setStatus] = useState<Status | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
  const inside = useMenuInside(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 8000);
    return () => clearTimeout(t);
  }, [status]);

  const copy = async () => {
    setOpen(false);
    try {
      await navigator.clipboard.writeText(markdown(results));
      setStatus({ kind: "copied" });
    } catch (e) {
      setStatus({ kind: "failed", message: `Couldn't copy: ${String(e)}` });
    }
  };
  const saveAs = async () => {
    setOpen(false);
    try {
      // The backend opens the save dialog and writes only where it's picked.
      const path = await api.exportText(fileName, markdown(results));
      if (path) setStatus({ kind: "saved", path });
    } catch (e) {
      setStatus({ kind: "failed", message: String(e) });
    }
  };

  return (
    <div className={`summary-export${className ? ` ${className}` : ""}`} ref={root}>
      {status && (
        <span className={`summary-export-status${status.kind === "failed" ? " failed" : ""}`} role="status">
          {status.kind === "copied" && "Copied"}
          {status.kind === "saved" && (
            <>
              Saved {baseName(status.path)}{" "}
              <button className="link-button" onClick={() => void revealItemInDir(status.path)}>
                Show in Finder
              </button>
            </>
          )}
          {status.kind === "failed" && status.message}
        </span>
      )}
      <button className="summary-export-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Export the plan as markdown">
        {label}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className="menu summary-export-menu" ref={inside.ref} style={inside.style} role="menu" aria-label="Export" onKeyDown={keys.onKeyDown}>
          <button role="menuitem" className="menu-row" onClick={() => void copy()}>
            <span className="menu-row-title">Copy as Markdown</span>
          </button>
          <button role="menuitem" className="menu-row" onClick={() => void saveAs()}>
            <span className="menu-row-title">Save as Markdown…</span>
          </button>
          <div className="menu-sep" role="separator" />
          <button role="menuitemcheckbox" aria-checked={results} className="menu-row" onClick={() => setResults(!results)}>
            <span className="menu-row-title">Include what each step did</span>
            <span className="menu-row-meta" aria-hidden>
              {results ? "✓" : ""}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
