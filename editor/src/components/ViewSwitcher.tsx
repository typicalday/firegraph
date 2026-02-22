import type { ViewMeta } from '../types';

interface Props {
  views: ViewMeta[];
  activeView: string; // 'json' | tagName
  onSwitch: (view: string) => void;
}

export default function ViewSwitcher({ views, activeView, onSwitch }: Props) {
  if (views.length === 0) return null;

  const btnBase = 'px-2 py-1 rounded text-xs transition-colors';
  const btnActive = 'bg-indigo-600/30 text-indigo-300 border border-indigo-500/50';
  const btnInactive = 'bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700';

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onSwitch('json')}
        className={`${btnBase} ${activeView === 'json' ? btnActive : btnInactive}`}
      >
        JSON
      </button>
      {views.map((view) => (
        <button
          key={view.tagName}
          onClick={() => onSwitch(view.tagName)}
          title={view.description}
          className={`${btnBase} ${activeView === view.tagName ? btnActive : btnInactive}`}
        >
          {view.viewName}
        </button>
      ))}
    </div>
  );
}
