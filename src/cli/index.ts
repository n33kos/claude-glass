// claude-glass CLI. Thin client over the per-session Unix socket.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { bindSession, cleanupRuntime, glassIdFor, isBound, isOwnSocket } from '../core/binding';
import { loadConfig, SETTINGS_HELP } from '../core/config';
import { appsDir, configPath, filesDir, runtimeDir, sessionDir, sessionsDir, socketPath, statePath, assertSessionId } from '../core/paths';
import { healthReport } from '../core/health';
import { isLive, loadState } from '../core/server';
import type { Action, Envelope, Reply } from '../core/types';
import { request } from './client';
import { GUIDE, guideFor } from '../core/guide';
import { launchGlass } from './launch';
import { formatView } from '../core/viewtext';

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
      if (appType === 'image') args.source = resolve(path);
    } else if (args.text === undefined) {
      args.text = readFileSync(path, 'utf8');
      args.source = path;
      delete args.file;
    }
  }
  if (appType === 'image' && command === 'add' && typeof args.file !== 'string') throw new Error('image add needs --file <path>');
  return args;
}

/**
 * The glass mod runs `session-start` in every session it's loaded in; this marker lets `open` tell
 * a session without the mod (mods off, an org's policy) apart from one that simply has no glass yet.
 */
const modMarker = (cid: string) => join(runtimeDir(), `${cid}.mod`);
function markModLoaded(cid: string) {
  try { mkdirSync(runtimeDir(), { recursive: true, mode: 0o700 }); writeFileSync(modMarker(cid), String(Date.now())); } catch {}
}

const NO_MOD = `Warning: the Claude Glass mod isn't running in this Claude session, so the glass won't fill
itself (conversation, terminal, changes, plan...). The glass needs Claude Code mods: Claude Code
2.1.287 or newer, with mods allowed (not turned off by disableAllHooks or an organization's policy).
Tell the user; a session started after fixing that picks it up.`;

function ingest(sid: string, path: string): string {
  const dir = filesDir(sid);
  mkdirSync(dir, { recursive: true });
  const dest = `${dir}/${Date.now()}-${basename(path).replace(/[^\w.-]/g, '_')}`;
  copyFileSync(path, dest);
  return dest;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

const HELP = `claude-glass — Claude's monitor for this Claude Code session

${GUIDE.slice(GUIDE.indexOf('  claude-glass view'))}

Presets: preset list | preset save <name> [--description D] | preset apply <name> | preset delete <name> | preset default <name|none> | open --preset <name>
Other: open | close | status [--all] | state [id] | health | settings [set <key> <value>] | --session ID | --json
Apps:  apps (list) | apps new <type> | apps copy <type>   (custom apps live in ~/.claude/claude-glass/apps)
       stored <type> [set <key> <json> | reset [key]]   an app's persistent values`;

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
      await cleanupRuntime();
      // The mod binds at session start (with the real project dir); this covers sessions it missed.
      const sid = isBound(cid) ? glassIdFor(cid) : bindSession(cid, cwd, loadConfig().scope);
      const r = await launchGlass(sid, cwd);
      console.log(r === 'already' ? 'Claude Glass already open.\n' : 'Claude Glass opened.\n');
      if (!flags.session && !existsSync(modMarker(cid))) {
        console.log(`${NO_MOD}\n`);
        await dispatch(sid, { type: 'session.update', patch: { modMissing: true } }).catch(() => {});
      }
      if (typeof flags.preset === 'string') {
        const p = await call(sid, { op: 'preset', action: 'apply', name: flags.preset });
        console.log(`Preset "${p.applied}" applied.${p.skipped.length ? ` Skipped (app not installed): ${p.skipped.join(', ')}` : ''}\n`);
      }
      console.log(await call(sid, { op: 'guide' }).catch(() => guideFor(loadConfig())));
      return;
    }
    case 'relaunch': {
      // Run by a glass that's out of date, from the new version: wait for that glass to exit, then
      // open the same glass (its id, not a session) from here. No session binding changes.
      const glass = assertSessionId(String(flags.glass ?? ''));
      const after = Number(flags.after);
      const deadline = Date.now() + 20000;
      const alive = () => { try { process.kill(after, 0); return true; } catch { return false; } };
      while (Date.now() < deadline && ((after > 0 && alive()) || (await isLive(socketPath(glass), 200)))) await new Promise((r) => setTimeout(r, 200));
      await launchGlass(glass, typeof flags.cwd === 'string' ? flags.cwd : process.cwd());
      return;
    }
    case 'close': {
      const sid = sessionId(flags);
      try {
        await call(sid, { op: 'quit' });
        console.log('Claude Glass closed.');
      } catch {
        // Not running (or died without cleaning up): clear its leftovers instead of erroring.
        await cleanupRuntime();
        console.log('Claude Glass was not running.');
      }
      return;
    }
    case 'status': {
      await cleanupRuntime();
      const dir = sessionsDir();
      const ids = existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(statePath(d))) : [];
      const rows = await Promise.all(ids.map(async (id) => {
        const s = loadState(id);
        return { id, title: s?.session.title ?? '?', cwd: s?.session.cwd ?? '', running: isOwnSocket(id) && (await isLive(socketPath(id), 300)), updated: statSync(statePath(id)).mtimeMs };
      }));
      rows.sort((a, b) => Number(b.running) - Number(a.running) || b.updated - a.updated);
      const shown = flags.all ? rows : rows.slice(0, 15);
      out(shown, shown.length ? shown.map((r) => `${r.running ? '● open  ' : '○ closed'}  ${r.id}  ${r.title}  ${new Date(r.updated).toLocaleString()}  ${r.cwd}`).join('\n') : 'No glass windows yet.');
      return;
    }
    case 'preset': case 'presets': {
      // Saved frames: docks, layouts, this glass's settings and the look settings.
      const sid = sessionId(flags);
      const [sub = 'list', ...words] = rest;
      const name = words.join(' ') || undefined;
      const description = typeof flags.description === 'string' ? flags.description : undefined;
      const r = await call(sid, { op: 'preset', action: sub, name, description });
      if (sub === 'list') {
        const rows = r.presets.map((p: any) => {
          const sides = Object.entries(p.sidebars ?? {}).map(([e, sb]: [string, any]) => `${e}: ${sb.windows.map((w: any) => w.id).join('+')}`).join(', ');
          return `  ${p.name}${p.name === r.default ? ' (default)' : ''}${p.description ? ` — ${p.description}` : ''}${sides ? `\n      docks ${sides}` : ''}`;
        });
        out(r, rows.length ? ['Presets (claude-glass preset apply <name>):', ...rows].join('\n')
          : 'No presets yet. Arrange the glass, then: claude-glass preset save <name> --description "what it\'s for"');
      } else if (sub === 'apply') out(r, `Preset "${r.applied}" applied.${r.skipped.length ? ` Skipped (app not installed): ${r.skipped.join(', ')}` : ''}`);
      else if (sub === 'save') out(r, `Saved preset "${r.name}".`);
      else if (sub === 'default') out(r, r.default ? `New glasses start with "${r.default}".` : 'No default preset.');
      else out(r ?? { ok: true }, 'ok');
      return;
    }
    case 'health': {
      // The glass's health log: memory/CPU per process type over time, and any crashes.
      const file = join(sessionDir(sessionId(flags)), 'metrics.ndjson');
      if (!existsSync(file)) throw new Error('no health log for this glass yet (it starts when the glass opens)');
      console.log(healthReport(readFileSync(file, 'utf8')));
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
      // An app's type works as a window id (browser, terminal...): the first use creates and opens it.
      const st = await call(sid, { op: 'state', id }).catch(async (e) => {
        const catalog: { type: string }[] = await call(sid, { op: 'catalog' });
        if (!catalog.some((a) => a.type === id)) throw e;
        await dispatch(sid, { type: 'instance.create', appType: id, id });
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
      // Images all go to the one Images window (unless an id is given).
      const id = await dispatch(sid, {
        type: 'instance.create', appType,
        id: typeof flags.id === 'string' ? flags.id : appType === 'image' ? 'images' : undefined,
        title: appType === 'image' && typeof flags.id !== 'string' ? 'Images' : title,
      });
      await dispatch(sid, { type: 'app.command', id: String(id), command, args });
      out({ id }, `${id} (${appType})`);
      return;
    }
    case 'window': {
      const sid = sessionId(flags);
      const [sub, id, arg] = rest;
      if (!id) throw new Error('usage: claude-glass window open|close|move|dock|undock|delete|opacity <id> [arg]');
      if (sub === 'open') await dispatch(sid, { type: 'window.open', id });
      else if (sub === 'close') await dispatch(sid, { type: 'window.close', id });
      else if (sub === 'move') await dispatch(sid, { type: 'window.move', id, index: Number(arg ?? 0) });
      else if (sub === 'opacity') await dispatch(sid, { type: 'window.opacity', id, value: arg === undefined || arg === 'reset' ? null : Number(arg) });
      else if (sub === 'rename') await dispatch(sid, { type: 'instance.rename', id, title: String(arg ?? id) });
      // Dock at an edge or corner (the older "pin"/"unpin" and "tuck"/"untuck" still work).
      else if (sub === 'dock' || sub === 'pin' || sub === 'tuck') await dispatch(sid, { type: 'window.tuck', id, edge: String(arg ?? 'right') as any });
      else if (sub === 'undock' || sub === 'unpin' || sub === 'untuck') await dispatch(sid, { type: 'window.untuck', id });
      else if (sub === 'delete') await dispatch(sid, { type: 'instance.delete', id });
      else throw new Error(`unknown window command "${sub}"`);
      out({ ok: true }, 'ok');
      return;
    }
    case 'layout': {
      const sid = sessionId(flags);
      const [desk, layout] = rest;
      if (!desk || !layout) throw new Error('usage: claude-glass layout <desktop#> <full|split|main-left|main-left-nest|columns|grid>');
      await dispatch(sid, { type: 'desktop.layout', desktop: Number(desk) - 1, layout: layout as any });
      out({ ok: true }, 'ok');
      return;
    }
    case 'apps': {
      const [sub, type] = rest;
      const dir = appsDir();
      if (sub === 'new' || sub === 'copy') {
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
      const reports: any[] = await call(sessionId(flags), { op: 'apps' }).catch(() => []);
      const rows = cat
        ? cat.map((a) => `${a.source === 'user' ? 'custom ' : 'builtin'}  ${a.type.padEnd(14)} ${a.title}${a.permissions ? `  [can use: ${[a.permissions.twoWay && 'answering Claude (two-way)', ...a.permissions.network, a.permissions.microphone && 'microphone', a.permissions.storage && 'storage', a.permissions.sharedSignIn && 'shared sign-in'].filter(Boolean).join(', ')}]` : ''}`)
        : ['(glass not open: showing folders only)', ...(existsSync(dir) ? readdirSync(dir).map((d) => `custom   ${d}`) : [])];
      for (const r of reports) if (!r.ok) rows.push(`FAILED   ${r.type.padEnd(14)} ${r.error}  (${r.dir})`);
      out({ apps: cat, mods: reports }, [...rows, '', `Custom apps folder: ${dir}`].join('\n'));
      return;
    }
    case 'background': {
      // Claude's signal: recolor this glass's wallpaper light. Only this session; `reset` clears it.
      const sid = sessionId(flags);
      const [sub] = rest;
      if (sub === 'reset') await dispatch(sid, { type: 'settings.set', key: 'backgroundColors', value: [] });
      else if (typeof flags.colors === 'string') await dispatch(sid, { type: 'settings.set', key: 'backgroundColors', value: flags.colors });
      else if (sub !== undefined || flags.colors !== undefined) throw new Error('usage: claude-glass background [--colors "#c0392b,#e67e22" | reset]');
      const st = await call(sid, { op: 'state' });
      const now: string[] | undefined = st.settings?.backgroundColors;
      out({ colors: now ?? null }, now ? `Background light: ${now.join(', ')} (this session)` : "Background light: the user's own");
      return;
    }
    case 'signal': {
      // The signal layer: point at a window, flag one that broke, or show progress through the wallpaper light.
      const sid = sessionId(flags);
      const [kind, arg] = rest;
      const usage = 'usage: claude-glass signal spotlight <window> | alert <window> | progress <0..1> [--label L] | clear';
      if (kind === 'spotlight' || kind === 'alert') {
        if (!arg) throw new Error(usage);
        await dispatch(sid, { type: 'signal', kind, target: arg });
      } else if (kind === 'progress') {
        if (arg === undefined || !Number.isFinite(Number(arg))) throw new Error(usage);
        await dispatch(sid, { type: 'signal', kind, value: Number(arg), label: typeof flags.label === 'string' ? flags.label : undefined });
      } else if (kind === 'clear') await dispatch(sid, { type: 'signal', kind: 'clear' });
      else throw new Error(usage);
      out({ ok: true }, 'ok');
      return;
    }
    case 'action': {
      // The glass mod's approvals (not for Claude): ask through the glass, wait for the answer,
      // or say it was settled elsewhere. Every reply is one JSON line. Answers themselves only
      // come from the glass's own window.
      const [sub, id] = rest;
      const cid = claudeSessionId(flags);
      const sock = socketPath(cid);
      const say = (v: unknown) => console.log(JSON.stringify(v));
      if (!existsSync(sock)) { say(sub === 'wait' ? { status: 'gone' } : { off: 'no glass' }); return; }
      if (sub === 'request') {
        let req: unknown = {};
        try { req = JSON.parse(readStdin() || '{}'); } catch {}
        const r = await request(sock, { op: 'action.request', request: req }, 3000).catch(() => null);
        say(r?.ok ? r.result : { off: r?.error ?? 'the glass did not answer' });
      } else if (sub === 'wait' && id) {
        const ms = Math.max(0, Math.min(30_000, Number(flags.ms ?? 1000)));
        const r = await request(sock, { op: 'action.wait', id, ms }, ms + 3000).catch(() => null);
        say(r?.ok ? r.result : { status: 'gone' });
      } else if (sub === 'close' && id) {
        // A question answered in the terminal: its answers as JSON on stdin (so the card can show them).
        let answers: unknown;
        if (flags.answers === true) try { answers = JSON.parse(readStdin() || 'null'); } catch {}
        await request(sock, { op: 'action.close', id, by: flags.by, choice: flags.choice, ...(answers ? { answers } : {}) }, 3000).catch(() => {});
        say({ ok: true });
      } else throw new Error('usage: claude-glass action request | wait <id> [--ms N] | close <id> [--by terminal|timeout|interrupted] [--choice C]');
      return;
    }
    case 'ask': {
      // The glass mod's tool: Claude asks the user through the glass. The question and options as
      // JSON on stdin; prints { answer } once the user answers on the Action card, or { error }.
      const sock = socketPath(claudeSessionId(flags));
      if (!existsSync(sock)) { console.log(JSON.stringify({ error: 'Claude Glass is not open for this session' })); return; }
      let q: any = {};
      try { q = JSON.parse(readStdin() || '{}'); } catch {}
      const r: Reply = await request(sock, { op: 'ask', question: q.question, options: q.options }, 10 * 60_000).catch((e) => ({ ok: false, error: e.message }));
      console.log(JSON.stringify(r.ok ? r.result : { error: r.error }));
      return;
    }
    case 'watch': {
      // The glass mod's wait for controls (the Stop button): blocks on the socket until there's
      // one or --ms passes, then prints them as a JSON array. No glass: [] at once.
      const sock = socketPath(claudeSessionId(flags));
      const ms = Math.max(0, Math.min(30_000, Number(flags.ms ?? 20_000)));
      if (!existsSync(sock)) { console.log('[]'); return; }
      const r = await request(sock, { op: 'watch', ms }, ms + 3000).catch(() => null);
      console.log(JSON.stringify(r?.ok && Array.isArray(r.result) ? r.result : []));
      return;
    }
    case 'stored': {
      // Apps' persistent values: look at them, set one, or reset them.
      const [type, sub, key, value] = rest;
      const usage = 'usage: claude-glass stored <app type> [set <key> <json> | reset [key]]';
      if (!type) throw new Error(usage);
      const sid = sessionId(flags);
      if (sub === 'set') {
        if (!key || value === undefined) throw new Error(usage);
        let v: unknown;
        try { v = JSON.parse(value); } catch { v = value; } // a bare word is a string
        await dispatch(sid, { type: 'stored.set', app: type, values: { [key]: v } });
      } else if (sub === 'reset') {
        await dispatch(sid, { type: 'stored.reset', app: type, ...(key ? { keys: [key] } : {}) });
      } else if (sub) throw new Error(usage);
      const r = await call(sid, { op: 'stored', app: type });
      out(r, Object.entries(r.values as Record<string, unknown>).map(([k, v]) => `  ${k.padEnd(18)} ${String(r.scopes[k]).padEnd(8)} ${JSON.stringify(v)}`).join('\n') || '  (none)');
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
        const c = loadConfig() as unknown as Record<string, unknown>;
        const rows = Object.entries(SETTINGS_HELP).map(([k, help]) => `  ${k.padEnd(18)} ${JSON.stringify(c[k]).padEnd(12)} ${help}`);
        // Apps' own settings, from the live glass (it knows which apps loaded).
        const cat: any[] = await call(sessionId(flags), { op: 'catalog' }).catch(() => []);
        const appRows = cat.flatMap((a) => Object.entries(a.settings ?? {}).map(([k, s]: [string, any]) =>
          `  ${`app.${a.type}.${k}`.padEnd(26)} ${JSON.stringify(s.value).padEnd(8)} ${s.label}${s.type === 'enum' ? ` (${s.options.join('|')})` : s.type === 'number' && s.min != null ? ` (${s.min}..${s.max ?? ''})` : ''}`));
        out({ global: c, apps: Object.fromEntries(cat.filter((a) => a.settings).map((a) => [a.type, a.settings])) }, ['Global settings (claude-glass settings set <key> <value>):', ...rows,
          ...(appRows.length ? ['', 'App settings:', ...appRows] : []),
          '', 'This session: settings set session.windowMode live|history, session.historyLimit <n> (history windows kept; default 12), session.autoOpen.<changes|plan|images|web> true|false, session.windowOpacity <0.2..1>'].join('\n'));
      }
      return;
    }
    case 'event': {
      // Session events from the glass mod: one JSON object per line on stdin, in order.
      // Off means off: no glass for the session, nothing to do.
      const cid = claudeSessionId(flags);
      if (!existsSync(socketPath(cid))) return;
      const events = readStdin().split('\n').filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const r = events.length ? await request(socketPath(cid), { op: 'event', events }, 2000).catch(() => null) : null;
      // Which events the mod should forward to the glass's apps (`claude-glass hook`).
      if (r?.ok) console.log(JSON.stringify(r.result));
      return;
    }
    case 'hook': {
      // The glass mod forwards a session event to two-way apps' hooks: the event on stdin, the
      // outcome printed as JSON: { e } (pass it on, maybe changed) or { answer }. No glass, or a
      // glass that fails: { e } unchanged, so Claude Code goes on as if nothing were hooked.
      const [event] = rest;
      const cid = claudeSessionId(flags);
      let e: unknown = {};
      try { e = JSON.parse(readStdin() || '{}'); } catch {}
      const r = existsSync(socketPath(cid)) && event ? await request(socketPath(cid), { op: 'hook', event, e }, 10 * 60_000).catch(() => null) : null;
      console.log(JSON.stringify(r?.ok ? r.result : { e }));
      return;
    }
    case 'session-start': {
      // The glass mod, as a session starts (or /clear, resume, compact): bind the session to its
      // glass, open it if the user wants one per session, and tell the mod what it needs.
      const cid = claudeSessionId(flags);
      const source = typeof flags.source === 'string' ? flags.source : 'startup';
      const projectDir = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
      const config = loadConfig();
      markModLoaded(cid);
      await cleanupRuntime();
      const sid = bindSession(cid, projectDir, config.scope);
      let open = await isLive(socketPath(sid), 300);
      if (!open && config.autoStart && (source === 'startup' || source === 'resume')) {
        try { await launchGlass(sid, projectDir); open = true; } catch { open = false; }
      }
      let guide: string | null = null;
      if (open) {
        // A reload of the mod (hot reload while developing it) is no new session.
        if (source !== 'reload') await request(socketPath(sid), { op: 'event', events: [{ e: 'session.start', source, sessionId: cid, cwd: projectDir }] }, 1000).catch(() => {});
        guide = await request(socketPath(sid), { op: 'guide' }, 1000).then((r) => (r.ok ? String(r.result) : null)).catch(() => null) ?? guideFor(config);
      }
      const hooks = open ? await request(socketPath(sid), { op: 'event', events: [] }, 1000).then((r) => (r.ok ? (r.result as { hooks?: unknown }).hooks : {})).catch(() => ({})) : {};
      console.log(JSON.stringify({ open, guide, socket: socketPath(cid), toolReminders: config.toolReminders !== false, config: configPath(), hooks }));
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
