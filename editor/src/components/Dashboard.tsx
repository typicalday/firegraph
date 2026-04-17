import { Link } from 'react-router-dom';

import type { AppConfig, Schema } from '../types';
import { getTypeBadgeColor, getTypeColor } from '../utils';

interface Props {
  schema: Schema;
  config: AppConfig;
}

export default function Dashboard({ schema, config }: Props) {
  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1">Graph Overview</h1>
        <p className="text-sm text-slate-400">
          <span className="font-mono">{config.projectId}</span> /{' '}
          <span className="font-mono">{config.collection}</span>
        </p>
      </div>

      {/* Schema visualization */}
      <div className="grid grid-cols-2 gap-6">
        {/* Node Types */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
          <h2 className="text-sm font-semibold mb-4">Node Types</h2>
          <div className="space-y-2">
            {schema.nodeTypes.map((nt) => (
              <Link
                key={nt.type}
                to={`/browse/${encodeURIComponent(nt.type)}`}
                className="flex items-center gap-3 p-3 bg-slate-800/50 rounded-lg hover:bg-slate-800 transition-colors group"
              >
                <div className={`w-3 h-3 rounded-full ${getTypeColor(nt.type)}`} />
                <div>
                  <span className="text-sm font-medium group-hover:text-indigo-400 transition-colors">
                    {nt.type}
                  </span>
                  {nt.description && (
                    <p className="text-[10px] text-slate-500 mt-0.5">{nt.description}</p>
                  )}
                </div>
              </Link>
            ))}
            {schema.nodeTypes.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-4">No node types registered</p>
            )}
          </div>
        </div>

        {/* Relationships */}
        <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
          <h2 className="text-sm font-semibold mb-4">Relationships</h2>
          <div className="space-y-2">
            {schema.edgeTypes.map((et) => {
              const key = `${et.aType}:${et.axbType}:${et.bType}`;
              return (
                <div key={key} className="p-3 bg-slate-800/50 rounded-lg">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(et.aType)}`}
                    >
                      {et.aType}
                    </span>
                    <span className="text-indigo-400 text-xs">&mdash;{et.axbType}&rarr;</span>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(et.bType)}`}
                    >
                      {et.bType}
                    </span>
                  </div>
                  {et.description && (
                    <p className="text-[10px] text-slate-500 mt-1.5 ml-1">{et.description}</p>
                  )}
                </div>
              );
            })}
            {schema.edgeTypes.length === 0 && (
              <p className="text-sm text-slate-500 text-center py-4">No edge types registered</p>
            )}
          </div>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="mt-6 bg-slate-900 rounded-xl border border-slate-800 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Quick Actions</h2>
        </div>
        <div className="flex gap-3">
          <Link
            to="/traverse"
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600/20 text-indigo-400 rounded-lg text-sm hover:bg-indigo-600/30 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            Build Traversal
          </Link>
          {schema.nodeTypes.length > 0 && (
            <Link
              to={`/browse/${encodeURIComponent(schema.nodeTypes[0].type)}`}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 text-slate-300 rounded-lg text-sm hover:bg-slate-700 transition-colors"
            >
              Browse {schema.nodeTypes[0].type} nodes
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
