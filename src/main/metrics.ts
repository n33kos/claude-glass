// A cheap health log for chasing slow leaks and GPU trouble after the fact: one JSON line every
// few minutes (Electron's per-process metrics, a few counts) plus a line whenever a child process
// dies. Sampling reads numbers Electron already tracks; it costs next to nothing.
import { app } from 'electron';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

const EVERY_MS = 5 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024; // then rotate to metrics.1.ndjson (one old file kept)

export function startMetrics(dir: string, counts: () => Record<string, number>): () => void {
  const file = join(dir, 'metrics.ndjson');
  const write = (entry: Record<string, unknown>) => {
    try {
      if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, join(dir, 'metrics.1.ndjson'));
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
    } catch {}
  };

  const sample = () => {
    // Per process type: how many, memory (MB, working set) and CPU (% of a core, averaged since the last call).
    const byType: Record<string, { n: number; mb: number; cpu: number }> = {};
    for (const m of app.getAppMetrics()) {
      const k = m.type === 'Tab' ? 'renderer' : m.type.toLowerCase();
      const t = (byType[k] ??= { n: 0, mb: 0, cpu: 0 });
      t.n++;
      t.mb += Math.round((m.memory?.workingSetSize ?? 0) / 1024);
      t.cpu += Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10;
    }
    write({
      kind: 'sample',
      uptimeMin: Math.round(process.uptime() / 60),
      procs: byType,
      mainHeapMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      sys: { freeMB: Math.round(freemem() / 1048576), totalMB: Math.round(totalmem() / 1048576), load1: Math.round(loadavg()[0] * 100) / 100 },
      ...counts(),
    });
  };

  app.on('child-process-gone', (_e, d) => write({ kind: 'child-gone', type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name }));
  app.on('render-process-gone', (_e, _wc, d) => write({ kind: 'renderer-gone', reason: d.reason, exitCode: d.exitCode }));
  write({ kind: 'start', electron: process.versions.electron, pid: process.pid });
  setTimeout(sample, 30_000); // one early sample, then on the interval
  const timer = setInterval(sample, EVERY_MS);
  return () => clearInterval(timer);
}
