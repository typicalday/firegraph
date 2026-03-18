import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, type ReactNode } from 'react';
import type { Schema, AppConfig, ViewRegistryData } from '../types';
import { getTypeColor, collectionBrowseUrl } from '../utils';
import { useFocusMaybe } from './focus-context';
import { useScope } from './scope-context';
import { useRecents, type RecentEntry } from './recents-context';
import NearbyPanel from './NearbyPanel';
import { trpc } from '../trpc';

function relativeTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const recentIcons: Record<string, ReactNode> = {
  node: (
    <svg className="w-3 h-3 shrink-0 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  ),
  collection: (
    <svg className="w-3 h-3 shrink-0 text-amber-500/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  ),
  'collection-doc': (
    <svg className="w-3 h-3 shrink-0 text-amber-400/80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
};

function RecentItem({ entry }: { entry: RecentEntry }) {
  return (
    <Link
      to={entry.url}
      className="flex items-center gap-2 px-4 py-1.5 hover:bg-slate-800/50 transition-colors group"
      title={entry.label}
    >
      {recentIcons[entry.type]}
      <span className="flex-1 min-w-0">
        <span className="block text-[11px] text-slate-300 truncate font-mono">
          {entry.label.length > 14 ? `${entry.label.slice(0, 12)}…` : entry.label}
        </span>
        {entry.sublabel && (
          <span className="block text-[9px] text-slate-500 truncate">{entry.sublabel}</span>
        )}
      </span>
      <span className="text-[9px] text-slate-600 shrink-0 group-hover:text-slate-500">
        {relativeTime(entry.timestamp)}
      </span>
    </Link>
  );
}

interface Props {
  schema: Schema;
  config: AppConfig;
  viewRegistry?: ViewRegistryData | null;
}

type SidebarTab = 'navigate' | 'nearby';

export default function Sidebar({ schema, config, viewRegistry }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<SidebarTab>('navigate');
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [schemaTab, setSchemaTab] = useState<'nodes' | 'edges'>('nodes');
  const { displayRecents, clearRecents } = useRecents();
  const focus = useFocusMaybe();
  const { scopePath, scopedPath, scopeUrlPrefix, isScoped, exitToRoot } = useScope();

  const utils = trpc.useUtils();
  const reloadMutation = trpc.reloadSchema.useMutation({
    onSuccess: () => {
      // Invalidate queries so all components re-render with new schema
      utils.getSchema.invalidate();
      utils.getViews.invalidate();
      utils.getWarnings.invalidate();
    },
  });
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);

  // Auto-switch to Nearby tab when a node gains focus
  useEffect(() => {
    if (focus?.focused) {
      setActiveTab('nearby');
    }
  }, [focus?.focused?.uid]);

  // Auto-switch schema tab to 'nodes' when navigating to a node browse page
  useEffect(() => {
    const isNodeBrowsePage = schema.nodeTypes.some(
      (nt) => location.pathname === scopedPath(`/browse/${encodeURIComponent(nt.type)}`),
    );
    if (isNodeBrowsePage) {
      setSchemaTab('nodes');
    }
  }, [location.pathname, schema.nodeTypes, scopedPath]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(scopedPath(`/node/${encodeURIComponent(searchQuery.trim())}`));
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
        {isScoped && (
          <div className="mt-1 flex items-center gap-1.5">
            <svg className="w-3 h-3 text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            <span className="text-[10px] text-indigo-400 font-mono truncate" title={scopePath}>
              {scopePath}
            </span>
            <button
              onClick={exitToRoot}
              className="text-[9px] text-slate-500 hover:text-slate-300 underline shrink-0 transition-colors"
            >
              exit
            </button>
          </div>
        )}
        {/* Mode badge */}
        <div className="mt-1.5 flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-emerald-500/15 text-emerald-400">
            Registry
          </span>
          {schema.dynamicMode && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-violet-500/15 text-violet-400">
              Dynamic
            </span>
          )}
          {schema.readonly && (
            <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-slate-500/15 text-slate-400">
              Read-Only
            </span>
          )}
        </div>
        {/* Refresh schemas button */}
        {schema.dynamicMode && (
          <div className="mt-2">
            <button
              onClick={() => {
                setReloadMessage(null);
                reloadMutation.mutate(undefined, {
                  onSuccess: (data) => {
                    setReloadMessage(`Loaded ${data.nodeTypeCount} node, ${data.edgeTypeCount} edge types`);
                    setTimeout(() => setReloadMessage(null), 3000);
                  },
                  onError: (err) => {
                    setReloadMessage(`Error: ${err.message}`);
                    setTimeout(() => setReloadMessage(null), 5000);
                  },
                });
              }}
              disabled={reloadMutation.isPending}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 transition-colors disabled:opacity-50"
            >
              <svg className={`w-3 h-3 ${reloadMutation.isPending ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {reloadMutation.isPending ? 'Refreshing...' : 'Refresh Schemas'}
            </button>
            {reloadMessage && (
              <p className={`mt-1 text-[9px] ${reloadMutation.isError ? 'text-red-400' : 'text-emerald-400'}`}>
                {reloadMessage}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-800 shrink-0">
        <button
          onClick={() => setActiveTab('navigate')}
          className={`flex-1 px-3 py-2 text-[11px] font-medium transition-colors ${
            activeTab === 'navigate'
              ? 'text-slate-200 border-b-2 border-indigo-500'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          Navigate
        </button>
        <button
          onClick={() => setActiveTab('nearby')}
          className={`flex-1 px-3 py-2 text-[11px] font-medium transition-colors relative ${
            activeTab === 'nearby'
              ? 'text-slate-200 border-b-2 border-indigo-500'
              : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          Nearby
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'navigate' ? (
        <>
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

          {/* Recents */}
          {displayRecents.length > 0 && (
            <div className="border-b border-slate-800">
              <button
                onClick={() => setRecentsOpen((o) => !o)}
                className="flex items-center justify-between w-full px-4 py-2 text-[10px] uppercase tracking-wider text-slate-500 font-semibold hover:text-slate-400 transition-colors"
              >
                <span>Recent</span>
                <span className="flex items-center gap-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); clearRecents(); }}
                    className="text-slate-600 hover:text-slate-400 transition-colors"
                    title="Clear recents"
                  >
                    ×
                  </button>
                  <svg
                    className={`w-3 h-3 transition-transform ${recentsOpen ? '' : '-rotate-90'}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              </button>
              {recentsOpen && (
                <div className="pb-2">
                  {displayRecents.map((entry) => (
                    <RecentItem key={entry.url + entry.timestamp} entry={entry} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Navigation */}
          <nav className="flex-1 overflow-auto p-3">
            <div className="mb-4">
              <Link
                to="/f"
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  location.pathname === scopeUrlPrefix
                    ? 'bg-indigo-600/20 text-indigo-400'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                </svg>
                Graph
              </Link>
              <Link
                to={scopedPath('/traverse')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  location.pathname === scopedPath('/traverse')
                    ? 'bg-indigo-600/20 text-indigo-400'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                Traverse
              </Link>
              {viewRegistry?.hasViews && (
                <Link
                  to={scopedPath('/views')}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    location.pathname === scopedPath('/views')
                      ? 'bg-indigo-600/20 text-indigo-400'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
                  </svg>
                  Views
                </Link>
              )}
            </div>

            {/* Schema tabs: Nodes / Edges */}
            <div className="mb-4">
              <div className="flex items-center gap-1 px-3 mb-2" role="tablist">
                <button
                  role="tab"
                  aria-selected={schemaTab === 'nodes'}
                  onClick={() => setSchemaTab('nodes')}
                  className={`flex-1 py-1 text-[10px] uppercase tracking-wider font-semibold rounded transition-colors ${
                    schemaTab === 'nodes'
                      ? 'bg-slate-800 text-slate-200'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Nodes
                </button>
                <button
                  role="tab"
                  aria-selected={schemaTab === 'edges'}
                  onClick={() => setSchemaTab('edges')}
                  className={`flex-1 py-1 text-[10px] uppercase tracking-wider font-semibold rounded transition-colors ${
                    schemaTab === 'edges'
                      ? 'bg-slate-800 text-slate-200'
                      : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  Edges
                </button>
              </div>

              {schemaTab === 'nodes' ? (
                schema.nodeTypes.length === 0 ? (
                  <p className="text-xs text-slate-600 px-3">No nodes registered</p>
                ) : (
                  schema.nodeTypes.map((nt) => (
                    <Link
                      key={nt.type}
                      to={scopedPath(`/browse/${encodeURIComponent(nt.type)}`)}
                      className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors ${
                        location.pathname === scopedPath(`/browse/${encodeURIComponent(nt.type)}`)
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${getTypeColor(nt.type)}`} />
                        {nt.type}
                      </span>
                      {nt.isDynamic && (
                        <span className="px-1 py-px rounded text-[8px] font-semibold bg-violet-500/20 text-violet-400" title="Dynamic type (from Firestore)">
                          D
                        </span>
                      )}
                    </Link>
                  ))
                )
              ) : (
                schema.edgeTypes.length === 0 ? (
                  <p className="text-xs text-slate-600 px-3">No edges registered</p>
                ) : (
                  schema.edgeTypes.map((et) => (
                    <Link
                      key={`edge:${et.aType}:${et.axbType}:${et.bType}`}
                      to={scopedPath(`/browse/${encodeURIComponent(et.aType)}`)}
                      title={`Browse ${et.aType} nodes`}
                      className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-[11px] transition-colors ${
                        location.pathname === scopedPath(`/browse/${encodeURIComponent(et.aType)}`)
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                      }`}
                    >
                      <span>
                        <span>{et.aType}</span>
                        <span className="text-indigo-400 mx-1">&rarr;</span>
                        <span className="text-indigo-400">{et.axbType}</span>
                        <span className="text-indigo-400 mx-1">&rarr;</span>
                        <span>{et.bType}</span>
                      </span>
                      {et.isDynamic && (
                        <span className="px-1 py-px rounded text-[8px] font-semibold bg-violet-500/20 text-violet-400 shrink-0 ml-1" title="Dynamic type (from Firestore)">
                          D
                        </span>
                      )}
                    </Link>
                  ))
                )
              )}
            </div>

            {/* Collections */}
            {(schema.collections ?? []).length > 0 && (
              <div>
                <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
                  Collections
                </h3>
                {(schema.collections ?? []).map((col) => (
                  <Link
                    key={col.name}
                    to={collectionBrowseUrl(col.name)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                      location.pathname.startsWith(collectionBrowseUrl(col.name))
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    <svg className="w-3 h-3 shrink-0 text-amber-500/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span className="flex-1 truncate">{col.name}</span>
                    {col.pathParams.length > 0 && (
                      <span className="text-[9px] text-slate-600 shrink-0">
                        {col.pathParams.map((p) => `{${p}}`).join('/')}
                      </span>
                    )}
                  </Link>
                ))}
              </div>
            )}
          </nav>
        </>
      ) : (
        <div className="flex-1 overflow-auto">
          <NearbyPanel schema={schema} />
        </div>
      )}

      {/* Footer - empty placeholder for consistent layout */}
      <div className="p-3 border-t border-slate-800" />
    </aside>
  );
}
