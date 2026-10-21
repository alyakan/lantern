import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { MenuBarPanel } from "./components/MenuBarPanel";
import { guardWindowClose } from "./lib/editStash";
import { holdBackBrowserMenu } from "./lib/nativeMenu";
import { applySaved } from "./lib/theme";

/** The menu bar item's panel is a second window loading this same page: it is told apart by its label (or `?menubar` in a browser). */
function isMenuBarPanel(): boolean {
  if (new URLSearchParams(location.search).has("menubar")) return true;
  try {
    return getCurrentWindow().label === "menubar";
  } catch {
    // Not inside the app (a browser, a test): there is no window to ask.
    return false;
  }
}

async function boot() {
  // `npm run dev` then open /?mock to design the UI in a browser against a fake backend (dev builds only).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    (await import("./dev/mockBackend")).installMockBackend();
  }
  const panel = isMenuBarPanel();
  // Once for the app, not per component: closing the window asks about unsaved edits in any file. Not the panel's: it holds no
  // edits, and closing it is only hiding it.
  if (!panel) guardWindowClose();
  // Right-click shows the app's own menus or nothing, not the webview's Reload (a dev build's devtools are still on ⌘⌥I).
  holdBackBrowserMenu();
  // Before the first paint, so a forced theme or a bigger text size doesn't flash the default.
  applySaved();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary name={panel ? "menu bar panel" : "window"} reloadWindow>
        {panel ? <MenuBarPanel /> : <App />}
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void boot();
