import type { ViewMeta } from '../types';

interface Props {
  views: ViewMeta[];
  activeView: string; // 'json' | tagName
  onSwitch: (view: string) => void;
}

export default function ViewSwitcher({ views, activeView, onSwitch }: Props) {
  if (views.length === 0) return null;

  return (
    <select
      value={activeView}
      onChange={(e) => onSwitch(e.target.value)}
      className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
    >
      <option value="json">JSON</option>
      {views.map((view) => (
        <option key={view.tagName} value={view.tagName}>
          {view.viewName}
        </option>
      ))}
    </select>
  );
}
