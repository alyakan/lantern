/**
 * Pulse: how much of each model is left and what the GPU is doing. Shared by main and renderer.
 */

/** One limit window (the 5-hour one or the weekly one). */
export type PulseWindow = {
  /** 0 to 100. */
  usedPercent: number;
  /** Unix seconds, when the CLI said. */
  resetsAt?: number;
};

export type PlanUsage = {
  fiveHour?: PulseWindow;
  week?: PulseWindow;
  /** Plan name when the CLI gives it ("plus"). */
  plan?: string;
  /** "limit reached" / "using extra usage"; absent when all is normal. */
  note?: string;
  /** Unix seconds of the reading. */
  seenAt: number;
};

export type QwenState = {
  /** Ollama answers on 127.0.0.1:11434. */
  running: boolean;
  /** Models held in memory, with their VRAM share. */
  loaded: { name: string; sizeBytes: number; vramBytes: number; expiresAt?: string }[];
  /** Models pulled into Ollama, largest first. */
  installed: string[];
};

export type GpuState = {
  /** 3D engine load of the busiest adapter, 0 to 100. */
  load: number;
  /** Dedicated VRAM in use on that adapter. */
  vramUsedBytes: number;
  vramTotalBytes?: number;
  /** 3D load from processes other than Ollama (a game), 0 to 100. */
  otherLoad: number;
};

export type PulseSnapshot = {
  claude?: PlanUsage;
  codex?: PlanUsage;
  qwen: QwenState;
  gpu?: GpuState;
  gameMode: boolean;
  /** Unix seconds. */
  at: number;
};
