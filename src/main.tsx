import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

async function boot() {
  // `npm run dev` then open /?mock to design the UI in a browser against a fake backend (dev builds only).
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mock")) {
    (await import("./dev/mockBackend")).installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
