import { Link } from 'react-router-dom';

import { encodeFsPath } from '../utils';
import { usePathMaybe } from './path-context';

export default function ScopeBreadcrumb() {
  const pathCtx = usePathMaybe();

  if (!pathCtx || !pathCtx.isScoped) return null;

  const { scopeSegments, firestorePath } = pathCtx;

  // Build a URL for a specific depth in the scope hierarchy.
  // firestorePath = "ive/uid1/mem/uid2/ctx" → at depth 0 we want "ive/uid1/mem", etc.
  // The graph collection is the first segment(s) before any scope pairs.
  // We can reconstruct by taking the firestorePath up to the desired depth.
  const fsSegments = firestorePath.split('/');
  // The graph collection is the first segment. Scope pairs start at index 1.
  const graphCollection = fsSegments[0];

  return (
    <nav className="flex items-center px-4 py-2 bg-indigo-950/40 border-b border-indigo-500/20 text-xs gap-1 flex-wrap">
      <svg
        className="w-3.5 h-3.5 text-indigo-400 mr-1 shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4"
        />
      </svg>
      <Link
        to={`/${encodeFsPath(graphCollection)}`}
        className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
      >
        {graphCollection}
      </Link>
      {scopeSegments.map((seg, i) => {
        // Build path up to this parent node (all segments including graphCollection + pairs up to i)
        const parentParts = [graphCollection];
        for (let j = 0; j < i; j++) {
          parentParts.push(scopeSegments[j].parentUid, scopeSegments[j].subgraphName);
        }
        const parentFsPath = parentParts.join('/');

        // Build path up to this subgraph (including the current pair)
        const subgraphParts = [...parentParts, seg.parentUid, seg.subgraphName];
        const subgraphFsPath = subgraphParts.join('/');

        return (
          <span key={i} className="flex items-center gap-1">
            <span className="text-slate-600">/</span>
            <Link
              to={`/${encodeFsPath(parentFsPath)}/node/${encodeURIComponent(seg.parentUid)}`}
              className="text-slate-400 hover:text-slate-200 font-mono transition-colors"
              title={seg.parentUid}
            >
              {seg.parentUid.length > 10 ? `${seg.parentUid.slice(0, 8)}\u2026` : seg.parentUid}
            </Link>
            <span className="text-slate-600">/</span>
            <Link
              to={`/${encodeFsPath(subgraphFsPath)}`}
              className="text-indigo-400 hover:text-indigo-300 font-medium transition-colors"
            >
              {seg.subgraphName}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}
