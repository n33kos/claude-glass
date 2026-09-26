import { useState } from 'react';
import { LAYOUT_NAMES, LAYOUTS } from '../../core/layout';
import { BACKGROUNDS } from '../../renderer/backgrounds';
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

export function SettingsView({ glass, config }: ViewProps) {
  const [bgPath, setBgPath] = useState(config.background.startsWith('/') ? config.background : '');
  const s = glass.settings;
  const setSession = (key: string, value: unknown) => dispatch({ type: 'settings.set', key, value });
  return (
    <div className="settings">
      <h3>This session</h3>
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
      <label className="s-row">
        <span>New things Claude makes</span>
        <select value={config.windowMode} onChange={(e) => setConfig('windowMode', e.target.value)}>
          <option value="live">Update one window</option>
          <option value="history">New window for every action (history)</option>
        </select>
      </label>
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
            label={<span className="s-app"><b>{a.icon}</b> {a.title} <code>{a.type}</code>{mod ? (mod.overrides ? ' · custom, replaces the built-in' : ' · custom') : ''}</span>} />
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
