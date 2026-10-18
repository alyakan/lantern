/**
 * Pulse: remaining plan budgets, local model state and GPU load, for the always-on strip.
 *
 * Nothing here reads a credential. Claude reports its plan's limits in every stream-json turn
 * (`rate_limit_event`), so a tiny Haiku probe asks for them at most every 15 minutes. Codex writes
 * ChatGPT's limits into its own session logs. Ollama and Windows performance counters cover the GPU.
 */
import { execFile, spawn } from 'child_process';
import { existsSync, type Dirent } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { GpuState, PlanUsage, PulseSnapshot, PulseWindow, QwenState } from '@/common/types/cockpitPulse';

const OLLAMA = 'http://127.0.0.1:11434';
const CLAUDE_PROBE_MS = 15 * 60 * 1000;

const now = () => Math.floor(Date.now() / 1000);

type ClaudeWindow = { utilization?: number; resetsAt?: number };

/** `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.39,"resetsAt":…},"seven_day":{…}}}}` */
export function parseClaudeEvent(value: unknown, seenAt: number): PlanUsage | undefined {
  const info = (value as { rate_limit_info?: Record<string, unknown> })?.rate_limit_info;
  const windows = info?.unifiedWindows as Record<string, ClaudeWindow> | undefined;
  const toWindow = (w?: ClaudeWindow): PulseWindow | undefined =>
    typeof w?.utilization === 'number'
      ? { usedPercent: Math.min(100, Math.max(0, w.utilization * 100)), resetsAt: w.resetsAt }
      : undefined;
  const fiveHour = toWindow(windows?.five_hour);
  const week = toWindow(windows?.seven_day);
  if (!fiveHour && !week) return undefined;
  const note =
    info?.status === 'rejected' ? 'limit reached' : info?.isUsingOverage === true ? 'using extra usage' : undefined;
  return { fiveHour, week, note, seenAt };
}

type CodexWindow = { used_percent?: number; window_minutes?: number; resets_at?: number };

/** A Codex session-log line carrying `"rate_limits":{"primary":{…},"secondary":{…},"plan_type":"plus"}`. */
export function parseCodexLine(line: string, seenAt: number): PlanUsage | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const payload = value.payload as Record<string, unknown> | undefined;
  const candidates = [
    payload?.rate_limits,
    (payload?.info as Record<string, unknown> | undefined)?.rate_limits,
    value.rate_limits,
  ];
  const limits = candidates.find((c) => c && typeof c === 'object') as Record<string, unknown> | undefined;
  if (!limits) return undefined;
  let fiveHour: PulseWindow | undefined;
  let week: PulseWindow | undefined;
  for (const raw of [limits.primary, limits.secondary] as (CodexWindow | undefined)[]) {
    if (typeof raw?.used_percent !== 'number') continue;
    const w = { usedPercent: Math.min(100, Math.max(0, raw.used_percent)), resetsAt: raw.resets_at };
    if ((raw.window_minutes ?? 0) >= 1440) week = w;
    else fiveHour ??= w;
  }
  if (!fiveHour && !week) return undefined;
  const reached = typeof limits.rate_limit_reached_type === 'string' && limits.rate_limit_reached_type !== '';
  return {
    fiveHour,
    week,
    plan: typeof limits.plan_type === 'string' ? limits.plan_type : undefined,
    note: reached ? 'limit reached' : undefined,
    seenAt,
  };
}

/** Newest ChatGPT limits in ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, looking at the latest few logs. */
export async function codexUsage(codexHome = path.join(os.homedir(), '.codex')): Promise<PlanUsage | undefined> {
  const logs: { mtime: number; file: string }[] = [];
  const stack = [path.join(codexHome, 'sessions')];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.jsonl')) {
        const stat = await fs.stat(full).catch((): undefined => undefined);
        if (stat) logs.push({ mtime: stat.mtimeMs, file: full });
      }
    }
  }
  logs.sort((a, b) => b.mtime - a.mtime);
  for (const log of logs.slice(0, 5)) {
    const text = await fs.readFile(log.file, 'utf8').catch(() => '');
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const usage = parseCodexLine(lines[i], Math.floor(log.mtime / 1000));
      if (usage) return usage;
    }
  }
  return undefined;
}

/** The native installer's claude.exe when present, else whatever `claude` is on PATH. */
function defaultClaudeBin(): string {
  const local = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return existsSync(local) ? local : 'claude';
}

/** Runs one tiny Haiku turn and returns the plan limits Claude reports with it. */
export function probeClaude(claudeBin = defaultClaudeBin(), timeoutMs = 60_000): Promise<PlanUsage | undefined> {
  const bare = !path.isAbsolute(claudeBin);
  return new Promise((resolve) => {
    const child = spawn(
      claudeBin,
      [
        '-p',
        'Reply: ok',
        '--model',
        'haiku',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '1',
        '--no-session-persistence',
      ],
      { cwd: os.tmpdir(), windowsHide: true, shell: bare && process.platform === 'win32' }
    );
    let buffer = '';
    let found: PlanUsage | undefined;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.includes('"rate_limit_event"')) {
          try {
            found = parseClaudeEvent(JSON.parse(line), now()) ?? found;
          } catch {
            // ignore partial lines
          }
        }
        newline = buffer.indexOf('\n');
      }
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(found);
    });
  });
}

/** Loaded models from Ollama's /api/ps. */
export async function qwenState(): Promise<QwenState> {
  try {
    const [ps, tags] = await Promise.all(
      ['ps', 'tags'].map((route) =>
        fetch(`${OLLAMA}/api/${route}`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json())
      )
    );
    const body = ps as { models?: { name: string; size: number; size_vram: number; expires_at?: string }[] };
    const pulled = ((tags as { models?: { name: string; size: number }[] }).models ?? []).toSorted(
      (a, b) => b.size - a.size
    );
    return {
      running: true,
      installed: pulled.map((m) => m.name),
      loaded: (body.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size,
        vramBytes: m.size_vram,
        expiresAt: m.expires_at,
      })),
    };
  } catch {
    return { running: false, loaded: [], installed: [] };
  }
}

/** Asks Ollama to drop a model from memory now (keep_alive 0). */
export async function unloadModel(name: string): Promise<void> {
  await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model: name, keep_alive: 0 }),
    signal: AbortSignal.timeout(10_000),
  }).catch((): undefined => undefined);
}

/** Loads a model into memory without generating anything. */
export async function loadModel(name: string): Promise<void> {
  await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    body: JSON.stringify({ model: name, keep_alive: '30m' }),
    signal: AbortSignal.timeout(120_000),
  }).catch((): undefined => undefined);
}

// Picks the adapter with the most dedicated VRAM (the 7900 XTX, not the iGPU that drives the display)
// from the DirectX registry, then sums 3D engine load on it, split into Ollama and everything else.
const GPU_SCRIPT = String.raw`
$ErrorActionPreference='SilentlyContinue'
$a=Get-ChildItem HKLM:\SOFTWARE\Microsoft\DirectX | ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.AdapterLuid } | Sort-Object DedicatedVideoMemory -Descending | Select-Object -First 1
$luid='0x{0:x8}' -f ($a.AdapterLuid -band 0xffffffff)
$o=(Get-Process ollama*,'ollama app').Id
$load=0;$other=0
foreach($s in (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage').CounterSamples){ if($s.InstanceName -match ('pid_(\d+)_luid_0x[0-9a-f]+_'+$luid)){ $load+=$s.CookedValue; if(-not ($o -contains [int]$matches[1])){ $other+=$s.CookedValue } } }
$vram=0; foreach($s in (Get-Counter '\GPU Adapter Memory(*)\Dedicated Usage').CounterSamples){ if($s.InstanceName -match $luid){ $vram=$s.CookedValue } }
@{load=[math]::Round($load,1);other=[math]::Round($other,1);vram=$vram;total=[double]$a.DedicatedVideoMemory}|ConvertTo-Json -Compress
`;

/** 3D load and VRAM of the biggest GPU. Windows only. */
export function gpuState(): Promise<GpuState | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', GPU_SCRIPT],
      { windowsHide: true, timeout: 15_000 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const value = JSON.parse(stdout.trim()) as { load: number; other: number; vram: number; total: number };
          resolve({
            load: Math.min(100, value.load),
            otherLoad: Math.min(100, value.other),
            vramUsedBytes: value.vram,
            vramTotalBytes: value.total || undefined,
          });
        } catch {
          resolve(undefined);
        }
      }
    );
  });
}

type PulseFiles = { claudeFile: string; settingsFile: string };

/** Keeps the latest reading of each source and refreshes them on their own schedules. */
export class Pulse {
  private claude?: PlanUsage;
  private codex?: PlanUsage;
  private qwen: QwenState = { running: false, loaded: [], installed: [] };
  private gpu?: GpuState;
  private gameMode = false;
  private probing?: Promise<void>;
  private lastProbe = 0;

  constructor(private readonly files: PulseFiles) {}

  async init(): Promise<void> {
    try {
      this.claude = JSON.parse(await fs.readFile(this.files.claudeFile, 'utf8')) as PlanUsage;
      this.lastProbe = (this.claude?.seenAt ?? 0) * 1000;
    } catch {
      // first run
    }
    try {
      this.gameMode = Boolean(
        (JSON.parse(await fs.readFile(this.files.settingsFile, 'utf8')) as { gameMode?: boolean }).gameMode
      );
    } catch {
      // first run
    }
  }

  /** Fresh local readings; Claude is probed only when its reading is older than 15 minutes, or when forced. */
  async snapshot(forceClaude = false): Promise<PulseSnapshot> {
    const [codex, qwen, gpu] = await Promise.all([codexUsage(), qwenState(), gpuState()]);
    this.codex = codex ?? this.codex;
    this.qwen = qwen;
    this.gpu = gpu ?? this.gpu;
    if (forceClaude || Date.now() - this.lastProbe > CLAUDE_PROBE_MS) {
      if (forceClaude) await this.refreshClaude();
      else void this.refreshClaude();
    }
    return this.current();
  }

  current(): PulseSnapshot {
    return {
      claude: this.claude,
      codex: this.codex,
      qwen: this.qwen,
      gpu: this.gpu,
      gameMode: this.gameMode,
      at: now(),
    };
  }

  isGameMode(): boolean {
    return this.gameMode;
  }

  /** Game mode: drop every local model from the GPU and keep the dispatcher off local models. */
  async setGameMode(on: boolean): Promise<PulseSnapshot> {
    this.gameMode = on;
    await fs.mkdir(path.dirname(this.files.settingsFile), { recursive: true });
    await fs.writeFile(this.files.settingsFile, JSON.stringify({ gameMode: on }), 'utf8');
    if (on) {
      const qwen = await qwenState();
      await Promise.all(qwen.loaded.map((m) => unloadModel(m.name)));
    }
    return this.snapshot();
  }

  private refreshClaude(): Promise<void> {
    this.probing ??= probeClaude()
      .then(async (usage) => {
        this.lastProbe = Date.now();
        if (!usage) return;
        this.claude = usage;
        await fs.mkdir(path.dirname(this.files.claudeFile), { recursive: true });
        await fs.writeFile(this.files.claudeFile, JSON.stringify(usage), 'utf8');
      })
      .finally(() => {
        this.probing = undefined;
      });
    return this.probing;
  }
}
