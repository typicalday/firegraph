import { Link } from 'react-router-dom';

import type { AppConfig, Schema } from '../types';
import { encodeFsPath } from '../utils';

interface Props {
  schema: Schema;
  config: AppConfig;
}

/**
 * Registry-driven root page shown at `/`.
 * Lists the graph collection (if configured) and any top-level collections
 * discovered from the entity registry.
 */
export default function RootPage({ schema, config }: Props) {
  const graphCollection = config.collection;
  const collections = schema.collections ?? [];

  // Top-level collections are those whose path has no `/` (not nested under a graph node)
  const topLevelCollections = collections.filter((c) => !c.path.includes('/'));

  const hasAnything = !!graphCollection || topLevelCollections.length > 0;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-300">Firegraph</h1>
        <p className="text-sm text-slate-400 mt-1">{config.projectId}</p>
      </div>

      {!hasAnything && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <p className="text-sm text-slate-400">No graph collection or collections configured.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Graph collection */}
        {graphCollection && (
          <Link
            to={`/${encodeFsPath(graphCollection)}`}
            className="block px-5 py-4 bg-slate-900 border border-slate-800 rounded-xl hover:border-indigo-500/40 transition-colors group"
          >
            <div className="flex items-center gap-2 mb-1">
              <svg
                className="w-4 h-4 text-indigo-400 shrink-0"
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
              <span className="text-sm font-semibold text-slate-200 group-hover:text-indigo-300 transition-colors">
                {graphCollection}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              Graph &middot; {schema.nodeTypes.length} node type
              {schema.nodeTypes.length !== 1 ? 's' : ''}, {schema.edgeTypes.length} edge type
              {schema.edgeTypes.length !== 1 ? 's' : ''}
            </p>
          </Link>
        )}

        {/* Top-level collections */}
        {topLevelCollections.map((col) => (
          <Link
            key={col.name}
            to={`/${encodeFsPath(col.path)}`}
            className="block px-5 py-4 bg-slate-900 border border-slate-800 rounded-xl hover:border-amber-500/30 transition-colors group"
          >
            <div className="flex items-center gap-2 mb-1">
              <svg
                className="w-4 h-4 text-amber-400/70 shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
              <span className="text-sm font-semibold text-slate-200 group-hover:text-amber-300 transition-colors">
                {col.name}
              </span>
            </div>
            {col.description && <p className="text-xs text-slate-500">{col.description}</p>}
          </Link>
        ))}
      </div>
    </div>
  );
}
