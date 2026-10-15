import { useState } from "react";

/** How many of a list's items or an object's keys show before "Show N more". */
const PAGE = 100;

// A response's JSON as a tree, like a browser's inspector: objects and lists fold, each with how many items or keys it
// has; only the first level is open, and children are only drawn once their parent opens, so a big response stays cheap.
export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="json-tree" role="group" aria-label="Response JSON">
      <Node name={null} value={value} depth={0} />
    </div>
  );
}

function Node({ name, value, depth }: { name: string | null; value: unknown; depth: number }) {
  const container = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth === 0);
  const [shown, setShown] = useState(PAGE);
  const key = name !== null && <span className="json-key">{name}</span>;
  if (!container) {
    return (
      <div className="json-row" style={{ paddingLeft: depth * 14 + 16 }}>
        {key}
        {key && <span className="json-colon">: </span>}
        <Scalar value={value} />
      </div>
    );
  }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value as Record<string, unknown>);
  const size = Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`;
  return (
    <div>
      <button className="json-row json-toggle" aria-expanded={open} style={{ paddingLeft: depth * 14 }} onClick={() => setOpen(!open)}>
        <span className="chev" aria-hidden />
        {key}
        {key && <span className="json-colon">: </span>}
        <span className="json-size">{size}</span>
        {!open && entries.length > 0 && <span className="json-peek">{peek(value)}</span>}
      </button>
      {open && (
        <div>
          {entries.slice(0, shown).map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {entries.length > shown && (
            <button className="json-row json-more" style={{ paddingLeft: (depth + 1) * 14 + 16 }} onClick={() => setShown(shown + PAGE)}>
              Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Scalar({ value }: { value: unknown }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === "string") {
    const long = value.length > 300;
    return (
      <span className="json-string" title={long ? value : undefined}>
        "{long ? `${value.slice(0, 300)}…` : value}"
      </span>
    );
  }
  if (typeof value === "number") return <span className="json-number">{value}</span>;
  if (typeof value === "boolean") return <span className="json-bool">{String(value)}</span>;
  return <span>{String(value)}</span>;
}

/** A folded object's first keys, or a folded list's first item kind: enough to tell what's inside. */
function peek(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0];
    return first !== null && typeof first === "object" ? (Array.isArray(first) ? "lists" : `{ ${Object.keys(first).slice(0, 4).join(", ")}${Object.keys(first).length > 4 ? ", …" : ""} }`) : typeof first;
  }
  const keys = Object.keys(value as object);
  return `${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}`;
}
