import { useState } from 'react';
import { LAYOUT_NAMES, LAYOUTS } from '../../core/layout';
import { BACKGROUNDS, PRESETS } from '../../renderer/backgrounds';
import { AppIcon } from '../../renderer/AppIcon';
import { apps, dispatch, mods, setConfig } from '../../renderer/store';
import type { ViewProps } from '../../renderer/viewTypes';

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
  const preset = (PRESETS[config.background] ?? PRESETS.aurora).blobs.map((b) => b.color);
  const shown = Array.from({ length: 4 }, (_, i) => own.length ? own[i % own.length] : preset[i % preset.length]);
  return (
    <label className="s-row">
      <span>Light colors{own.length ? '' : ' (preset)'}</span>
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
        <span>Window opacity {s.windowOpacity != null ? `(${Math.round(s.windowOpacity * 100)}%)` : '(global)'}</span>
        <span className="s-inline">
          <input type="range" min={0.2} max={1} step={0.02} value={s.windowOpacity ?? config.windowOpacity}
            onChange={(e) => setSession('windowOpacity', Number(e.target.value))} />
          {s.windowOpacity != null && <button className="s-link" onClick={() => setSession('windowOpacity', undefined)}>Use global</button>}
        </span>
      </label>
      {s.backgroundColors && (
        <label className="s-row">
          <span>Background light set by Claude</span>
          <span className="s-inline">
            {s.backgroundColors.map((c, i) => <i key={i} className="s-dot" style={{ background: c }} />)}
            <button className="s-link" onClick={() => setSession('backgroundColors', [])}>Clear</button>
          </span>
        </label>
      )}

      <h3>All sessions</h3>

      <h4>Sessions</h4>
      <Toggle label="Open Claude Glass when a Claude session starts" on={config.autoStart} onChange={(v) => setConfig('autoStart', v)} />
      <label className="s-row">
        <span>One glass per (applies to new sessions)</span>
        <select value={config.scope} onChange={(e) => setConfig('scope', e.target.value)}>
          <option value="session">Session</option>
          <option value="folder">Project folder</option>
        </select>
      </label>

      <h4>Windows &amp; layout</h4>
      <Toggle label="Nested view: newest window big, older ones spiral smaller (scroll to walk back)" on={config.nestedView} onChange={(v) => setConfig('nestedView', v)} />
      <label className="s-row">
        <span>Layout for new desktops</span>
        <select value={config.defaultLayout} disabled={config.nestedView} onChange={(e) => setConfig('defaultLayout', e.target.value)}>
          <option value="claude">Claude decides</option>
          {LAYOUT_NAMES.map((l) => <option key={l} value={l}>{LAYOUTS[l].label}</option>)}
        </select>
      </label>
      <Toggle label="Scroll outside windows to switch desktops" on={config.wheelDesktops} onChange={(v) => setConfig('wheelDesktops', v)} />

      <h4>Look</h4>
      <label className="s-row">
        <span>Window opacity ({Math.round(config.windowOpacity * 100)}%)</span>
        <input type="range" min={0.2} max={1} step={0.02} value={config.windowOpacity} onChange={(e) => setConfig('windowOpacity', Number(e.target.value))} />
      </label>
      <div className="s-row s-col">
        <span>Background</span>
        <div className="swatches">
          {Object.entries(BACKGROUNDS).map(([name, css]) => (
            <button key={name} title={name} className={config.background === name ? 'on' : ''} style={{ backgroundImage: css }} onClick={() => setConfig('background', name)} aria-label={`${name} background`} />
          ))}
        </div>
        <form className="s-inline" onSubmit={(e) => { e.preventDefault(); if (bgPath.startsWith('/')) setConfig('background', bgPath); }}>
          <input type="text" placeholder="/absolute/path/to/image.jpg" value={bgPath} onChange={(e) => setBgPath(e.target.value)} />
          <button type="submit" className="s-btn">Use image</button>
        </form>
      </div>
      <LightColors config={config} />
      <Toggle label="Drift the background light" on={config.animateBackground} onChange={(v) => setConfig('animateBackground', v)} />
      <Toggle label="Glow the edges while Claude is waiting on you" on={config.waitingGlow} onChange={(v) => setConfig('waitingGlow', v)} />

      <h4>Dock</h4>
      <Toggle label="Auto-hide the dock (shows at the bottom edge)" on={config.dockAutoHide} onChange={(v) => setConfig('dockAutoHide', v)} />
      <label className="s-row">
        <span>Dock order</span>
        <select value={config.dockOrder} onChange={(e) => setConfig('dockOrder', e.target.value)}>
          <option value="windows">Match window order</option>
          <option value="fixed">Fixed by app type</option>
        </select>
      </label>

      <h3>Apps</h3>
      <p className="s-note">Turned-off apps are hidden and Claude can't use them. Custom apps live in <code>~/.claude/claude-glass/apps</code> (<code>claude-glass apps new &lt;name&gt;</code>).</p>
      {Object.values(apps).filter((a) => a.type !== 'settings').map((a) => {
        const mod = mods.find((m) => m.ok && m.type === a.type);
        const on = !config.disabledApps.includes(a.type);
        return (
          <Toggle key={a.type} on={on}
            onChange={(v) => setConfig('disabledApps', v ? config.disabledApps.filter((t) => t !== a.type) : [...config.disabledApps, a.type])}
            label={<span className="s-app"><b><AppIcon type={a.type} /></b> {a.title} <code>{a.type}</code>{mod ? (mod.overrides ? ' · custom, replaces the built-in' : ' · custom') : ''}
              {permissionText(a.permissions) && <span className="s-perms">Can use: {permissionText(a.permissions)}
                {(a.permissions.storage || a.permissions.network.length > 0) && <ResetData type={a.type} />}</span>}</span>} />
        );
      })}
      {mods.filter((m) => !m.ok).map((m) => (
        <div key={m.dir} className="s-row s-app s-app-bad" title={m.dir}>
          <span>▢ <code>{m.type}</code></span>
          <span className="s-app-status">{m.error}</span>
        </div>
      ))}
      <p className="s-note">New or changed custom apps load when the glass restarts.</p>
      <p className="s-foot">Session {glass.session.id}</p>
    </div>
  );
}

function permissionText(p: { network: string[]; microphone: boolean; storage: boolean }): string {
  return [p.network.length ? `network (${p.network.map((o) => o.replace(/^\w+:\/\//, '')).join(', ')})` : '', p.microphone ? 'microphone' : '', p.storage ? 'storage' : '']
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
