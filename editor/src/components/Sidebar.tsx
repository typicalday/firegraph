import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { Schema, AppConfig } from '../types';
import { getTypeColor } from '../utils';

interface Props {
  schema: Schema;
  config: AppConfig;
}

export default function Sidebar({ schema, config }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/node/${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery('');
    }
  };

  return (
    <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col h-full shrink-0">
      {/* Header */}
      <div className="p-4 border-b border-slate-800">
        <Link to="/" className="flex items-center gap-2 group">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center text-xs font-bold">
            FG
          </div>
          <span className="font-semibold text-sm group-hover:text-indigo-400 transition-colors">
            Firegraph Editor
          </span>
        </Link>
        <div className="mt-2 text-[10px] text-slate-500 font-mono truncate" title={config.projectId}>
          {config.projectId}
        </div>
        <div className="text-[10px] text-slate-500 font-mono truncate" title={config.collection}>
          /{config.collection}
        </div>
        {/* Mode badge */}
        <div className="mt-1.5 flex items-center gap-1.5">
          {schema.registryAvailable ? (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400">
              Registry
            </span>
          ) : (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-amber-500/15 text-amber-400">
              Discovery
            </span>
          )}
          {schema.readonly && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-slate-500/15 text-slate-400">
              Read-Only
            </span>
          )}
        </div>
      </div>

      {/* Search */}
      <div className="p-3 border-b border-slate-800">
        <form onSubmit={handleSearch}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Go to node by UID..."
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </form>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-auto p-3">
        <div className="mb-4">
          <Link
            to="/"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
              location.pathname === '/'
                ? 'bg-indigo-600/20 text-indigo-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
            </svg>
            Dashboard
          </Link>
          <Link
            to="/traverse"
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
              location.pathname === '/traverse'
                ? 'bg-indigo-600/20 text-indigo-400'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Traverse
          </Link>
        </div>

        {/* Node Types */}
        <div className="mb-4">
          <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
            Node Types
          </h3>
          {schema.nodeTypes.length === 0 ? (
            <p className="text-xs text-slate-600 px-3">No nodes found</p>
          ) : (
            schema.nodeTypes.map((nt) => (
              <Link
                key={nt.type}
                to={`/browse/${encodeURIComponent(nt.type)}`}
                className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  location.pathname === `/browse/${nt.type}`
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${getTypeColor(nt.type)}`} />
                  {nt.type}
                </span>
                <span className="text-slate-600 text-[10px]">{nt.count}</span>
              </Link>
            ))
          )}
        </div>

        {/* Edge Types */}
        <div>
          <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
            Edge Types
          </h3>
          {schema.edgeTypes.length === 0 ? (
            <p className="text-xs text-slate-600 px-3">No edges found</p>
          ) : (
            schema.edgeTypes.map((et) => (
              <div
                key={`${et.aType}:${et.abType}:${et.bType}`}
                className="px-3 py-1.5 text-[11px] text-slate-500"
              >
                <span className="text-slate-400">{et.aType}</span>
                <span className="text-indigo-400 mx-1">&rarr;</span>
                <span className="text-indigo-400">{et.abType}</span>
                <span className="text-indigo-400 mx-1">&rarr;</span>
                <span className="text-slate-400">{et.bType}</span>
                <span className="text-slate-600 ml-1">({et.count})</span>
              </div>
            ))
          )}
        </div>
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-slate-800">
        {!schema.isComplete && (
          <p className="text-[10px] text-amber-500/70">
            Schema sampled from {schema.sampleSize} docs
          </p>
        )}
      </div>
    </aside>
  );
}
