import { Link } from 'react-router-dom';
import type { CollectionDef } from '../types';
import { collectionBrowseUrl } from '../utils';
import { useScope } from './scope-context';

interface Props {
  collectionDef: CollectionDef;
  /** Resolved path param values. */
  params: Record<string, string>;
  /** When provided (document detail), rendered as the final non-clickable segment. */
  docId?: string;
}

/**
 * Parses a collection path template like "graph/{tourUid}/logs" and renders
 * each segment as either plain text or a clickable link:
 *   - Static segments at the end (last segment before docId) → link to collection browse
 *   - Parameter segments with resolved values → link to /f/node/{value}
 *   - Unresolved parameters → displayed as {paramName} in muted text
 */
export default function CollectionBreadcrumb({ collectionDef, params, docId }: Props) {
  const { scopedPath } = useScope();

  // Strip the /f prefix so scopedPath can prepend the correct scope
  const rawBrowseUrl = collectionBrowseUrl(collectionDef.name, params, collectionDef.pathParams);
  const browseRelPath = rawBrowseUrl.replace(/^\/f/, ''); // → '/col/name/...'
  const scopedBrowseUrl = scopedPath(browseRelPath);

  const segments = collectionDef.path.split('/').filter(Boolean);

  return (
    <nav className="flex items-center gap-0.5 text-xs flex-wrap">
      {/* Firestore path icon */}
      <svg className="w-3.5 h-3.5 text-amber-500/70 shrink-0 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
      </svg>

      {segments.map((seg, i) => {
        const isLastSeg = i === segments.length - 1;
        const paramMatch = seg.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
        const separator = i > 0 ? <span className="text-slate-700 mx-0.5">/</span> : null;

        if (paramMatch) {
          // Parameter segment — link to the node if value is resolved
          const paramName = paramMatch[1];
          const value = params[paramName];
          return (
            <span key={i} className="flex items-center">
              {separator}
              {value ? (
                <Link
                  to={scopedPath(`/node/${encodeURIComponent(value)}`)}
                  className="text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
                  title={`${paramName}: ${value}`}
                >
                  {value.length > 16 ? `${value.slice(0, 14)}\u2026` : value}
                </Link>
              ) : (
                <span className="text-slate-600 font-mono">{`{${paramName}}`}</span>
              )}
            </span>
          );
        }

        // Static segment — last segment links to collection browse only from doc detail page
        if (isLastSeg && docId) {
          return (
            <span key={i} className="flex items-center">
              {separator}
              <Link to={scopedBrowseUrl} className="text-amber-400 hover:text-amber-300 font-medium transition-colors">
                {seg}
              </Link>
            </span>
          );
        }

        return (
          <span key={i} className="flex items-center">
            {separator}
            <span className="text-slate-500">{seg}</span>
          </span>
        );
      })}

      {/* Document ID as the final non-clickable segment */}
      {docId && (
        <span className="flex items-center">
          <span className="text-slate-700 mx-0.5">/</span>
          <span className="text-slate-300 font-mono" title={docId}>
            {docId.length > 16 ? `${docId.slice(0, 14)}\u2026` : docId}
          </span>
        </span>
      )}
    </nav>
  );
}
