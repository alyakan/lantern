import type { ComponentProps } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isOpenable(href: string | undefined): href is string {
  if (!href) return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function ExternalLink({ href, children, node: _node, ...rest }: ComponentProps<"a"> & { node?: unknown }) {
  return (
    <a
      {...rest}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (isOpenable(href)) openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}
