import type { AppViewProps } from '../../sdk/react';
import type { TasksState } from './index';

export default function TasksView({ state }: AppViewProps<TasksState>) {
  const items = state.items;
  if (!items.length) return <div className="tk-empty">Claude's to-do list shows up here when it makes one.</div>;
  const done = items.filter((t) => t.status === 'completed').length;
  const current = items.find((t) => t.status === 'in_progress');
  return (
    <div className="tasks">
      <header className="tk-head">
        <div className="tk-count"><b>{done}</b> of {items.length} done</div>
        <div className="tk-bar"><i style={{ width: `${(done / items.length) * 100}%` }} /></div>
        {current && <div className="tk-now"><span className="tk-spin" />{current.activeForm ?? current.subject}</div>}
      </header>
      <ol className="tk-list">
        {items.map((t) => (
          <li key={t.id} className={`tk-item ${t.status}`} title={t.description}>
            <span className="tk-mark" aria-label={t.status}>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '' : ''}</span>
            <span className="tk-text">
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
              {t.description && t.description !== t.subject && <small>{t.description}</small>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
