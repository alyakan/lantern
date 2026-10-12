import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { guardWindowClose } from "./lib/editStash";

async function boot() {
  // `npm run dev` then open /?mock to design the UI in a browser against a fake backend (dev builds only).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    (await import("./dev/mockBackend")).installMockBackend();
  }
  // Once for the app, not per component: closing the window asks about unsaved edits in any file.
  guardWindowClose();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
