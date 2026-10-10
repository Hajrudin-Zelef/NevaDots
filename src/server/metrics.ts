import { readFile, statfs } from 'node:fs/promises';

// Lightweight system metrics for the sidebar (Linux / LXC). Values are
// best-effort: if /proc is unavailable the fields come back as null.

interface CpuSample {
  idle: number;
  total: number;
}

let lastCpu: CpuSample | undefined;
let lastNet: { rx: number; tx: number; at: number } | undefined;

async function cpuSample(): Promise<CpuSample | undefined> {
  try {
    const stat = await readFile('/proc/stat', 'utf8');
    const line = stat.split('\n')[0];
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((sum, value) => sum + (value || 0), 0);
    return { idle, total };
  } catch {
    return undefined;
  }
}

function cpuPercent(now: CpuSample): number | null {
  const previous = lastCpu;
  lastCpu = now;
  if (!previous) return null;
  const totalDelta = now.total - previous.total;
  const idleDelta = now.idle - previous.idle;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100));
}

async function memPercent(): Promise<number | null> {
  try {
    const mem = await readFile('/proc/meminfo', 'utf8');
    const value = (key: string) => {
      const match = mem.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return match ? Number(match[1]) : 0;
    };
    const total = value('MemTotal');
    const available = value('MemAvailable');
    if (!total) return null;
    return Math.max(0, Math.min(100, ((total - available) / total) * 100));
  } catch {
    return null;
  }
}

async function diskPercent(): Promise<number | null> {
  try {
    const info = await statfs('/');
    const total = info.blocks * info.bsize;
    const free = info.bfree * info.bsize;
    if (!total) return null;
    return Math.max(0, Math.min(100, ((total - free) / total) * 100));
  } catch {
    return null;
  }
}

async function netRate(): Promise<{ rx: number; tx: number } | null> {
  try {
    const dev = await readFile('/proc/net/dev', 'utf8');
    let rx = 0;
    let tx = 0;
    for (const line of dev.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest) continue;
      const iface = name.trim();
      if (iface === 'lo') continue;
      const fields = rest.trim().split(/\s+/).map(Number);
      rx += fields[0] ?? 0;
      tx += fields[8] ?? 0;
    }
    const now = Date.now();
    const previous = lastNet;
    lastNet = { rx, tx, at: now };
    if (!previous) return { rx: 0, tx: 0 };
    const seconds = Math.max(0.001, (now - previous.at) / 1000);
    return {
      rx: Math.max(0, (rx - previous.rx) / seconds),
      tx: Math.max(0, (tx - previous.tx) / seconds),
    };
  } catch {
    return null;
  }
}

export interface SystemMetrics {
  cpu: number | null;
  mem: number | null;
  disk: number | null;
  netIn: number | null;
  netOut: number | null;
  uptime: number;
  model: string | null;
}

export async function systemMetrics(): Promise<SystemMetrics> {
  const sample = await cpuSample();
  const [mem, disk, net] = await Promise.all([
    memPercent(),
    diskPercent(),
    netRate(),
  ]);
  return {
    cpu: sample ? cpuPercent(sample) : null,
    mem,
    disk,
    netIn: net?.rx ?? null,
    netOut: net?.tx ?? null,
    uptime: Math.round(process.uptime()),
    model: process.env.OPENAI_MODEL ?? null,
  };
}
