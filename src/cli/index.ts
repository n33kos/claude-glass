// claude-glass CLI. Thin client over the per-session Unix socket.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { bindSession, glassIdFor, isBound } from '../core/binding';
import { loadConfig } from '../core/config';
import { appsDir, filesDir, sessionsDir, socketPath, statePath, assertSessionId } from '../core/paths';
import { isLive, loadState } from '../core/server';
import type { Action, Envelope } from '../core/types';
import { request } from './client';
import { GUIDE, guideFor } from '../core/guide';
import { launchGlass } from './launch';

interface Parsed { pos: string[]; flags: Record<string, string | true> }

function parse(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; }
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function claudeSessionId(flags: Parsed['flags']): string {
  const id = (typeof flags.session === 'string' && flags.session) || process.env.CLAUDE_GLASS_SESSION || process.env.CLAUDE_CODE_SESSION_ID;
  if (!id) throw new Error('no session: pass --session ID (or run inside Claude Code, which sets CLAUDE_CODE_SESSION_ID)');
  return assertSessionId(id);
}

/** The glass this session feeds (a folder glass when scope is folder). */
const sessionId = (flags: Parsed['flags']): string => glassIdFor(claudeSessionId(flags));

async function call(sid: string, env: Envelope): Promise<any> {
  const reply = await request(socketPath(sid), env);
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}

const dispatch = (sid: string, action: Action) => call(sid, { op: 'dispatch', action });

function readStdin(): string {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

/** Turn CLI flags into app command args. --file/--text become text; --x-file reads files. */
function commandArgs(appType: string, command: string, flags: Parsed['flags'], sid: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags)) {
    if (k === 'session') continue;
    if (k.endsWith('-file') && typeof v === 'string') { args[k.slice(0, -5)] = readFileSync(resolve(v), 'utf8'); continue; }
    args[k] = v;
  }
  if (args.text === '-') args.text = readStdin();
  if (typeof args.file === 'string') {
    const path = resolve(args.file);
    if (!existsSync(path)) throw new Error(`file not found: ${path}`);
    if (appType === 'image' || (appType === 'browser' && command === 'frame')) {
      args.file = ingest(sid, path);
      args.name = basename(path);
    } else if (args.text === undefined) {
      args.text = readFileSync(path, 'utf8');
      args.source = path;
      delete args.file;
    }
  }
  if (appType === 'image' && command === 'add' && typeof args.file !== 'string') throw new Error('image add needs --file <path>');
  return args;
}

function ingest(sid: string, path: string): string {
  const dir = filesDir(sid);
  mkdirSync(dir, { recursive: true });
  const dest = `${dir}/${Date.now()}-${basename(path).replace(/[^\w.-]/g, '_')}`;
  copyFileSync(path, dest);
  return dest;
}

function formatView(v: any): string {
  const lines = [`Claude Glass "${v.session.title}" · ${v.session.activity}${v.session.ended ? ' · session ended' : ''} · user is viewing desktop ${v.userViewingDesktop + 1}`];
  for (const d of v.desktops) {
    lines.push(`Desktop ${d.desktop + 1} [${d.layout}]`);
    if (!d.windows.length) lines.push('  (empty)');
    for (const w of d.windows) lines.push(`  ${String(w.index).padStart(2)}  ${w.id.padEnd(16)} ${w.type.padEnd(12)} ${w.title}${w.pinned ? '  [pinned]' : ''}`);
  }
  if (v.closed.length) lines.push(`Closed: ${v.closed.map((c: any) => `${c.id} (${c.type})`).join(', ')}`);
  return lines.join('\n');
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

const HELP = `claude-glass — Claude's monitor for this Claude Code session

${GUIDE.split('\n').slice(8).join('\n')}

Other: open | close | status [--all] | state [id] | settings [set <key> <value>] | --session ID | --json
Apps:  apps (list) | apps new <type> | apps eject <type>   (custom apps live in ~/.claude/claude-glass/apps)`;

async function main(argv: string[]) {
  const { pos, flags } = parse(argv);
  const [cmd, ...rest] = pos;
  const json = flags.json === true;
  const out = (v: unknown, text?: string) => console.log(json || text === undefined ? JSON.stringify(v, null, 2) : text);

  switch (cmd) {
    case undefined: case 'help': case '--help':
      console.log(HELP); return;

    case 'open': {
      const cid = claudeSessionId(flags);
      const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
      // SessionStart normally binds (with the real project dir); this covers sessions it missed.
      const sid = isBound(cid) ? glassIdFor(cid) : bindSession(cid, cwd, loadConfig().scope);
      const r = await launchGlass(sid, cwd);
      console.log(r === 'already' ? 'Claude Glass already open.\n' : 'Claude Glass opened.\n');
      console.log(await call(sid, { op: 'guide' }).catch(() => guideFor(loadConfig())));
      return;
    }
    case 'close': {
      const sid = sessionId(flags);
      await call(sid, { op: 'quit' });
      console.log('Claude Glass closed.');
      return;
    }
    case 'status': {
      const dir = sessionsDir();
      const ids = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(statePath(d))) : [];
      const rows = await Promise.all(ids.map(async (id) => {
        const s = loadState(id);
        return { id, title: s?.session.title ?? '?', cwd: s?.session.cwd ?? '', running: await isLive(socketPath(id), 300), updated: statSync(statePath(id)).mtimeMs };
      }));
      rows.sort((a, b) => Number(b.running) - Number(a.running) || b.updated - a.updated);
      const shown = flags.all ? rows : rows.slice(0, 15);
      out(shown, shown.length ? shown.map((r) => `${r.running ? '● open  ' : '○ closed'}  ${r.id}  ${r.title}  ${new Date(r.updated).toLocaleString()}  ${r.cwd}`).join('\n') : 'No glass windows yet.');
      return;
    }
    case 'view': {
      const v = await call(sessionId(flags), { op: 'view' });
      out(v, formatView(v));
      return;
    }
    case 'catalog': {
      const c = await call(sessionId(flags), { op: 'catalog' });
      out(c, c.map((a: any) => `${a.type}${a.singleton ? ' (singleton)' : ''} — ${a.description}\n${Object.values(a.commands).map((x: any) => `    ${x.usage}  — ${x.help}`).join('\n')}`).join('\n'));
      return;
    }
    case 'state': {
      const r = await call(sessionId(flags), { op: 'state', id: rest[0] });
      out(r);
      return;
    }
    case 'new': {
      const sid = sessionId(flags);
      const appType = rest[0];
      if (!appType) throw new Error('usage: claude-glass new <type> [--id ID] [--title T] [--no-open]');
      const id = await dispatch(sid, {
        type: 'instance.create', appType,
        id: typeof flags.id === 'string' ? flags.id : undefined,
        title: typeof flags.title === 'string' ? flags.title : undefined,
        open: flags['no-open'] ? false : true,
      });
      out({ id }, String(id));
      return;
    }
    case 'app': {
      const sid = sessionId(flags);
      const [id, command] = rest;
      if (!id || !command) throw new Error('usage: claude-glass app <id> <command> [--flags]');
      // Singletons (browser, terminal...) are addressed by type; the first use creates and opens one.
      const st = await call(sid, { op: 'state', id }).catch(async (e) => {
        const catalog: { type: string; singleton: boolean }[] = await call(sid, { op: 'catalog' });
        if (!catalog.some((a) => a.type === id && a.singleton)) throw e;
        await dispatch(sid, { type: 'instance.create', appType: id });
        return call(sid, { op: 'state', id });
      });
      const { json: _j, ...f } = flags;
      await dispatch(sid, { type: 'app.command', id, command, args: commandArgs(st.instance.type, command, f, sid) });
      out({ ok: true }, 'ok');
      return;
    }
    case 'show': {
      const sid = sessionId(flags);
      const file = rest[0];
      if (!file) throw new Error('usage: claude-glass show <file> [--title T] [--id ID]');
      const path = resolve(file);
      if (!existsSync(path)) throw new Error(`file not found: ${path}`);
      const ext = extname(path).toLowerCase();
      const title = typeof flags.title === 'string' ? flags.title : basename(path);
      const [appType, command, args] = IMAGE_EXT.has(ext)
        ? ['image', 'add', { file: ingest(sid, path), name: basename(path), caption: flags.caption }]
        : ext === '.html' || ext === '.htm'
          ? ['html', 'render', { text: readFileSync(path, 'utf8') }]
          : ext === '.md' || ext === '.markdown' || ext === '.txt'
            ? ['markdown', 'set', { text: readFileSync(path, 'utf8'), source: path }]
            : ['markdown', 'set', { text: '```' + ext.slice(1) + '\n' + readFileSync(path, 'utf8') + '\n```', source: path }];
      const id = await dispatch(sid, { type: 'instance.create', appType, id: typeof flags.id === 'string' ? flags.id : undefined, title });
      await dispatch(sid, { type: 'app.command', id: String(id), command, args });
      out({ id }, `${id} (${appType})`);
      return;
    }
    case 'window': {
      const sid = sessionId(flags);
      const [sub, id, arg] = rest;
      if (!id) throw new Error('usage: claude-glass window open|close|move|pin|unpin|opacity <id> [arg]');
      if (sub === 'open') await dispatch(sid, { type: 'window.open', id });
      else if (sub === 'close') await dispatch(sid, { type: 'window.close', id });
      else if (sub === 'move') await dispatch(sid, { type: 'window.move', id, index: Number(arg ?? 0) });
      else if (sub === 'pin') await dispatch(sid, { type: 'window.pin', id, index: arg === undefined ? undefined : Number(arg) });
      else if (sub === 'unpin') await dispatch(sid, { type: 'window.unpin', id });
      else if (sub === 'opacity') await dispatch(sid, { type: 'window.opacity', id, value: arg === undefined || arg === 'reset' ? null : Number(arg) });
      else if (sub === 'rename') await dispatch(sid, { type: 'instance.rename', id, title: String(arg ?? id) });
      else throw new Error(`unknown window command "${sub}"`);
      out({ ok: true }, 'ok');
      return;
    }
    case 'layout': {
      const sid = sessionId(flags);
      const [desk, layout] = rest;
      if (!desk || !layout) throw new Error('usage: claude-glass layout <desktop#> <full|split|main-left|columns|grid>');
      await dispatch(sid, { type: 'desktop.layout', desktop: Number(desk) - 1, layout: layout as any });
      out({ ok: true }, 'ok');
      return;
    }
    case 'apps': {
      const [sub, type] = rest;
      const dir = appsDir();
      if (sub === 'new' || sub === 'eject') {
        if (!type || !/^[a-z][a-z0-9-]{0,31}$/.test(type)) throw new Error(`usage: claude-glass apps ${sub} <type>   (lowercase letters, digits, dashes)`);
        const dest = join(dir, type);
        if (existsSync(dest)) throw new Error(`${dest} already exists`);
        if (sub === 'new') {
          cpSync(join(__dirname, '..', 'templates', 'app'), dest, { recursive: true });
          const title = type.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
          for (const f of readdirSync(dest)) {
            const p = join(dest, f);
            writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__TYPE__', type).replaceAll('__TITLE__', title));
          }
          console.log(`Created ${dest}\nEdit it, then restart the glass (claude-glass close && claude-glass open).`);
        } else {
          const src = join(__dirname, 'apps', type);
          if (!existsSync(src)) throw new Error(`no built-in app "${type}" (built-ins: ${readdirSync(join(__dirname, 'apps')).join(', ')})`);
          cpSync(src, dest, { recursive: true });
          console.log(`Copied the built-in "${type}" app to ${dest}. It now overrides the built-in; restart the glass to load it.\nIts view is compiled React (the TypeScript sources are in src/ for reference); replace view.html to write your own.`);
        }
        return;
      }
      // List: from the live glass (what actually loaded), else what's on disk.
      const cat: any[] | null = await call(sessionId(flags), { op: 'catalog' }).catch(() => null);
      const reports: any[] = await call(sessionId(flags), { op: 'mods' }).catch(() => []);
      const rows = cat
        ? cat.map((a) => `${a.source === 'user' ? 'custom ' : 'builtin'}  ${a.type.padEnd(14)} ${a.title}`)
        : ['(glass not open: showing folders only)', ...(existsSync(dir) ? readdirSync(dir).map((d) => `custom   ${d}`) : [])];
      for (const r of reports) if (!r.ok) rows.push(`FAILED   ${r.type.padEnd(14)} ${r.error}  (${r.dir})`);
      out({ apps: cat, mods: reports }, [...rows, '', `Custom apps folder: ${dir}`].join('\n'));
      return;
    }
    case 'settings': {
      const [sub, key, value] = rest;
      if (sub === 'set') {
        if (!key) throw new Error('usage: claude-glass settings set <key> <value>');
        const sid = sessionId(flags);
        const parsed = value === 'true' ? true : value === 'false' ? false : value;
        const r = key.startsWith('session.')
          ? await dispatch(sid, { type: 'settings.set', key: key.slice(8), value: parsed })
          : await call(sid, { op: 'config', key, value: parsed });
        out(r ?? { ok: true });
      } else {
        out({ global: loadConfig() });
      }
      return;
    }
    case 'hook': {
      // Forward a hook payload from stdin (the bash forwarder is the fast path; this is the fallback).
      const raw = readStdin();
      let payload: any;
      try { payload = JSON.parse(raw); } catch { return; }
      const sid = payload?.session_id;
      if (!sid || !existsSync(socketPath(sid))) return; // off means off
      await request(socketPath(sid), { op: 'hook', payload }, 2000).catch(() => {});
      return;
    }
    case 'session-start-hook': {
      const raw = readStdin();
      let p: any = {};
      try { p = JSON.parse(raw); } catch {}
      if (!p.session_id) return;
      const config = loadConfig();
      const projectDir = process.env.CLAUDE_PROJECT_DIR || p.cwd || process.cwd();
      const sid = bindSession(assertSessionId(p.session_id), projectDir, config.scope);
      const live = await isLive(socketPath(sid), 300);
      let open = live;
      if (!live && config.autoStart && (p.source === 'startup' || p.source === 'resume' || !p.source)) {
        try { await launchGlass(sid, projectDir); open = true; } catch { open = false; }
      }
      if (open) {
        if (live) await request(socketPath(sid), { op: 'hook', payload: p }, 1000).catch(() => {});
        const guide = await request(socketPath(sid), { op: 'guide' }, 1000).then((r) => (r.ok ? String(r.result) : null)).catch(() => null);
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: guide ?? guideFor(config) } }));
      }
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}". Run: claude-glass help`);
  }
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`claude-glass: ${e.message}`);
  process.exit(1);
});
