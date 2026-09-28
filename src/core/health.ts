// Reads a glass's health log (metrics.ndjson, written by src/main/metrics.ts) into a short report:
// what each process type uses now, how that changed since the glass opened, and any crashes.

interface Proc { n: number; mb: number; cpu: number }
interface Sample { t: string; kind: 'sample'; uptimeMin: number; procs: Record<string, Proc>; mainHeapMB: number; sys: { freeMB: number; load1: number }; [k: string]: unknown }
interface Event { t: string; kind: string; [k: string]: unknown }

export function healthReport(text: string): string {
  const entries: Event[] = text.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const lastStart = entries.map((e) => e.kind).lastIndexOf('start');
  const run = lastStart >= 0 ? entries.slice(lastStart) : entries; // since this glass last opened
  const samples = run.filter((e): e is Sample => e.kind === 'sample');
  const gone = entries.filter((e) => e.kind === 'child-gone' || e.kind === 'renderer-gone');
  const lines: string[] = [];
  if (!samples.length) lines.push('No samples yet (the first comes 30 s after the glass opens, then every 5 minutes).');
  else {
    const first = samples[0], last = samples[samples.length - 1];
    lines.push(`Open ${last.uptimeMin} min · ${samples.length} samples · free memory ${last.sys.freeMB} MB · load ${last.sys.load1}`);
    lines.push('', 'process      now (MB)   since open   peak   cpu now');
    for (const [type, p] of Object.entries(last.procs).sort((a, b) => b[1].mb - a[1].mb)) {
      const was = first.procs[type]?.mb ?? p.mb;
      const peak = Math.max(...samples.map((s) => s.procs[type]?.mb ?? 0));
      const delta = p.mb - was;
      lines.push(`${`${type} ×${p.n}`.padEnd(12)} ${String(p.mb).padStart(8)}   ${`${delta >= 0 ? '+' : ''}${delta}`.padStart(10)}   ${String(peak).padStart(4)}   ${p.cpu}%`);
    }
    lines.push(`${'main heap'.padEnd(12)} ${String(last.mainHeapMB).padStart(8)}   ${`${last.mainHeapMB - first.mainHeapMB >= 0 ? '+' : ''}${last.mainHeapMB - first.mainHeapMB}`.padStart(10)}`);
    const counts = Object.entries(last).filter(([k, v]) => typeof v === 'number' && !['uptimeMin', 'mainHeapMB'].includes(k));
    if (counts.length) lines.push('', counts.map(([k, v]) => `${k} ${v}`).join(' · '));
  }
  lines.push('', gone.length ? `Crashed or killed processes (${gone.length}):` : 'No process crashes logged.');
  for (const g of gone.slice(-10)) lines.push(`  ${g.t}  ${g.kind === 'renderer-gone' ? 'renderer' : g.type} ${g.reason}${g.exitCode ? ` (exit ${g.exitCode})` : ''}`);
  return lines.join('\n');
}
