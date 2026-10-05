import { useEffect, useState } from "react";
import { api } from "../api";

let cached: Promise<string | null> | null = null;

/** The user's name for their messages, asked for once; null until known or when there's none. */
export function useUserName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    cached ??= api.userName().catch(() => null);
    cached.then((n) => live && setName(n));
    return () => {
      live = false;
    };
  }, []);
  return name;
}

/** "Ada Lovelace" → "AL"; one word → its first letter. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return letters.map((w) => [...w][0]?.toUpperCase() ?? "").join("");
}
