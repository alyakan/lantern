import type { ComponentProps, MouseEvent } from "react";
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
  const open = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (isOpenable(href)) openUrl(href).catch(() => {});
  };
  return (
    <a
      {...rest}
      href={href}
      onClick={open}
      // A middle click fires auxclick, not click; left alone, the webview navigates the whole app to the link.
      onAuxClick={(e) => {
        if (e.button === 1) open(e);
      }}
    >
      {children}
    </a>
  );
}
