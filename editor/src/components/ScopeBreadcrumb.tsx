import { Link } from 'react-router-dom';
import { useScope, buildScopeUrlPrefix } from './scope-context';

export default function ScopeBreadcrumb() {
  const { segments, isScoped } = useScope();

  if (!isScoped) return null;

  return (
    <nav className="flex items-center px-4 py-2 bg-indigo-950/40 border-b border-indigo-500/20 text-xs gap-1 flex-wrap">
      <svg className="w-3.5 h-3.5 text-indigo-400 mr-1 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
      </svg>
      <Link
        to="/f"
        className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
      >
        graph
      </Link>
      {segments.map((seg, i) => (
        <span key={i} className="flex items-center gap-1">
          <span className="text-slate-600">/</span>
          <Link
            to={`${buildScopeUrlPrefix(segments.slice(0, i))}/node/${encodeURIComponent(seg.parentUid)}`}
            className="text-slate-400 hover:text-slate-200 font-mono transition-colors"
            title={seg.parentUid}
          >
            {seg.parentUid.length > 10 ? `${seg.parentUid.slice(0, 8)}\u2026` : seg.parentUid}
          </Link>
          <span className="text-slate-600">/</span>
          <Link
            to={buildScopeUrlPrefix(segments.slice(0, i + 1))}
            className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
          >
            {seg.subgraphName}
          </Link>
        </span>
      ))}
    </nav>
  );
}
