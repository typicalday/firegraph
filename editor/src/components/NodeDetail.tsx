import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import type { Schema, NodeDetailData, GraphRecord } from '../types';
import { getNodeDetail, deleteNode, deleteEdge } from '../api';
import { getTypeBadgeColor, formatTimestamp } from '../utils';
import JsonView from './JsonView';
import { TraversalPanel } from './TraversalBuilder';
import NodeEditor from './NodeEditor';
import EdgeEditor from './EdgeEditor';
import ConfirmDialog from './ConfirmDialog';

interface Props {
  schema: Schema;
  onDataChanged?: () => void;
}

export default function NodeDetail({ schema, onDataChanged }: Props) {
  const { uid } = useParams<{ uid: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<NodeDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showCreateEdge, setShowCreateEdge] = useState(false);
  const [deletingEdge, setDeletingEdge] = useState<{ aUid: string; abType: string; bUid: string } | null>(null);
  const [edgeDeleteLoading, setEdgeDeleteLoading] = useState(false);

  const canWrite = !schema.readonly && schema.registryAvailable;

  const loadNode = useCallback(async () => {
    if (!uid) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getNodeDetail(uid);
      setData(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [uid]);

  useEffect(() => {
    loadNode();
    setEditing(false);
    setShowCreateEdge(false);
  }, [loadNode]);

  const handleDelete = async () => {
    if (!uid) return;
    setDeleteLoading(true);
    try {
      await deleteNode(uid);
      onDataChanged?.();
      navigate('/');
    } catch (err) {
      setError(String(err));
    } finally {
      setDeleteLoading(false);
      setShowDeleteConfirm(false);
    }
  };

  const handleDeleteEdge = async () => {
    if (!deletingEdge) return;
    setEdgeDeleteLoading(true);
    try {
      await deleteEdge(deletingEdge.aUid, deletingEdge.abType, deletingEdge.bUid);
      setDeletingEdge(null);
      loadNode();
      onDataChanged?.();
    } catch (err) {
      setError(String(err));
    } finally {
      setEdgeDeleteLoading(false);
    }
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

  if (!data?.node) {
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

  const { node, outEdges, inEdges } = data;

  if (editing) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
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

  return (
    <div className="p-6 max-w-5xl mx-auto">
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
        <h2 className="text-sm font-semibold mb-3">Data</h2>
        <div className="font-mono text-xs leading-relaxed bg-slate-950 rounded-lg p-4 overflow-auto max-h-96">
          <JsonView data={node.data} defaultExpanded />
        </div>
      </section>

      {/* Outgoing Edges */}
      <section className="bg-slate-900 rounded-xl border border-slate-800 p-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">
            Outgoing Edges
            <span className="text-slate-500 font-normal ml-2">({outEdges.length})</span>
          </h2>
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
              defaultAUid={node.aUid}
              defaultAType={node.aType}
              onSaved={() => {
                setShowCreateEdge(false);
                loadNode();
                onDataChanged?.();
              }}
              onCancel={() => setShowCreateEdge(false)}
            />
          </div>
        )}
        {outEdges.length === 0 ? (
          <p className="text-sm text-slate-500">No outgoing edges</p>
        ) : (
          <EdgeTable
            edges={outEdges}
            direction="out"
            canWrite={canWrite}
            onDeleteEdge={(e) => setDeletingEdge({ aUid: e.aUid, abType: e.abType, bUid: e.bUid })}
          />
        )}
      </section>

      {/* Incoming Edges */}
      <section className="bg-slate-900 rounded-xl border border-slate-800 p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">
          Incoming Edges
          <span className="text-slate-500 font-normal ml-2">({inEdges.length})</span>
        </h2>
        {inEdges.length === 0 ? (
          <p className="text-sm text-slate-500">No incoming edges</p>
        ) : (
          <EdgeTable
            edges={inEdges}
            direction="in"
            canWrite={canWrite}
            onDeleteEdge={(e) => setDeletingEdge({ aUid: e.aUid, abType: e.abType, bUid: e.bUid })}
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
          <TraversalPanel schema={schema} startUid={node.aUid} />
        </section>
      )}

      {/* Delete node dialog */}
      {showDeleteConfirm && (
        <ConfirmDialog
          title="Delete Node"
          message={`Are you sure you want to delete node "${node.aUid}" (${node.aType})? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
          loading={deleteLoading}
        />
      )}

      {/* Delete edge dialog */}
      {deletingEdge && (
        <ConfirmDialog
          title="Delete Edge"
          message={`Delete edge ${deletingEdge.aUid} —[${deletingEdge.abType}]→ ${deletingEdge.bUid}?`}
          onConfirm={handleDeleteEdge}
          onCancel={() => setDeletingEdge(null)}
          loading={edgeDeleteLoading}
        />
      )}
    </div>
  );
}

function EdgeTable({
  edges,
  direction,
  canWrite,
  onDeleteEdge,
}: {
  edges: GraphRecord[];
  direction: 'in' | 'out';
  canWrite: boolean;
  onDeleteEdge: (edge: GraphRecord) => void;
}) {
  // Group edges by abType
  const groups: Record<string, GraphRecord[]> = {};
  for (const edge of edges) {
    const key = edge.abType;
    if (!groups[key]) groups[key] = [];
    groups[key].push(edge);
  }

  return (
    <div className="space-y-4">
      {Object.entries(groups).map(([abType, groupEdges]) => (
        <div key={abType}>
          <h3 className="text-xs text-indigo-400 font-mono mb-2 flex items-center gap-2">
            {direction === 'out' ? (
              <>
                <span className="text-slate-500">&mdash;</span>
                {abType}
                <span className="text-slate-500">&rarr;</span>
              </>
            ) : (
              <>
                <span className="text-slate-500">&larr;</span>
                {abType}
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
                  canWrite={canWrite}
                  onDelete={() => onDeleteEdge(edge)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function EdgeRow({
  edge,
  targetUid,
  targetType,
  canWrite,
  onDelete,
}: {
  edge: GraphRecord;
  targetUid: string;
  targetType: string;
  canWrite: boolean;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasData = Object.keys(edge.data).length > 0;

  return (
    <div className="bg-slate-800/50 rounded-lg">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(targetType)}`}>
          {targetType}
        </span>
        <Link
          to={`/node/${encodeURIComponent(targetUid)}`}
          className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          {targetUid}
        </Link>
        {hasData && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {expanded ? 'hide data' : 'show data'}
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
          <div className="font-mono text-[11px] leading-relaxed bg-slate-950 rounded p-2 overflow-auto max-h-40">
            <JsonView data={edge.data} defaultExpanded />
          </div>
        </div>
      )}
    </div>
  );
}
