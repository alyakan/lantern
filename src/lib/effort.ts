/** Every level `--effort` takes, lowest first; a model may support only some. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const LABEL: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
export const EFFORT_HINT: Record<string, string> = {
  low: "Fastest, least thinking",
  medium: "Quicker, lighter thinking",
  high: "Thorough reasoning",
  xhigh: "Deeper than high",
  max: "The most thinking, slowest",
};

export const effortLabel = (level: string | null) => (level ? (LABEL[level] ?? level) : "Default");
