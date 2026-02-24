import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
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
          <div className="bg-slate-950 rounded-lg p-4 overflow-auto">
            <CustomView tagName={activeView} data={node.data as Record<string, unknown>} />
          </div>
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
}) {
  // Toolbar state
  const [limit, setLimit] = useState(25);
  const [filterAxbType, setFilterAxbType] = useState('');
  const [page, setPage] = useState(1);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [startAfter, setStartAfter] = useState<string | undefined>(undefined);

  // Resolve state
  const [resolveAll, setResolveAll] = useState(false);
  const [resolvedNodes, setResolvedNodes] = useState<Record<string, GraphRecord | null>>({});

  const edgeQueryInput = {
    ...(direction === 'out' ? { aUid: uid } : { bUid: uid }),
    ...(filterAxbType ? { axbType: filterAxbType } : {}),
    limit,
    startAfter,
  };

  const { data: edgeData, isLoading: loading, error: queryError, refetch: refetchEdges } = trpc.getEdges.useQuery(
    edgeQueryInput,
    { placeholderData: (prev) => prev },
  );

  const edges = (edgeData?.edges ?? []) as GraphRecord[];
  const hasMore = edgeData?.hasMore ?? false;
  const nextCursor = edgeData?.nextCursor ?? null;
  const error = queryError?.message ?? null;

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
  }, [uid, direction, limit, filterAxbType, reloadKey]);

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

        {/* Resolve all toggle */}
        <div className="w-px h-4 bg-slate-700" />
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
          {Object.entries(groups).map(([axbType, groupEdges]) => {
            const inverseLabel = direction === 'in' ? inverseLabelMap[axbType] : undefined;
            return (
            <div key={axbType}>
              <h3 className="text-xs font-mono mb-2 flex items-center gap-2">
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
                <span className="text-slate-600 text-[10px]">({groupEdges.length})</span>
              </h3>
              <div className="space-y-1">
                {groupEdges.map((edge, i) => {
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
                      resolvedNode={resolvedNodes[targetUid]}
                      resolveAllActive={resolveAll}
                      edgeViews={viewRegistry?.edges[edge.axbType]?.views ?? []}
                      nodeViews={viewRegistry?.nodes[targetType]?.views ?? []}
                      config={config}
                    />
                  );
                })}
              </div>
            </div>
          );
          })}
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

// --- Edge Row ---

function EdgeRow({
  edge,
  targetUid,
  targetType,
  direction,
  canWrite,
  onDelete,
  resolvedNode,
  resolveAllActive,
  edgeViews = [],
  nodeViews = [],
  config,
}: {
  edge: GraphRecord;
  targetUid: string;
  targetType: string;
  direction: 'in' | 'out';
  canWrite: boolean;
  onDelete: () => void;
  resolvedNode?: GraphRecord | null;
  resolveAllActive?: boolean;
  edgeViews?: ViewMeta[];
  nodeViews?: ViewMeta[];
  config: AppConfig;
}) {
  const { drillIn } = useDrill();
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
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
  const [edgeViewMode, setEdgeViewMode] = useState(initialEdgeView);

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
  const [nodeViewMode, setNodeViewMode] = useState(initialNodeView);
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
        {hasData && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {expanded ? 'hide edge' : 'show edge'}
          </button>
        )}
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
      {expanded && hasData && (
        <div className="px-3 pb-2">
          {edgeViews.length > 0 && (
            <div className="mb-2">
              <ViewSwitcher views={edgeViews} activeView={edgeViewMode} onSwitch={setEdgeViewMode} />
            </div>
          )}
          {edgeViewMode === 'json' ? (
            <div className="font-mono text-[11px] leading-relaxed bg-slate-950 rounded p-2 overflow-auto max-h-40">
              <JsonView data={edge.data} defaultExpanded />
            </div>
          ) : (
            <div className="bg-slate-950 rounded p-2 overflow-auto">
              <CustomView tagName={edgeViewMode} data={edge.data as Record<string, unknown>} />
            </div>
          )}
        </div>
      )}
      {nodeExpanded && isResolved && (
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
                <div className="bg-slate-950 rounded p-2 overflow-auto">
                  <CustomView tagName={nodeViewMode} data={effectiveNode.data as Record<string, unknown>} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
