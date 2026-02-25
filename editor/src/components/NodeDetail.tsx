import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import type { Schema, GraphRecord, ViewRegistryData, ViewMeta, AppConfig } from '../types';
import { trpc } from '../trpc';
import { getTypeBadgeColor, formatTimestamp, resolveViewForEntity } from '../utils';
import JsonView from './JsonView';
import CustomView from './CustomView';
import ViewSwitcher from './ViewSwitcher';
import { TraversalPanel } from './TraversalBuilder';
import NodeEditor from './NodeEditor';
import EdgeEditor from './EdgeEditor';
import ConfirmDialog from './ConfirmDialog';
import { DrillProvider, useDrill, type DrillFrame } from './drill-context';
import DrillStack from './DrillStack';
import { useFocusMaybe } from './focus-context';

interface Props {
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config: AppConfig;
  onDataChanged?: () => void;
}

const LIMIT_OPTIONS = [10, 25, 50, 100];

/**
 * Exported route component — thin shell that wraps DrillProvider + DrillStack.
 */
export default function NodeDetail({ schema, viewRegistry, config, onDataChanged }: Props) {
  const { uid } = useParams<{ uid: string }>();
  const location = useLocation();
  if (!uid) return null;

  const initialPaths = (location.state as { initialPaths?: DrillFrame[][] } | null)?.initialPaths;

  return (
    <DrillProvider rootUid={uid} initialPaths={initialPaths}>
      <DrillStack
        schema={schema}
        viewRegistry={viewRegistry}
        config={config}
        onDataChanged={onDataChanged}
      />
    </DrillProvider>
  );
}

// --- NodeDetailContent: the actual node detail rendering ---

export interface NodeDetailContentProps {
  uid: string;
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config: AppConfig;
  onDataChanged?: () => void;
  isDrilled?: boolean;
  drillIndex?: number;
  laneId?: string;
}

export function NodeDetailContent({
  uid,
  schema,
  viewRegistry,
  config,
  onDataChanged,
  isDrilled = false,
  drillIndex = 0,
  laneId,
}: NodeDetailContentProps) {
  const navigate = useNavigate();
  const { popTo, setRootType } = useDrill();
  const focus = useFocusMaybe();
  const [editing, setEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showCreateEdge, setShowCreateEdge] = useState(false);
  const [showCreateIncomingEdge, setShowCreateIncomingEdge] = useState(false);
  const [deletingEdge, setDeletingEdge] = useState<{ aUid: string; axbType: string; bUid: string } | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const canWrite = !schema.readonly;
  const [activeView, setActiveView] = useState('json');
  const [viewInitialized, setViewInitialized] = useState(false);

  const { data: nodeDetailData, isLoading: loading, error: queryError, refetch: loadNode } = trpc.getNodeDetail.useQuery(
    { uid },
    { enabled: !!uid },
  );

  const node = (nodeDetailData?.node as GraphRecord | null) ?? null;
  const error = queryError?.message ?? mutationError ?? null;

  // Track a reload signal for edge sections
  const [edgeReloadKey, setEdgeReloadKey] = useState(0);
  const reloadEdges = () => setEdgeReloadKey((k) => k + 1);

  // Reset UI state when uid changes
  useEffect(() => {
    setEditing(false);
    setShowCreateEdge(false);
    setShowCreateIncomingEdge(false);
    setViewInitialized(false);
    setMutationError(null);
  }, [uid]);

  // Resolve initial view from config defaults once node data is available
  useEffect(() => {
    if (!node || viewInitialized) return;
    const views = viewRegistry?.nodes[node.aType]?.views ?? [];
    const resolverConfig = config.viewDefaults?.nodes?.[node.aType];
    if (resolverConfig && views.length > 0) {
      const resolved = resolveViewForEntity(resolverConfig, views, 'detail');
      if (resolved !== 'json') {
        const match = views.find((v) => v.viewName === resolved);
        if (match) setActiveView(match.tagName);
      }
    }
    setViewInitialized(true);
  }, [node, viewInitialized, viewRegistry, config]);

  // Set root type for breadcrumb when this is the root frame
  useEffect(() => {
    if (node && drillIndex === 0) {
      setRootType(node.aType);
    }
  }, [node, drillIndex, setRootType]);

  // Publish focus to FocusContext only from the root frame (drillIndex === 0).
  // The Nearby panel and breadcrumb always anchor to the same root node.
  // Peek callbacks are registered separately by DrillStack (which owns setPeek).
  useEffect(() => {
    if (!focus || !node || drillIndex !== 0) return;
    focus.setFocused({ uid: node.aUid, nodeType: node.aType });
    return () => {
      focus.setFocused(null);
    };
  }, [node?.aUid, node?.aType, drillIndex, focus]);

  const deleteNodeMutation = trpc.deleteNode.useMutation({
    onSuccess: () => {
      onDataChanged?.();
      if (isDrilled && laneId) {
        popTo(laneId, drillIndex - 1);
      } else {
        navigate('/');
      }
    },
    onError: (err) => setMutationError(err.message),
    onSettled: () => setShowDeleteConfirm(false),
  });

  const deleteEdgeMutation = trpc.deleteEdge.useMutation({
    onSuccess: () => {
      setDeletingEdge(null);
      reloadEdges();
      onDataChanged?.();
    },
    onError: (err) => setMutationError(err.message),
  });

  const handleDelete = () => {
    if (!uid) return;
    deleteNodeMutation.mutate({ uid });
  };

  const handleDeleteEdge = () => {
    if (!deletingEdge) return;
    deleteEdgeMutation.mutate({
      aUid: deletingEdge.aUid,
      axbType: deletingEdge.axbType,
      bUid: deletingEdge.bUid,
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-sm text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!node) {
    return (
      <div className="p-6">
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
          <h2 className="text-lg font-semibold mb-2">Node Not Found</h2>
          <p className="text-sm text-slate-400">
            No node with UID <code className="text-indigo-400 font-mono">{uid}</code> was found.
          </p>
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <NodeEditor
          schema={schema}
          existingNode={node}
          onSaved={() => {
            setEditing(false);
            loadNode();
            onDataChanged?.();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  // Collect unique axbTypes from schema for filter dropdowns
  const outAxbTypes = schema.edgeTypes
    .filter((et) => et.aType === node.aType)
    .map((et) => et.axbType);
  const inAxbTypes = schema.edgeTypes
    .filter((et) => et.bType === node.aType)
    .map((et) => et.axbType);

  // Build inverse label lookup for incoming edges
  const inverseLabelMap: Record<string, string> = {};
  for (const et of schema.edgeTypes) {
    if (et.inverseLabel) {
      inverseLabelMap[et.axbType] = et.inverseLabel;
    }
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Link
            to={`/browse/${encodeURIComponent(node.aType)}`}
            className={`px-2 py-0.5 rounded text-xs font-mono hover:opacity-80 transition-opacity ${getTypeBadgeColor(node.aType)}`}
          >
            {node.aType}
          </Link>
          <h1 className="text-xl font-bold font-mono">{node.aUid}</h1>
          {canWrite && (
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-xs hover:bg-slate-700 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="px-3 py-1.5 bg-red-600/20 text-red-400 rounded-lg text-xs hover:bg-red-600/30 transition-colors"
              >
                Delete
              </button>
            </div>
          )}
        </div>
        <div className="flex gap-4 text-xs text-slate-500 mt-2">
          <span>Created: {formatTimestamp(node.createdAt)}</span>
          <span>Updated: {formatTimestamp(node.updatedAt)}</span>
        </div>
      </div>

      {/* Data */}
      <section className="bg-slate-900 rounded-xl border border-slate-800 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Data</h2>
          <ViewSwitcher
            views={viewRegistry?.nodes[node.aType]?.views ?? []}
            activeView={activeView}
            onSwitch={setActiveView}
          />
        </div>
        {activeView === 'json' ? (
          <div className="font-mono text-xs leading-relaxed bg-slate-950 rounded-lg p-4 overflow-auto max-h-96">
            <JsonView data={node.data} defaultExpanded />
          </div>
        ) : (
          <CustomView tagName={activeView} data={node.data as Record<string, unknown>} />
        )}
      </section>

      {/* Outgoing Edges */}
      <section className="bg-slate-900 rounded-xl border border-slate-800 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Outgoing Edges</h2>
          {canWrite && !showCreateEdge && (
            <button
              onClick={() => setShowCreateEdge(true)}
              className="px-3 py-1 bg-indigo-600/20 text-indigo-400 rounded-lg text-xs hover:bg-indigo-600/30 transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Edge
            </button>
          )}
        </div>
        {showCreateEdge && (
          <div className="mb-4">
            <EdgeEditor
              schema={schema}
              viewRegistry={viewRegistry}
              config={config}
              defaultUid={node.aUid}
              defaultType={node.aType}
              direction="out"
              onSaved={() => {
                setShowCreateEdge(false);
                reloadEdges();
                onDataChanged?.();
              }}
              onCancel={() => setShowCreateEdge(false)}
            />
          </div>
        )}
        {!showCreateEdge && (
          <PaginatedEdgeSection
            uid={node.aUid}
            direction="out"
            axbTypes={outAxbTypes}
            canWrite={canWrite}
            onDeleteEdge={(e) => setDeletingEdge({ aUid: e.aUid, axbType: e.axbType, bUid: e.bUid })}
            reloadKey={edgeReloadKey}
            viewRegistry={viewRegistry}
            config={config}
            schema={schema}
            publishToNearby={drillIndex === 0}
          />
        )}
      </section>

      {/* Incoming Edges */}
      <section className="bg-slate-900 rounded-xl border border-slate-800 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">Incoming Edges</h2>
          {canWrite && !showCreateIncomingEdge && inAxbTypes.length > 0 && (
            <button
              onClick={() => setShowCreateIncomingEdge(true)}
              className="px-3 py-1 bg-indigo-600/20 text-indigo-400 rounded-lg text-xs hover:bg-indigo-600/30 transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Edge
            </button>
          )}
        </div>
        {showCreateIncomingEdge && (
          <div className="mb-4">
            <EdgeEditor
              schema={schema}
              viewRegistry={viewRegistry}
              config={config}
              defaultUid={node.aUid}
              defaultType={node.aType}
              direction="in"
              onSaved={() => {
                setShowCreateIncomingEdge(false);
                reloadEdges();
                onDataChanged?.();
              }}
              onCancel={() => setShowCreateIncomingEdge(false)}
            />
          </div>
        )}
        {!showCreateIncomingEdge && (
          <PaginatedEdgeSection
            uid={node.aUid}
            direction="in"
            axbTypes={inAxbTypes}
            inverseLabelMap={inverseLabelMap}
            canWrite={canWrite}
            onDeleteEdge={(e) => setDeletingEdge({ aUid: e.aUid, axbType: e.axbType, bUid: e.bUid })}
            reloadKey={edgeReloadKey}
            viewRegistry={viewRegistry}
            config={config}
            schema={schema}
            publishToNearby={drillIndex === 0}
          />
        )}
      </section>

      {/* Traversal from this node */}
      {schema.edgeTypes.length > 0 && (
        <section className="bg-slate-900 rounded-xl border border-slate-800 p-5">
          <h2 className="text-sm font-semibold mb-4 flex items-center gap-2">
            <svg className="w-4 h-4 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Traverse from this node
          </h2>
          <TraversalPanel schema={schema} startUid={node.aUid} startNodeType={node.aType} viewRegistry={viewRegistry} config={config} />
        </section>
      )}

      {/* Delete node dialog */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Node"
          message={`Are you sure you want to delete node "${node.aUid}" (${node.aType})? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          loading={deleteNodeMutation.isPending}
        />
      )}

      {/* Delete edge dialog */}
      {deletingEdge && (
        <ConfirmDialog
          title="Delete Edge"
          message={`Delete edge ${deletingEdge.aUid} —[${deletingEdge.axbType}]→ ${deletingEdge.bUid}?`}
          onConfirm={handleDeleteEdge}
          onCancel={() => setDeletingEdge(null)}
          loading={deleteEdgeMutation.isPending}
        />
      )}
    </div>
  );
}

// --- Paginated Edge Section ---

function PaginatedEdgeSection({
  uid,
  direction,
  axbTypes,
  inverseLabelMap = {},
  canWrite,
  onDeleteEdge,
  reloadKey,
  viewRegistry,
  config,
  schema,
  publishToNearby = false,
}: {
  uid: string;
  direction: 'in' | 'out';
  axbTypes: string[];
  inverseLabelMap?: Record<string, string>;
  canWrite: boolean;
  onDeleteEdge: (edge: GraphRecord) => void;
  reloadKey: number;
  viewRegistry?: ViewRegistryData | null;
  config: AppConfig;
  schema: Schema;
  publishToNearby?: boolean;
}) {
  // Toolbar state
  const [limit, setLimit] = useState(25);
  const [filterAxbType, setFilterAxbType] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [whereField, setWhereField] = useState('');
  const [whereOp, setWhereOp] = useState<string>('==');
  const [whereValue, setWhereValue] = useState('');
  const [activeWhere, setActiveWhere] = useState<Array<{ field: string; op: string; value: string | number | boolean }>>([]);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [startAfter, setStartAfter] = useState<string | undefined>(undefined);

  // Expand / Resolve state
  const [expandAll, setExpandAll] = useState(false);
  const [resolveAll, setResolveAll] = useState(false);
  const [resolvedNodes, setResolvedNodes] = useState<Record<string, GraphRecord | null>>({});

  // Built-in record fields that are always available for sort/filter
  const builtinFields = ['axbType', 'aType', 'aUid', 'bType', 'bUid', 'createdAt', 'updatedAt'];

  // Collect available data fields from edge schemas matching current filter
  const dataFields = useMemo(() => {
    const schemas = schema.edgeSchemas ?? [];
    const matching = filterAxbType
      ? schemas.filter((s) => s.axbType === filterAxbType)
      : schemas.filter((s) => axbTypes.includes(s.axbType));
    // Merge unique field names from all matching schemas
    const fieldSet = new Set<string>();
    for (const s of matching) {
      for (const f of s.fields) fieldSet.add(f.name);
    }
    return [...fieldSet].sort();
  }, [schema.edgeSchemas, filterAxbType, axbTypes]);

  const edgeQueryInput = {
    ...(direction === 'out' ? { aUid: uid } : { bUid: uid }),
    ...(filterAxbType ? { axbType: filterAxbType } : {}),
    limit,
    startAfter,
    ...(sortBy ? { sortBy, sortDir } : {}),
    ...(activeWhere.length > 0 ? { where: activeWhere } : {}),
  };

  const { data: edgeData, isLoading: loading, error: queryError, refetch: refetchEdges } = trpc.getEdges.useQuery(
    edgeQueryInput,
    { placeholderData: (prev) => prev },
  );

  const edges = (edgeData?.edges ?? []) as GraphRecord[];
  const hasMore = edgeData?.hasMore ?? false;
  const nextCursor = edgeData?.nextCursor ?? null;
  const error = queryError?.message ?? null;

  // Publish edge results to FocusContext so NearbyPanel can mirror them
  const focus = useFocusMaybe();
  useEffect(() => {
    if (!publishToNearby || !focus) return;
    focus.setEdgeResults(direction, { edges, hasMore, loading });
  }, [publishToNearby, focus, direction, edges, hasMore, loading]);

  // Compute UIDs that need batch resolving
  const toResolveUids = resolveAll && edges.length > 0
    ? [...new Set(edges.map((e) => (direction === 'out' ? e.bUid : e.aUid)))].filter((u) => !(u in resolvedNodes))
    : [];

  const { data: batchData, isFetching: resolving } = trpc.getNodesBatch.useQuery(
    { uids: toResolveUids },
    { enabled: toResolveUids.length > 0 },
  );

  // Sync batch resolve results into local state
  useEffect(() => {
    if (!batchData) return;
    const mapped: Record<string, GraphRecord | null> = {};
    for (const [k, v] of Object.entries(batchData.nodes)) {
      mapped[k] = v as GraphRecord | null;
    }
    setResolvedNodes((prev) => ({ ...prev, ...mapped }));
  }, [batchData]);

  // Reset pagination when params change or external reload is triggered
  useEffect(() => {
    setPage(1);
    setCursorStack([]);
    setStartAfter(undefined);
    setResolvedNodes({});
  }, [uid, direction, limit, filterAxbType, sortBy, sortDir, activeWhere, reloadKey]);

  const goNextPage = () => {
    if (!nextCursor) return;
    setCursorStack((prev) => [...prev, nextCursor]);
    setPage((p) => p + 1);
    setStartAfter(nextCursor);
  };

  const goPrevPage = () => {
    if (page <= 1) return;
    const newStack = [...cursorStack];
    newStack.pop();
    const prevCursor = newStack.length > 0 ? newStack[newStack.length - 1] : undefined;
    setCursorStack(newStack);
    setPage((p) => p - 1);
    setStartAfter(prevCursor);
  };

  // Group edges by axbType for display
  const groups: Record<string, GraphRecord[]> = {};
  for (const edge of edges) {
    const key = edge.axbType;
    if (!groups[key]) groups[key] = [];
    groups[key].push(edge);
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {/* Limit */}
        <div className="flex items-center gap-1.5">
          <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Show</label>
          <select
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>

        {/* axbType filter */}
        {axbTypes.length > 0 && (
          <>
            <div className="w-px h-4 bg-slate-700" />
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Type</label>
              <select
                value={filterAxbType}
                onChange={(e) => setFilterAxbType(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="">All</option>
                {axbTypes.map((ab) => (
                  <option key={ab} value={ab}>{ab}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* Sort / Filter toggle */}
        <div className="w-px h-4 bg-slate-700" />
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`px-2 py-1 border rounded text-xs transition-colors flex items-center gap-1 ${
            showFilters || sortBy || activeWhere.length > 0
              ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
              : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
          }`}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
          {activeWhere.length > 0 ? `Filter (${activeWhere.length})` : sortBy ? 'Sort' : 'Sort / Filter'}
        </button>

        {/* Pagination */}
        <div className="w-px h-4 bg-slate-700" />
        <div className="flex items-center gap-1.5">
          <button
            onClick={goPrevPage}
            disabled={page <= 1 || loading}
            className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Prev
          </button>
          <span className="text-xs text-slate-400 px-1">Page {page}</span>
          <button
            onClick={goNextPage}
            disabled={!hasMore || loading}
            className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>

        {/* Refresh */}
        <button
          onClick={() => { setPage(1); setCursorStack([]); setStartAfter(undefined); refetchEdges(); }}
          disabled={loading}
          className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>

        {/* Expand all / Resolve all toggles */}
        <div className="w-px h-4 bg-slate-700" />
        <button
          onClick={() => setExpandAll((v) => !v)}
          className={`px-2 py-1 border rounded text-xs transition-colors ${
            expandAll
              ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
              : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
          }`}
          title={expandAll ? 'Collapse all edge details' : 'Expand all edge details'}
        >
          {expandAll ? 'Collapse all' : 'Expand all'}
        </button>
        <button
          onClick={() => setResolveAll((v) => !v)}
          className={`px-2 py-1 border rounded text-xs transition-colors ${
            resolveAll
              ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
              : 'bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700'
          }`}
          title={resolveAll ? 'Stop resolving target nodes' : 'Resolve all target nodes inline'}
        >
          {resolving ? (
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 border border-indigo-400 border-t-transparent rounded-full animate-spin" />
              Resolving...
            </span>
          ) : resolveAll ? (
            'Resolved'
          ) : (
            'Resolve all'
          )}
        </button>
      </div>

      {/* Sort / Filter panel */}
      {showFilters && (
        <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-3 mb-3 space-y-3">
          {/* Sort */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold w-10">Sort</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="">Default (axbType)</option>
              {builtinFields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
              {dataFields.length > 0 && (
                <optgroup label="Data fields">
                  {dataFields.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <select
              value={sortDir}
              onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="asc">asc</option>
              <option value="desc">desc</option>
            </select>
          </div>

          {/* Active where clauses */}
          {activeWhere.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {activeWhere.map((clause, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 border border-indigo-500/30 rounded text-[11px] text-indigo-300"
                >
                  <span className="font-mono">{clause.field}</span>
                  <span className="text-indigo-400">{clause.op}</span>
                  <span className="font-mono">{String(clause.value)}</span>
                  <button
                    onClick={() => setActiveWhere((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-0.5 text-indigo-400 hover:text-red-400 transition-colors"
                  >
                    &times;
                  </button>
                </span>
              ))}
              <button
                onClick={() => setActiveWhere([])}
                className="text-[10px] text-slate-500 hover:text-red-400 transition-colors"
              >
                Clear all
              </button>
            </div>
          )}

          {/* Add where clause */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold w-10">Where</label>
            <select
              value={whereField}
              onChange={(e) => setWhereField(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="">Field...</option>
              {builtinFields.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
              {dataFields.length > 0 && (
                <optgroup label="Data fields">
                  {dataFields.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </optgroup>
              )}
            </select>
            <select
              value={whereOp}
              onChange={(e) => setWhereOp(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {['==', '!=', '<', '<=', '>', '>='].map((op) => (
                <option key={op} value={op}>{op}</option>
              ))}
            </select>
            <input
              type="text"
              value={whereValue}
              onChange={(e) => setWhereValue(e.target.value)}
              placeholder="value"
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 w-28"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && whereField && whereValue) {
                  let coerced: string | number | boolean = whereValue;
                  if (whereValue === 'true') coerced = true;
                  else if (whereValue === 'false') coerced = false;
                  else if (!isNaN(Number(whereValue)) && whereValue.trim() !== '') coerced = Number(whereValue);
                  setActiveWhere((prev) => [...prev, { field: whereField, op: whereOp, value: coerced }]);
                  setWhereValue('');
                }
              }}
            />
            <button
              onClick={() => {
                if (!whereField || !whereValue) return;
                let coerced: string | number | boolean = whereValue;
                if (whereValue === 'true') coerced = true;
                else if (whereValue === 'false') coerced = false;
                else if (!isNaN(Number(whereValue)) && whereValue.trim() !== '') coerced = Number(whereValue);
                setActiveWhere((prev) => [...prev, { field: whereField, op: whereOp, value: coerced }]);
                setWhereValue('');
              }}
              disabled={!whereField || !whereValue}
              className="px-2 py-1 bg-indigo-600/30 text-indigo-300 rounded text-xs hover:bg-indigo-600/40 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Add
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-2 mb-3 text-xs text-red-400">
          {error}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 py-6 justify-center">
          <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-xs">Loading edges...</span>
        </div>
      ) : edges.length === 0 ? (
        <p className="text-sm text-slate-500">No {direction === 'out' ? 'outgoing' : 'incoming'} edges{filterAxbType ? ` of type "${filterAxbType}"` : ''}</p>
      ) : (
        <div className="space-y-4">
          {Object.entries(groups).map(([axbType, groupEdges]) => (
            <EdgeGroup
              key={axbType}
              axbType={axbType}
              edges={groupEdges}
              direction={direction}
              inverseLabel={direction === 'in' ? inverseLabelMap[axbType] : undefined}
              canWrite={canWrite}
              onDeleteEdge={onDeleteEdge}
              expandAll={expandAll}
              resolveAll={resolveAll}
              resolvedNodes={resolvedNodes}
              viewRegistry={viewRegistry}
              config={config}
            />
          ))}
        </div>
      )}

      {/* Bottom pagination */}
      {edges.length > 0 && (hasMore || page > 1) && (
        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-slate-500">
            {edges.length} edge{edges.length !== 1 ? 's' : ''} on this page
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={goPrevPage}
              disabled={page <= 1 || loading}
              className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Previous
            </button>
            <span className="text-[10px] text-slate-400 px-1">Page {page}</span>
            <button
              onClick={goNextPage}
              disabled={!hasMore || loading}
              className="px-2 py-1 bg-slate-800 text-slate-300 rounded text-xs hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Edge Group (per axbType) ---

function EdgeGroup({
  axbType,
  edges,
  direction,
  inverseLabel,
  canWrite,
  onDeleteEdge,
  expandAll,
  resolveAll,
  resolvedNodes,
  viewRegistry,
  config,
}: {
  axbType: string;
  edges: GraphRecord[];
  direction: 'in' | 'out';
  inverseLabel?: string;
  canWrite: boolean;
  onDeleteEdge: (edge: GraphRecord) => void;
  expandAll: boolean;
  resolveAll: boolean;
  resolvedNodes: Record<string, GraphRecord | null>;
  viewRegistry?: ViewRegistryData | null;
  config: AppConfig;
}) {
  const [groupEdgeView, setGroupEdgeView] = useState('');
  const [groupNodeView, setGroupNodeView] = useState('');
  const [groupExpand, setGroupExpand] = useState(false);
  const [groupResolve, setGroupResolve] = useState(false);
  const [groupResolvedNodes, setGroupResolvedNodes] = useState<Record<string, GraphRecord | null>>({});

  const effectiveExpand = expandAll || groupExpand;
  const effectiveResolve = resolveAll || groupResolve;
  const [groupNodeVisible, setGroupNodeVisible] = useState(true);

  const edgeViews = viewRegistry?.edges[axbType]?.views ?? [];

  // Collect node views for target types in this group
  const nodeViews = useMemo(() => {
    const seen = new Map<string, ViewMeta>();
    if (!viewRegistry) return [];
    for (const edge of edges) {
      const targetType = direction === 'out' ? edge.bType : edge.aType;
      for (const v of viewRegistry.nodes[targetType]?.views ?? []) {
        if (!seen.has(v.viewName)) seen.set(v.viewName, v);
      }
    }
    return [...seen.values()];
  }, [viewRegistry, edges, direction]);

  // Batch resolve target nodes for this group when groupResolve is toggled
  const allResolvedNodes = { ...resolvedNodes, ...groupResolvedNodes };
  const toResolveUids = groupResolve && !resolveAll && edges.length > 0
    ? [...new Set(edges.map((e) => (direction === 'out' ? e.bUid : e.aUid)))].filter((u) => !(u in allResolvedNodes))
    : [];

  const { data: batchData, isFetching: groupResolving } = trpc.getNodesBatch.useQuery(
    { uids: toResolveUids },
    { enabled: toResolveUids.length > 0 },
  );

  useEffect(() => {
    if (!batchData) return;
    const mapped: Record<string, GraphRecord | null> = {};
    for (const [k, v] of Object.entries(batchData.nodes)) {
      mapped[k] = v as GraphRecord | null;
    }
    setGroupResolvedNodes((prev) => ({ ...prev, ...mapped }));
  }, [batchData]);

  return (
    <div>
      <div className="text-xs font-mono mb-2 flex items-center gap-2">
        {direction === 'out' ? (
          <>
            <span className="text-slate-500">&mdash;</span>
            <span className="text-indigo-400">{axbType}</span>
            <span className="text-slate-500">&rarr;</span>
          </>
        ) : inverseLabel ? (
          <>
            <span className="text-slate-500">&mdash;</span>
            <span className="text-amber-400 cursor-help" title={`Inverse of: ${axbType}`}>{inverseLabel}</span>
            <span className="text-slate-500">&rarr;</span>
          </>
        ) : (
          <>
            <span className="text-slate-500">&larr;</span>
            <span className="text-indigo-400">{axbType}</span>
            <span className="text-slate-500">&mdash;</span>
          </>
        )}
        <span className="text-slate-600 text-[10px]">({edges.length})</span>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Group expand toggle — icon button */}
          <button
            onClick={() => setGroupExpand((v) => !v)}
            className={`p-1 border rounded transition-colors ${
              effectiveExpand
                ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700'
            }`}
            title={effectiveExpand ? 'Collapse edges' : 'Expand edges'}
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              {effectiveExpand
                ? <path strokeLinecap="round" strokeLinejoin="round" d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" />
                : <path strokeLinecap="round" strokeLinejoin="round" d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              }
            </svg>
          </button>

          {/* Group resolve toggle — icon button */}
          <button
            onClick={() => {
              if (effectiveResolve) {
                // Already resolved — toggle node data visibility
                setGroupNodeVisible((v) => !v);
              } else {
                setGroupResolve(true);
                setGroupNodeVisible(true);
              }
            }}
            className={`p-1 border rounded transition-colors ${
              effectiveResolve
                ? groupNodeVisible
                  ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-300'
                  : 'bg-slate-800 border-indigo-500/50 text-slate-500 hover:text-slate-300'
                : 'bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300 hover:bg-slate-700'
            }`}
            title={effectiveResolve ? (groupNodeVisible ? 'Hide node data' : 'Show node data') : 'Resolve target nodes'}
            aria-label={effectiveResolve ? (groupNodeVisible ? 'Hide node data' : 'Show node data') : 'Resolve target nodes'}
          >
            {groupResolving ? (
              <span className="w-3 h-3 border-[1.5px] border-indigo-400 border-t-transparent rounded-full animate-spin block" />
            ) : effectiveResolve && groupNodeVisible ? (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M3 3l18 18" />
              </svg>
            ) : (
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
            )}
          </button>

          {/* Edge view dropdown with icon inside */}
          {edgeViews.length > 0 && (
            <span className="relative inline-flex items-center">
              <svg className="w-3 h-3 text-slate-500 absolute left-1.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 12h14" />
              </svg>
              <select
                value={groupEdgeView}
                onChange={(e) => setGroupEdgeView(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded pl-6 pr-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:border-indigo-500 appearance-none"
                style={{ direction: 'rtl' }}
                title="Edge data view"
              >
                <option value="" dir="ltr">default</option>
                <option value="json" dir="ltr">JSON</option>
                {edgeViews.map((v) => (
                  <option key={v.viewName} value={v.viewName} dir="ltr">{v.viewName}</option>
                ))}
              </select>
            </span>
          )}

          {/* Node view dropdown with icon inside */}
          {nodeViews.length > 0 && (
            <span className="relative inline-flex items-center">
              <svg className="w-3 h-3 text-slate-500 absolute left-1.5 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="8" />
              </svg>
              <select
                value={groupNodeView}
                onChange={(e) => setGroupNodeView(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded pl-6 pr-1.5 py-0.5 text-[10px] text-slate-300 focus:outline-none focus:border-indigo-500 appearance-none"
                style={{ direction: 'rtl' }}
                title="Node data view"
              >
                <option value="" dir="ltr">default</option>
                <option value="json" dir="ltr">JSON</option>
                {nodeViews.map((v) => (
                  <option key={v.viewName} value={v.viewName} dir="ltr">{v.viewName}</option>
                ))}
              </select>
            </span>
          )}
        </div>
      </div>
      <div className="space-y-1">
        {edges.map((edge, i) => {
          const targetUid = direction === 'out' ? edge.bUid : edge.aUid;
          const targetType = direction === 'out' ? edge.bType : edge.aType;
          return (
            <EdgeRow
              key={i}
              edge={edge}
              targetUid={targetUid}
              targetType={targetType}
              direction={direction}
              canWrite={canWrite}
              onDelete={() => onDeleteEdge(edge)}
              expandAllActive={effectiveExpand}
              resolvedNode={allResolvedNodes[targetUid]}
              resolveAllActive={effectiveResolve}
              edgeViews={viewRegistry?.edges[edge.axbType]?.views ?? []}
              nodeViews={viewRegistry?.nodes[targetType]?.views ?? []}
              config={config}
              groupEdgeView={groupEdgeView}
              groupNodeView={groupNodeView}
              groupNodeVisible={groupNodeVisible}
            />
          );
        })}
      </div>
    </div>
  );
}

// --- Edge Row ---

function EdgeRow({
  edge,
  targetUid,
  targetType,
  direction,
  canWrite,
  onDelete,
  expandAllActive,
  resolvedNode,
  resolveAllActive,
  edgeViews = [],
  nodeViews = [],
  config,
  groupEdgeView = '',
  groupNodeView = '',
  groupNodeVisible = true,
}: {
  edge: GraphRecord;
  targetUid: string;
  targetType: string;
  direction: 'in' | 'out';
  canWrite: boolean;
  onDelete: () => void;
  expandAllActive?: boolean;
  resolvedNode?: GraphRecord | null;
  resolveAllActive?: boolean;
  edgeViews?: ViewMeta[];
  nodeViews?: ViewMeta[];
  config: AppConfig;
  groupEdgeView?: string;
  groupNodeView?: string;
  groupNodeVisible?: boolean;
}) {
  const { drillIn } = useDrill();
  const utils = trpc.useUtils();
  const [expandedLocal, setExpandedLocal] = useState(false);
  const expanded = expandedLocal || !!expandAllActive;
  const [nodeExpanded, setNodeExpanded] = useState(false);

  // Resolve initial edge view from config defaults
  const initialEdgeView = () => {
    const rc = config.viewDefaults?.edges?.[edge.axbType];
    if (rc && edgeViews.length > 0) {
      const resolved = resolveViewForEntity(rc, edgeViews, 'inline');
      if (resolved !== 'json') {
        const match = edgeViews.find((v) => v.viewName === resolved);
        if (match) return match.tagName;
      }
    }
    return 'json';
  };
  const [localEdgeView, setLocalEdgeView] = useState(initialEdgeView);

  // Resolve initial node view from config defaults
  const initialNodeView = () => {
    const rc = config.viewDefaults?.nodes?.[targetType];
    if (rc && nodeViews.length > 0) {
      const resolved = resolveViewForEntity(rc, nodeViews, 'inline');
      if (resolved !== 'json') {
        const match = nodeViews.find((v) => v.viewName === resolved);
        if (match) return match.tagName;
      }
    }
    return 'json';
  };
  const [localNodeView, setLocalNodeView] = useState(initialNodeView);

  // Group view overrides local when set; resolve viewName → tagName for this row's entity type
  const resolveGroupView = (groupView: string, views: ViewMeta[], fallback: string) => {
    if (!groupView) return fallback;
    if (groupView === 'json') return 'json';
    const match = views.find((v) => v.viewName === groupView);
    return match ? match.tagName : fallback;
  };
  const edgeViewMode = resolveGroupView(groupEdgeView, edgeViews, localEdgeView);
  const setEdgeViewMode = setLocalEdgeView;
  const nodeViewMode = resolveGroupView(groupNodeView, nodeViews, localNodeView);
  const setNodeViewMode = setLocalNodeView;
  const [nodeData, setNodeData] = useState<GraphRecord | null | undefined>(undefined);
  const [nodeLoading, setNodeLoading] = useState(false);
  const hasData = Object.keys(edge.data).length > 0;

  // Effective resolved node: per-row fetch takes priority over batch
  const effectiveNode = nodeData !== undefined ? nodeData : resolvedNode;
  const isResolved = effectiveNode !== undefined;

  // Auto-expand when resolve-all provides data, and resolve view from config
  useEffect(() => {
    if (resolveAllActive && resolvedNode !== undefined) {
      setNodeExpanded(true);
      if (resolvedNode) {
        const rc = config.viewDefaults?.nodes?.[targetType];
        if (rc && nodeViews.length > 0) {
          const resolved = resolveViewForEntity(rc, nodeViews, 'inline');
          if (resolved !== 'json') {
            const match = nodeViews.find((v) => v.viewName === resolved);
            if (match) setNodeViewMode(match.tagName);
          }
        }
      }
    }
  }, [resolveAllActive, resolvedNode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResolve = async () => {
    setNodeLoading(true);
    try {
      const result = await utils.getNodesBatch.fetch({ uids: [targetUid] });
      const resolved = (result.nodes[targetUid] as GraphRecord | null) ?? null;
      setNodeData(resolved);
      setNodeExpanded(true);
      if (resolved) {
        const rc = config.viewDefaults?.nodes?.[targetType];
        if (rc && nodeViews.length > 0) {
          const viewName = resolveViewForEntity(rc, nodeViews, 'inline');
          if (viewName !== 'json') {
            const match = nodeViews.find((v) => v.viewName === viewName);
            if (match) setNodeViewMode(match.tagName);
          }
        }
      }
    } catch {
      // silently fail
    } finally {
      setNodeLoading(false);
    }
  };

  const handleDive = () => {
    drillIn({
      uid: targetUid,
      nodeType: targetType,
      edgeType: edge.axbType,
      direction,
    });
  };

  return (
    <div className="bg-slate-800/50 rounded-lg">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(targetType)}`}>
          {targetType}
        </span>
        <button
          onClick={handleDive}
          className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
          title="Dive into this node"
        >
          {targetUid}
        </button>
        <Link
          to={`/node/${encodeURIComponent(targetUid)}`}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          title="Navigate to this node's page"
        >
          go to
        </Link>
        <button
          onClick={() => setExpandedLocal(!expandedLocal)}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
        >
          {expanded ? 'hide edge' : 'show edge'}
        </button>
        {!isResolved && !nodeLoading && (
          <button
            onClick={handleResolve}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            resolve
          </button>
        )}
        {nodeLoading && (
          <span className="w-2.5 h-2.5 border border-slate-400 border-t-transparent rounded-full animate-spin" />
        )}
        {isResolved && (
          <button
            onClick={() => setNodeExpanded(!nodeExpanded)}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {nodeExpanded ? 'hide node' : 'show node'}
          </button>
        )}
        {canWrite && (
          <button
            onClick={onDelete}
            className="ml-auto text-[10px] text-slate-600 hover:text-red-400 transition-colors"
          >
            delete
          </button>
        )}
      </div>
      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Edge metadata */}
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] font-mono bg-slate-950 rounded p-2">
            <span className="text-slate-500">aType</span><span className="text-slate-300">{edge.aType}</span>
            <span className="text-slate-500">aUid</span><span className="text-slate-300">{edge.aUid}</span>
            <span className="text-slate-500">axbType</span><span className="text-slate-300">{edge.axbType}</span>
            <span className="text-slate-500">bType</span><span className="text-slate-300">{edge.bType}</span>
            <span className="text-slate-500">bUid</span><span className="text-slate-300">{edge.bUid}</span>
            <span className="text-slate-500">createdAt</span><span className="text-slate-300">{formatTimestamp(edge.createdAt)}</span>
            <span className="text-slate-500">updatedAt</span><span className="text-slate-300">{formatTimestamp(edge.updatedAt)}</span>
          </div>

          {/* Edge data */}
          {hasData && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">Data</span>
                {edgeViews.length > 0 && (
                  <ViewSwitcher views={edgeViews} activeView={edgeViewMode} onSwitch={setEdgeViewMode} />
                )}
              </div>
              {edgeViewMode === 'json' ? (
                <div className="font-mono text-[11px] leading-relaxed bg-slate-950 rounded p-2 overflow-auto max-h-40">
                  <JsonView data={edge.data} defaultExpanded />
                </div>
              ) : (
                <CustomView tagName={edgeViewMode} data={edge.data as Record<string, unknown>} />
              )}
            </div>
          )}
        </div>
      )}
      {nodeExpanded && isResolved && groupNodeVisible && (
        <div className="px-3 pb-2">
          {effectiveNode === null ? (
            <p className="text-[11px] text-slate-500 italic">Node not found</p>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                  Node Data
                </span>
                <span className="text-[10px] text-slate-600">
                  {formatTimestamp(effectiveNode.updatedAt)}
                </span>
                {nodeViews.length > 0 && (
                  <ViewSwitcher views={nodeViews} activeView={nodeViewMode} onSwitch={setNodeViewMode} />
                )}
              </div>
              {nodeViewMode === 'json' ? (
                <div className="font-mono text-[11px] leading-relaxed bg-slate-950 rounded p-2 overflow-auto max-h-40">
                  <JsonView data={effectiveNode.data} defaultExpanded />
                </div>
              ) : (
                <CustomView tagName={nodeViewMode} data={effectiveNode.data as Record<string, unknown>} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
