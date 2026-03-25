import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, useMemo, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Schema, AppConfig, ViewRegistryData } from '../types';
import {
  getTypeColor,
  isTypeVisibleInScope,
  isCollectionUnderGraph,
  decodeFsPath,
  encodeFsPath,
  isGraphPath,
  extractGraphScope,
  scopeToNamesPath,
  matchCollectionTemplate,
  fsUrl,
  resolveCollectionPath,
} from '../utils';
import { useFocusMaybe } from './focus-context';
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

function RecentItem({ entry, onClose }: { entry: RecentEntry; onClose: () => void }) {
  return (
    <Link
      to={entry.url}
      onClick={onClose}
      className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-800/50 transition-colors group"
      title={entry.label}
    >
      {recentIcons[entry.type]}
      <span className="flex-1 min-w-0">
        <span className="block text-[11px] text-slate-300 truncate font-mono">
          {entry.label.length > 14 ? `${entry.label.slice(0, 12)}\u2026` : entry.label}
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

function RecentsPopover({
  entries,
  triggerRef,
  onClose,
  onClear,
}: {
  entries: RecentEntry[];
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onClear: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({ top: rect.top, left: rect.right + 8 });
    }
  }, [triggerRef]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current && !popoverRef.current.contains(target) &&
        triggerRef.current && !triggerRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, triggerRef]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 9999 }}
      className="w-64 bg-slate-900 border border-slate-700 rounded-xl shadow-xl shadow-black/50"
      onMouseLeave={onClose}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Recent</span>
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); onClose(); }}
          className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
        >
          Clear
        </button>
      </div>
      <div className="py-1 max-h-80 overflow-auto">
        {entries.map((entry) => (
          <RecentItem key={entry.url + entry.timestamp} entry={entry} onClose={onClose} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

interface Props {
  schema: Schema;
  config: AppConfig;
  viewRegistry?: ViewRegistryData | null;
}

/**
 * Derive path context info from the URL. Works outside of PathProvider.
 */
function usePathFromUrl(graphCollection?: string, collections?: Schema['collections']) {
  const location = useLocation();

  return useMemo(() => {
    const pathname = location.pathname;

    // Root page
    if (pathname === '/') {
      return {
        pathType: 'root' as const,
        firestorePath: '',
        encodedPath: '',
        graphScope: '',
        scopeNamesPath: '',
        isScoped: false,
        collectionMatch: null as { collection: NonNullable<Schema['collections']>[number]; params: Record<string, string> } | null,
        pageAction: '',
        isOnNodePage: false,
      };
    }

    // Extract encoded path (first segment) and page action (rest)
    const withoutLeadingSlash = pathname.slice(1);
    const firstSlashIdx = withoutLeadingSlash.indexOf('/');
    const encodedPath = firstSlashIdx >= 0 ? withoutLeadingSlash.slice(0, firstSlashIdx) : withoutLeadingSlash;
    const pageAction = firstSlashIdx >= 0 ? withoutLeadingSlash.slice(firstSlashIdx) : '';
    const firestorePath = decodeFsPath(encodedPath);

    const isOnNodePage = pageAction.startsWith('/node/');

    // Check collection templates first — more specific than the graph catch-all prefix.
    if (collections) {
      for (const col of collections) {
        const params = matchCollectionTemplate(firestorePath, col.path);
        if (params) {
          return {
            pathType: 'collection' as const,
            firestorePath,
            encodedPath,
            graphScope: '',
            scopeNamesPath: '',
            isScoped: false,
            collectionMatch: { collection: col, params },
            pageAction,
            isOnNodePage,
          };
        }
      }
    }

    // Check if graph path
    if (isGraphPath(firestorePath, graphCollection)) {
      const graphScope = extractGraphScope(firestorePath, graphCollection!);
      return {
        pathType: 'graph' as const,
        firestorePath,
        encodedPath,
        graphScope,
        scopeNamesPath: scopeToNamesPath(graphScope),
        isScoped: graphScope !== '',
        collectionMatch: null,
        pageAction,
        isOnNodePage,
      };
    }

    return {
      pathType: 'unknown' as const,
      firestorePath,
      encodedPath,
      graphScope: '',
      scopeNamesPath: '',
      isScoped: false,
      collectionMatch: null,
      pageAction,
      isOnNodePage,
    };
  }, [location.pathname, graphCollection, collections]);
}

export default function Sidebar({ schema, config, viewRegistry }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [recentsOpen, setRecentsOpen] = useState(false);
  const { displayRecents, clearRecents } = useRecents();
  const focus = useFocusMaybe();
  const recentsTriggerRef = useRef<HTMLButtonElement>(null);

  const pathInfo = usePathFromUrl(config.collection, schema.collections);

  const utils = trpc.useUtils();
  const reloadMutation = trpc.reloadSchema.useMutation({
    onSuccess: () => {
      utils.getSchema.invalidate();
      utils.getViews.invalidate();
      utils.getWarnings.invalidate();
    },
  });
  const [reloadMessage, setReloadMessage] = useState<string | null>(null);

  // Build URL helpers based on current path
  const pathUrl = useCallback((pageAction?: string) => {
    if (!pathInfo.encodedPath) return '/';
    const prefix = `/${pathInfo.encodedPath}`;
    if (!pageAction) return prefix;
    const action = pageAction.startsWith('/') ? pageAction.slice(1) : pageAction;
    return `${prefix}/${action}`;
  }, [pathInfo.encodedPath]);

  const enterSubgraph = useCallback((parentUid: string, subgraphName: string) => {
    const newPath = pathInfo.firestorePath + '/' + parentUid + '/' + subgraphName;
    navigate(`/${encodeFsPath(newPath)}`);
  }, [navigate, pathInfo.firestorePath]);

  const navigateToRoot = useCallback(() => {
    if (config.collection) {
      navigate(`/${encodeFsPath(config.collection)}`);
    } else {
      navigate('/');
    }
  }, [navigate, config.collection]);

  // Scope-aware node type filtering
  const filteredNodeTypes = useMemo(() => {
    const nodeSchemas = schema.nodeSchemas ?? [];
    return schema.nodeTypes.filter((nt) => {
      const meta = nodeSchemas.find((s) => s.aType === nt.type && s.isNodeEntry);
      return isTypeVisibleInScope(pathInfo.scopeNamesPath, meta?.allowedIn);
    });
  }, [schema.nodeTypes, schema.nodeSchemas, pathInfo.scopeNamesPath]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;

    if (pathInfo.pathType === 'collection' && pathInfo.collectionMatch) {
      navigate(fsUrl(pathInfo.firestorePath, `doc/${encodeURIComponent(q)}`));
    } else {
      navigate(pathUrl(`/node/${encodeURIComponent(q)}`));
    }
    setSearchQuery('');
  }, [searchQuery, pathInfo, navigate, pathUrl]);

  // Show Nearby panel inline when on a node page with a focused node
  const showNearby = pathInfo.pathType === 'graph' && pathInfo.isOnNodePage && !!focus?.focused;

  // Contextual subgraphs and collections for the focused node
  const availableSubgraphs = useMemo(() => {
    if (!focus?.focused) return [];
    const subs: Array<{ name: string; edgeType: string; targetType: string }> = [];
    const seen = new Set<string>();
    for (const et of schema.edgeTypes) {
      if (et.aType === focus.focused.nodeType && et.targetGraph && !seen.has(et.targetGraph)) {
        seen.add(et.targetGraph);
        subs.push({ name: et.targetGraph, edgeType: et.axbType, targetType: et.bType });
      }
    }
    return subs;
  }, [schema.edgeTypes, focus?.focused]);

  const attachedCollections = useMemo(
    () => (schema.collections ?? []).filter(
      (c) => c.parentNodeType === focus?.focused?.nodeType && isCollectionUnderGraph(c.path, config.collection),
    ),
    [schema.collections, focus?.focused?.nodeType, config.collection],
  );

  // Collections not tied to a node type (global) and under the current graph
  const globalCollections = useMemo(
    () => (schema.collections ?? []).filter(
      (c) => !c.parentNodeType && isCollectionUnderGraph(c.path, config.collection),
    ),
    [schema.collections, config.collection],
  );

  // All top-level collections (for root page sidebar)
  const topLevelCollections = useMemo(
    () => (schema.collections ?? []).filter((c) => !c.path.includes('/')),
    [schema.collections],
  );

  // Build the collection URL by resolving path params from the focused node
  const buildCollectionUrl = useCallback((col: { path: string; pathParams: string[] }) => {
    if (col.pathParams.length === 0) return fsUrl(col.path);
    const colParams: Record<string, string> = {};
    if (focus?.focused && col.pathParams.length > 0) {
      colParams[col.pathParams[0]] = focus.focused.uid;
    }
    return fsUrl(resolveCollectionPath(col.path, colParams));
  }, [focus?.focused]);

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
        {pathInfo.isScoped && (
          <div className="mt-1 flex items-center gap-1.5">
            <svg className="w-3 h-3 text-indigo-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            <span className="text-[10px] text-indigo-400 font-mono truncate" title={pathInfo.graphScope}>
              {pathInfo.graphScope}
            </span>
            <button
              onClick={navigateToRoot}
              className="text-[9px] text-slate-500 hover:text-slate-300 underline shrink-0 transition-colors"
            >
              exit
            </button>
          </div>
        )}
        {/* Mode badges */}
        {(schema.dynamicMode || schema.readonly) && (
          <div className="mt-1.5 flex items-center gap-1.5">
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
        )}
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

      {/* Search — only in graph or collection context */}
      {(pathInfo.pathType === 'graph' || pathInfo.pathType === 'collection') && (
        <div className="p-3 border-b border-slate-800">
          <form onSubmit={handleSearch}>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={pathInfo.pathType === 'collection' ? 'Go to document by ID...' : 'Go to node by UID...'}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </form>
        </div>
      )}

      {/* Navigation */}
      <nav className="flex-1 overflow-auto p-3">
        {/* Root page: show graph + top-level collections as nav */}
        {pathInfo.pathType === 'root' && (
          <div className="mb-4">
            {config.collection && (
              <>
                <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
                  Graphs
                </h3>
                <Link
                  to={`/${encodeFsPath(config.collection)}`}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
                >
                  <svg className="w-3.5 h-3.5 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                  </svg>
                  {config.collection}
                </Link>
              </>
            )}
            {topLevelCollections.length > 0 && (
              <>
                <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 mt-3 px-3">
                  Collections
                </h3>
                {topLevelCollections.map((col) => (
                  <Link
                    key={col.name}
                    to={fsUrl(col.path)}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 transition-colors"
                  >
                    <svg className="w-3 h-3 shrink-0 text-amber-500/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span className="flex-1 truncate">{col.name}</span>
                  </Link>
                ))}
              </>
            )}
          </div>
        )}

        {pathInfo.pathType === 'graph' && (
          <>
            {/* Graph navigation links */}
            <div className="mb-4">
              <Link
                to={pathUrl()}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  location.pathname === pathUrl()
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
                to={pathUrl('/traverse')}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  location.pathname === pathUrl('/traverse')
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
                  to={pathUrl('/views')}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                    location.pathname === pathUrl('/views')
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
              {displayRecents.length > 0 && (
                <>
                  <button
                    ref={recentsTriggerRef}
                    onClick={() => setRecentsOpen((v) => !v)}
                    onMouseEnter={() => setRecentsOpen(true)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors w-full text-left ${
                      recentsOpen
                        ? 'bg-slate-800 text-slate-200'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                    }`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Recent
                  </button>
                  {recentsOpen && (
                    <RecentsPopover
                      entries={displayRecents}
                      triggerRef={recentsTriggerRef}
                      onClose={() => setRecentsOpen(false)}
                      onClear={clearRecents}
                    />
                  )}
                </>
              )}
            </div>

            {/* On node pages: show Nearby relationships instead of node type listing */}
            {showNearby ? (
              <div className="mb-4">
                <NearbyPanel schema={schema} />
              </div>
            ) : (
              /* Node types — filtered by allowedIn for current scope */
              <div className="mb-4">
                <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
                  Nodes
                </h3>
                {filteredNodeTypes.length === 0 ? (
                  <p className="text-xs text-slate-600 px-3">
                    {schema.nodeTypes.length === 0 ? 'No nodes registered' : 'No nodes allowed in this scope'}
                  </p>
                ) : (
                  filteredNodeTypes.map((nt) => (
                    <Link
                      key={nt.type}
                      to={pathUrl(`/browse/${encodeURIComponent(nt.type)}`)}
                      className={`flex items-center justify-between px-3 py-1.5 rounded-lg text-xs transition-colors ${
                        location.pathname === pathUrl(`/browse/${encodeURIComponent(nt.type)}`)
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
                )}
              </div>
            )}
          </>
        )}

        {/* Collection page nav links */}
        {pathInfo.pathType === 'collection' && (
          <div className="mb-4">
            {displayRecents.length > 0 && (
              <>
                <button
                  ref={recentsTriggerRef}
                  onClick={() => setRecentsOpen((v) => !v)}
                  onMouseEnter={() => setRecentsOpen(true)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors w-full text-left ${
                    recentsOpen
                      ? 'bg-slate-800 text-slate-200'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  }`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Recent
                </button>
                {recentsOpen && (
                  <RecentsPopover
                    entries={displayRecents}
                    triggerRef={recentsTriggerRef}
                    onClose={() => setRecentsOpen(false)}
                    onClear={clearRecents}
                  />
                )}
              </>
            )}
          </div>
        )}

        {/* Contextual subgraphs & collections for focused node */}
        {showNearby && (availableSubgraphs.length > 0 || attachedCollections.length > 0) && (
          <div className="mb-4">
            {availableSubgraphs.length > 0 && (
              <>
                <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
                  Subgraphs
                </h3>
                {availableSubgraphs.map((sg) => (
                  <button
                    key={sg.name}
                    onClick={() => focus?.focused && enterSubgraph(focus.focused.uid, sg.name)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 transition-colors text-left"
                  >
                    <svg className="w-3 h-3 shrink-0 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
                    </svg>
                    <span className="flex-1 truncate">{sg.name}</span>
                  </button>
                ))}
              </>
            )}
            {attachedCollections.length > 0 && (
              <>
                <h3 className={`text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3 ${availableSubgraphs.length > 0 ? 'mt-3' : ''}`}>
                  Collections
                </h3>
                {attachedCollections.map((col) => (
                  <Link
                    key={col.name}
                    to={buildCollectionUrl(col)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                      location.pathname.startsWith(buildCollectionUrl(col))
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                    }`}
                  >
                    <svg className="w-3 h-3 shrink-0 text-amber-500/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                    <span className="flex-1 truncate">{col.name}</span>
                  </Link>
                ))}
              </>
            )}
          </div>
        )}

        {/* Global collections — shown on non-node graph pages and collection pages */}
        {!showNearby && globalCollections.length > 0 && (
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2 px-3">
              Collections
            </h3>
            {globalCollections.map((col) => (
              <Link
                key={col.name}
                to={fsUrl(col.path)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs transition-colors ${
                  location.pathname.startsWith(fsUrl(col.path))
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

      {/* Footer */}
      <div className="p-3 border-t border-slate-800" />
    </aside>
  );
}
