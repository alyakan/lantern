import type { ReactNode } from "react";

/** What a side-panel tab shows while it has nothing: its name and a line on what will show there. */
export function TabEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tab-empty">
      <div className="tab-empty-title">{title}</div>
      {typeof children === "string" ? <p>{children}</p> : children}
    </div>
  );
}
