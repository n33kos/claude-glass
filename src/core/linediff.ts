// Minimal line diff (LCS) producing unified-style hunks, same shape as Claude Code's
// `structuredPatch` so both sources render identically.

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each prefixed with ' ', '-', or '+'
}

type Op = [' ' | '-' | '+', string];

function ops(a: string[], b: string[]): Op[] {
  if (a.length * b.length > 4_000_000) {
    return [...a.map((l): Op => ['-', l]), ...b.map((l): Op => ['+', l])];
  }
  const n = a.length, m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

export function diffLines(before: string, after: string, context = 3): Hunk[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  const all = ops(a, b);
  const hunks: Hunk[] = [];
  let oldNo = 1, newNo = 1;
  let cur: Hunk | null = null;
  let trailing = 0; // unchanged lines appended since last change
  for (let k = 0; k < all.length; k++) {
    const [t, line] = all[k];
    if (t !== ' ') {
      if (!cur) {
        // start hunk with up to `context` preceding lines
        const pre: Op[] = [];
        for (let p = k - 1; p >= 0 && pre.length < context && all[p][0] === ' '; p--) pre.unshift(all[p]);
        cur = { oldStart: oldNo - pre.length, oldLines: pre.length, newStart: newNo - pre.length, newLines: pre.length, lines: pre.map(([, l]) => ' ' + l) };
        hunks.push(cur);
      }
      cur.lines.push(t + line);
      if (t === '-') cur.oldLines++; else cur.newLines++;
      trailing = 0;
    } else if (cur) {
      if (trailing < context) {
        cur.lines.push(' ' + line); cur.oldLines++; cur.newLines++; trailing++;
      } else {
        // look ahead: if another change is within `context` lines, keep extending
        let next = k;
        while (next < all.length && all[next][0] === ' ') next++;
        if (next < all.length && next - k <= context) {
          cur.lines.push(' ' + line); cur.oldLines++; cur.newLines++;
        } else {
          cur = null; trailing = 0;
        }
      }
    }
    if (t !== '+') oldNo++;
    if (t !== '-') newNo++;
  }
  return hunks;
}
