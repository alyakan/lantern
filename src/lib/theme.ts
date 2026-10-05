import { useEffect, useState } from "react";

const QUERY = "(prefers-color-scheme: dark)";
// Light where the page can't be asked (tests' jsdom has no matchMedia).
const query = () => (typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
