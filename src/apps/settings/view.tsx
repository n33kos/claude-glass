import { Fragment, useEffect, useState } from 'react';
import { settingValues, type SettingSpec, type StoredSpec } from '../types';
import { LAYOUT_NAMES, LAYOUTS } from '../../core/layout';
import { DEFAULT_PALETTES, MOODS, type Mood } from '../../core/colors';
import { BACKGROUNDS, PRESETS } from '../../renderer/backgrounds';
import { AppIcon } from '../../renderer/AppIcon';
import { appReports, apps, dispatch, setConfig } from '../../renderer/store';
import type { ViewProps } from '../../renderer/viewTypes';
import { FOLLOW_MODES, type FollowMode } from '../../core/types';

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: React.ReactNode }) {
  return (
    <label className="s-row">
      <span>{label}</span>
      <button role="switch" aria-checked={on} className={`switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}><i /></button>
    </label>
  );
}

/** The user's own wallpaper light: four pickers over the preset's colors; empty = the preset's. */
function LightColors({ config }: { config: ViewProps['config'] }) {
  const own = config.backgroundColors ?? [];
  const preset = (PRESETS[config.background] ?? PRESETS.graphite).blobs.map((b) => b.color);
  const shown = Array.from({ length: 4 }, (_, i) => own.length ? own[i % own.length] : preset[i % preset.length]);
  return (
    <label className="s-row">
      <span>Wallpaper light{own.length ? '' : ' (the wallpaper\'s own)'}</span>
      <span className="s-inline">
        {shown.map((c, i) => (
          <input key={i} type="color" className="s-color" value={c} aria-label={`Light color ${i + 1}`}
            onChange={(e) => setConfig('backgroundColors', shown.map((x, j) => (j === i ? e.target.value : x)))} />
        ))}
        {own.length > 0 && <button className="s-link" onClick={() => setConfig('backgroundColors', [])}>Use preset</button>}
      </span>
    </label>
  );
}

/** An app's persistent values: how many it keeps (by scope), and a way to forget them. */
function StoredRow({ type, specs, values }: { type: string; specs: Record<string, StoredSpec>; values?: Record<string, unknown> }) {
  const kept = Object.keys(values ?? {}).filter((k) => k in specs);
  const scopes = [...new Set(Object.values(specs).map((s) => s.scope))].join(', ');
  return (
    <div className="s-row s-sub">
      <span className="s-dim">Saved data ({scopes}): {kept.length ? `${kept.length} value${kept.length === 1 ? '' : 's'}` : 'none yet'}</span>
      {kept.length > 0 && <button className="s-link" onClick={() => void dispatch({ type: 'stored.reset', app: type })}>Reset</button>}
    </div>
  );
}

const FOLLOW_LABELS: Record<FollowMode, string> = {
  off: 'Nothing', light: 'Light it', front: 'Bring it to the front', both: 'Front and light it', focus: 'Front, light it, show desktop 1',
};

function FollowSelect({ label, setting, config }: { label: string; setting: FollowSetting; config: ViewProps['config'] }) {
  return (
    <label className="s-row">
      <span>{label}</span>
      <select value={config[setting] ?? 'off'} onChange={(e) => setConfig(setting, e.target.value)}>
        {FOLLOW_MODES.map((m) => <option key={m} value={m}>{FOLLOW_LABELS[m]}</option>)}
      </select>
    </label>
  );
}
type FollowSetting = 'followEdits' | 'followPlans' | 'followTests' | 'followWeb' | 'followImages' | 'followAgents';

const MOOD_LABELS: Record<Mood, string> = { working: 'While Claude works', waiting: 'Waiting on you', idle: 'Done, your turn', ended: 'Session ended' };

/** The light follows the session: a toggle, then per state its colors, or "your colors". */
function StateColors({ config }: { config: ViewProps['config'] }) {
  const on = config.stateColors !== false;
  const palettes = config.statePalettes ?? DEFAULT_PALETTES;
  const setMood = (m: Mood, colors: string[]) => setConfig('statePalettes', { ...palettes, [m]: colors });
  return (
    <>
      <Toggle label="Also tint the whole wallpaper by what Claude is doing (the older style)" on={on} onChange={(v) => setConfig('stateColors', v)} />
      {on && MOODS.map((m) => {
        const p = palettes[m];
        return (
          <label key={m} className="s-row s-sub">
            <span>{MOOD_LABELS[m]}</span>
            <span className="s-inline">
              {p.length ? p.map((c, i) => (
                <input key={i} type="color" className="s-color" value={c} aria-label={`${MOOD_LABELS[m]} color ${i + 1}`}
                  onChange={(e) => setMood(m, p.map((x, j) => (j === i ? e.target.value : x)))} />
              )) : <span className="s-dim">your colors</span>}
              {p.length
                ? <button className="s-link" onClick={() => setMood(m, [])}>Use mine</button>
                : <button className="s-link" onClick={() => setMood(m, DEFAULT_PALETTES[m].length ? DEFAULT_PALETTES[m] : ['#3a7bd5', '#6c5ce7'])}>Tint</button>}
            </span>
          </label>
        );
      })}
    </>
  );
}

export function SettingsView({ glass, config }: ViewProps) {
  const [bgPath, setBgPath] = useState(config.background.startsWith('/') ? config.background : '');
  const s = glass.settings;
  const setSession = (key: string, value: unknown) => dispatch({ type: 'settings.set', key, value });
  return (
    <div className="settings">
      <h3>This session</h3>
      <label className="s-row">
        <span>New things Claude makes</span>
        <select value={s.windowMode ?? 'live'} onChange={(e) => setSession('windowMode', e.target.value)}>
          <option value="live">Update one window</option>
          <option value="history">New window for every action (history)</option>
        </select>
      </label>
      {s.windowMode === 'history' && (
        <label className="s-row">
          <span>History windows to keep</span>
          <select value={String(s.historyLimit ?? 12)} onChange={(e) => setSession('historyLimit', Number(e.target.value))}>
            {[4, 8, 12, 20, 40].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      <Toggle label="Open file changes automatically" on={s.autoOpen.changes} onChange={(v) => setSession('autoOpen.changes', v)} />
      <Toggle label="Open plans automatically" on={s.autoOpen.plan} onChange={(v) => setSession('autoOpen.plan', v)} />
      <Toggle label="Open images Claude reads" on={s.autoOpen.images} onChange={(v) => setSession('autoOpen.images', v)} />
      <Toggle label="Open the browser for web searches and pages" on={s.autoOpen.web !== false} onChange={(v) => setSession('autoOpen.web', v)} />
      <label className="s-row">
        <span>Window opacity for this session {s.windowOpacity != null ? `(${Math.round(s.windowOpacity * 100)}%)` : '(same as all sessions)'}</span>
        <span className="s-inline">
          <input type="range" min={0.2} max={1} step={0.02} value={s.windowOpacity ?? config.windowOpacity}
            onChange={(e) => setSession('windowOpacity', Number(e.target.value))} />
          {s.windowOpacity != null && <button className="s-link" onClick={() => setSession('windowOpacity', undefined)}>Reset</button>}
        </span>
      </label>
      {s.backgroundColors && (
        <label className="s-row">
          <span>Wallpaper tint Claude set for this session</span>
          <span className="s-inline">
            {s.backgroundColors.map((c, i) => <i key={i} className="s-dot" style={{ background: c }} />)}
            <button className="s-link" onClick={() => setSession('backgroundColors', [])}>Clear</button>
          </span>
        </label>
      )}

      <Presets />

      <h3>All sessions</h3>

      <h4>Appearance</h4>
      <label className="s-row">
        <span>Theme</span>
        <select value={config.theme ?? 'dark'} onChange={(e) => setConfig('theme', e.target.value)}>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="system">Match macOS</option>
        </select>
      </label>
      <label className="s-row">
        <span>Window opacity ({Math.round(config.windowOpacity * 100)}%)</span>
        <input type="range" min={0.2} max={1} step={0.02} value={config.windowOpacity} onChange={(e) => setConfig('windowOpacity', Number(e.target.value))} />
      </label>
      <div className="s-row s-col">
        <span>Wallpaper{(config.theme ?? 'dark') === 'light' ? ' (light theme uses a pale one)' : ''}</span>
        <div className="swatches">
          {Object.entries(BACKGROUNDS).sort(([a], [b]) => Number(b === 'graphite') - Number(a === 'graphite')).map(([name, css]) => (
            <button key={name} title={name} className={config.background === name ? 'on' : ''} style={{ backgroundImage: css }} onClick={() => setConfig('background', name)} aria-label={`${name} wallpaper`} />
          ))}
        </div>
        <form className="s-inline" onSubmit={(e) => { e.preventDefault(); if (bgPath.startsWith('/')) setConfig('background', bgPath); }}>
          <input type="text" placeholder="/absolute/path/to/image.jpg" value={bgPath} onChange={(e) => setBgPath(e.target.value)} />
          <button type="submit" className="s-btn">Use image</button>
        </form>
      </div>
      <LightColors config={config} />
      <Toggle label="Let the wallpaper light drift slowly" on={config.animateBackground} onChange={(v) => setConfig('animateBackground', v)} />

      <h4>Signals</h4>
      <p className="s-note">The chrome has no color, so the wallpaper light is where the glass points and reports: amber while Claude waits on you, blue behind a window it wants you to look at, red behind one that broke, green when a long turn is done, a hairline bar for long work. One at a time; each fades back.</p>
      <Toggle label="Signals" on={config.signals !== false} onChange={(v) => setConfig('signals', v)} />
      {config.signals !== false && (
        <div className="s-sub">
          <label className="s-row">
            <span>Strength</span>
            <select value={config.signalStrength ?? 'normal'} onChange={(e) => setConfig('signalStrength', e.target.value)}>
              <option value="subtle">Subtle</option>
              <option value="normal">Normal</option>
              <option value="strong">Strong</option>
            </select>
          </label>
          <Toggle label="Green bloom when a long turn is done" on={config.signalDone !== false} onChange={(v) => setConfig('signalDone', v)} />
          <Toggle label="Amber edge glow while Claude waits on you" on={config.waitingGlow} onChange={(v) => setConfig('waitingGlow', v)} />
          <div className="s-row">
            <span>Preview</span>
            <span className="s-inline">
              <button className="s-btn" onClick={() => dispatch({ type: 'signal', kind: 'spotlight', target: 'settings' })}>Look here</button>
              <button className="s-btn" onClick={() => window.dispatchEvent(new CustomEvent('glass:preview-signal', { detail: 'alert' }))}>Broke</button>
              <button className="s-btn" onClick={() => window.dispatchEvent(new CustomEvent('glass:preview-signal', { detail: 'done' }))}>Done</button>
              <button className="s-btn" onClick={() => { void dispatch({ type: 'signal', kind: 'progress', value: 0.6, label: 'Preview' }); setTimeout(() => void dispatch({ type: 'signal', kind: 'clear' }), 3500); }}>Progress</button>
            </span>
          </div>
          <StateColors config={config} />
        </div>
      )}

      <h4>Attention</h4>
      <p className="s-note">What the glass does on its own when something happens, so it doesn't depend on Claude remembering. Only windows on screen move; one you closed stays closed.</p>
      <FollowSelect label="An edit lands (Changes)" setting="followEdits" config={config} />
      <FollowSelect label="A plan is written (Plan)" setting="followPlans" config={config} />
      <FollowSelect label="A test run fails (Tests, lit red)" setting="followTests" config={config} />
      <FollowSelect label="A web search or page (Browser)" setting="followWeb" config={config} />
      <FollowSelect label="Claude reads an image (Images)" setting="followImages" config={config} />
      <FollowSelect label="A subagent starts (Agents)" setting="followAgents" config={config} />
      <Toggle label="Thin progress bar along the bottom while Claude works" on={config.turnProgress !== false} onChange={(v) => setConfig('turnProgress', v)} />
      <Toggle label="How full Claude's context is, in the top bar" on={config.contextGauge !== false} onChange={(v) => setConfig('contextGauge', v)} />

      <h4>Windows &amp; desktops</h4>
      <Toggle label="Nested view: one screen, the focused window largest and the others smaller around it" on={config.nestedView} onChange={(v) => setConfig('nestedView', v)} />
      {config.nestedView && (
        <label className="s-row s-sub">
          <span>Arrangement</span>
          <select value={config.nestedStyle ?? 'spiral'} onChange={(e) => setConfig('nestedStyle', e.target.value)}>
            <option value="spiral">Spiral: each older window half the size</option>
            <option value="carousel">Carousel: one in the middle, neighbors as tiles either side</option>
          </select>
        </label>
      )}
      {!config.nestedView && (
        <label className="s-row">
          <span>Layout for new desktops</span>
          <select value={config.defaultLayout} onChange={(e) => setConfig('defaultLayout', e.target.value)}>
            <option value="claude">Claude decides</option>
            {LAYOUT_NAMES.map((l) => <option key={l} value={l}>{LAYOUTS[l].label}</option>)}
          </select>
        </label>
      )}
      <Toggle label="Click a window to use it (scrolling over the others moves between desktops)" on={config.selectToInteract !== false} onChange={(v) => setConfig('selectToInteract', v)} />
      <Toggle label="Scroll outside windows to move between desktops" on={config.wheelDesktops} onChange={(v) => setConfig('wheelDesktops', v)} />

      <h4>Docks</h4>
      <p className="s-note">Drag a window onto a target at an edge or corner to dock it there.</p>
      <label className="s-row">
        <span>Open a hidden dock</span>
        <select value={config.dockOpen ?? 'click'} onChange={(e) => setConfig('dockOpen', e.target.value)}>
          <option value="click">When its tab is clicked</option>
          <option value="hover">When hovering its tab</option>
        </select>
      </label>

      <h4>Launcher</h4>
      <Toggle label="Auto-hide (shows at the bottom edge)" on={config.launcherAutoHide} onChange={(v) => setConfig('launcherAutoHide', v)} />
      <Toggle label="Group an app's windows under one icon" on={config.launcherGroup !== false} onChange={(v) => setConfig('launcherGroup', v)} />
      <label className="s-row">
        <span>Order</span>
        <select value={config.launcherOrder} onChange={(e) => setConfig('launcherOrder', e.target.value)}>
          <option value="windows">Match window order</option>
          <option value="fixed">Fixed by app</option>
        </select>
      </label>

      <h4>Claude</h4>
      <Toggle label="Open Claude Glass when a Claude session starts" on={config.autoStart} onChange={(v) => setConfig('autoStart', v)} />
      <label className="s-row">
        <span>One glass per (applies to new sessions)</span>
        <select value={config.scope} onChange={(e) => setConfig('scope', e.target.value)}>
          <option value="session">Session</option>
          <option value="folder">Project folder</option>
        </select>
      </label>
      <Toggle label="Remind Claude to read and edit with its own tools (so you see the work here)" on={config.toolReminders} onChange={(v) => setConfig('toolReminders', v)} />

      <h3>Apps</h3>
      <p className="s-note">Turned-off apps are hidden and Claude can't use them. Custom apps live in <code>~/.claude/claude-glass/apps</code> (<code>claude-glass apps new &lt;name&gt;</code>).</p>
      {Object.values(apps).filter((a) => a.type !== 'settings').map((a) => {
        const custom = appReports.find((r) => r.ok && r.type === a.type);
        const on = !config.disabledApps.includes(a.type);
        return (
          <Fragment key={a.type}>
            <Toggle on={on}
              onChange={(v) => setConfig('disabledApps', v ? config.disabledApps.filter((t) => t !== a.type) : [...config.disabledApps, a.type])}
              label={<span className="s-app"><b><AppIcon type={a.type} /></b> {a.title} <code>{a.type}</code>{custom ? (custom.overrides ? ' · custom, replaces the built-in' : ' · custom') : ''}
                {permissionText(a.permissions) && <span className="s-perms">Can use: {permissionText(a.permissions)}
                  {(a.permissions.storage || a.permissions.network.length > 0) && <ResetData type={a.type} />}</span>}</span>} />
            {on && a.settings && <AppSettings type={a.type} specs={a.settings} stored={config.appSettings?.[a.type]} />}
            {on && a.stored && <StoredRow type={a.type} specs={a.stored} values={glass.stored?.[a.type]} />}
          </Fragment>
        );
      })}
      {appReports.filter((r) => !r.ok).map((r) => (
        <div key={r.dir} className="s-row s-app s-app-bad" title={r.dir}>
          <span>▢ <code>{r.type}</code></span>
          <span className="s-app-status">{r.error}</span>
        </div>
      ))}
      <p className="s-note">New or changed custom apps load when the glass restarts.</p>
      <p className="s-foot">Session {glass.session.id}</p>
    </div>
  );
}

/**
 * Presets: saved frames (sidebars, layouts, this glass's settings, the look). Apply one here, save
 * the current glass as one, and pick the one every new glass starts with.
 */
function Presets() {
  const [list, setList] = useState<{ presets: { name: string; description: string; sidebars?: Record<string, { windows: { id: string }[] }> }[]; default: string | null }>({ presets: [], default: null });
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [note, setNote] = useState('');
  const run = async (action: string, n?: string, d?: string) => {
    const r = await window.glass.preset(action, n, d);
    if (!r.ok) { setNote(r.error ?? 'failed'); return null; }
    const l = await window.glass.preset('list');
    if (l.ok) setList(l.result);
    return r.result;
  };
  useEffect(() => { void run('list'); }, []);
  return (
    <>
      <h4>Presets</h4>
      <p className="s-note">A preset is a saved frame: which apps sit in which docks (sizes, splits, kept open), the desktop layouts, this glass's settings and the look. Claude can apply them too (<code>claude-glass preset</code>).</p>
      {list.presets.map((p) => (
        <div key={p.name} className="s-row s-preset">
          <span>
            <b>{p.name}</b>{list.default === p.name && <span className="s-dim"> · default for new glasses</span>}
            {p.description && <span className="s-preset-desc">{p.description}</span>}
            {p.sidebars && Object.keys(p.sidebars).length > 0 && (
              <span className="s-preset-desc s-dim">{Object.entries(p.sidebars).map(([e, sb]) => `${e}: ${sb.windows.map((w) => w.id).join(' + ')}`).join(' · ')}</span>
            )}
          </span>
          <span className="s-inline">
            <button className="s-btn" onClick={() => run('apply', p.name).then((r) => r && setNote(`Applied "${p.name}"${r.skipped.length ? `; skipped ${r.skipped.join(', ')}` : ''}`))}>Apply</button>
            <button className="s-link" onClick={() => run('default', list.default === p.name ? 'none' : p.name)}>{list.default === p.name ? 'Unset default' : 'Make default'}</button>
            <button className="s-link" onClick={() => run('save', p.name).then((r) => r && setNote(`Updated "${p.name}" from this glass`))}>Update</button>
            <button className="s-link" onClick={() => run('delete', p.name)}>Delete</button>
          </span>
        </div>
      ))}
      <form className="s-row s-inline" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void run('save', name.trim(), desc.trim()).then((r) => { if (r) { setNote(`Saved "${name.trim()}"`); setName(''); setDesc(''); } }); }}>
        <input type="text" placeholder="Preset name" value={name} onChange={(e) => setName(e.target.value)} style={{ width: 160 }} />
        <input type="text" placeholder="What it's for (Claude reads this)" value={desc} onChange={(e) => setDesc(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" className="s-btn">Save this glass</button>
      </form>
      {note && <p className="s-note">{note}</p>}
    </>
  );
}

/** An app's own settings, rendered from its manifest; each change is `app.<type>.<key>`. */
function AppSettings({ type, specs, stored }: { type: string; specs: Record<string, SettingSpec>; stored?: Record<string, unknown> }) {
  const values = settingValues({ settings: specs }, stored);
  const set = (key: string, v: unknown) => setConfig(`app.${type}.${key}`, v);
  return (
    <>
      {Object.entries(specs).map(([key, s]) => {
        const v = values[key];
        const label = <span title={s.help}>{s.label}</span>;
        if (s.type === 'bool') return <div key={key} className="s-sub"><Toggle label={label} on={v === true} onChange={(x) => set(key, x)} /></div>;
        return (
          <label key={key} className="s-row s-sub">
            {label}
            {s.type === 'enum' ? (
              <select value={String(v)} onChange={(e) => set(key, e.target.value)}>{s.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
            ) : s.type === 'number' ? (
              <input type="number" className="s-num" value={Number(v)} min={s.min} max={s.max} onChange={(e) => e.target.value !== '' && set(key, Number(e.target.value))} />
            ) : s.type === 'color' ? (
              <input type="color" className="s-color" value={String(v)} onChange={(e) => set(key, e.target.value)} />
            ) : (
              <input type="text" defaultValue={String(v)} onBlur={(e) => set(key, e.target.value)} />
            )}
          </label>
        );
      })}
    </>
  );
}

function permissionText(p: { network: string[]; microphone: boolean; storage: boolean; sharedSignIn?: boolean; twoWay?: boolean }): string {
  return [p.twoWay ? 'answering Claude (two-way)' : '', p.network.length ? `network (${p.network.map((o) => o.replace(/^\w+:\/\//, '')).join(', ')})` : '', p.microphone ? 'microphone' : '', p.storage ? 'storage' : '', p.sharedSignIn ? 'shared sign-in' : '']
    .filter(Boolean).join(' · ');
}

/** Forget what an app (and pages it embeds) stored: logins, cookies, saved data. Reopen its window after. */
function ResetData({ type }: { type: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="s-link s-reset" onClick={(e) => { e.preventDefault(); void window.glass.resetAppData(type).then(() => setDone(true)); }}>
      {done ? 'Data reset: reload its window' : 'Reset data'}
    </button>
  );
}
