import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import type { Schema, GraphRecord } from '../types';
import { getNodes } from '../api';
import { getTypeBadgeColor, formatTimestamp, truncateData } from '../utils';
import NodeEditor from './NodeEditor';

interface Props {
  schema: Schema;
  onDataChanged?: () => void;
}

export default function NodeBrowser({ schema, onDataChanged }: Props) {
  const { type } = useParams<{ type: string }>();
  const navigate = useNavigate();
  const [nodes, setNodes] = useState<GraphRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const loadNodes = useCallback(async () => {
    if (!type) return;
    setLoading(true);
    setError(null);
    try {
      const result = await getNodes(type);
      setNodes(result.nodes);
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    loadNodes();
    setShowCreate(false);
  }, [loadNodes]);

  const loadMore = async () => {
    if (!type || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await getNodes(type, 50, nextCursor);
      setNodes((prev) => [...prev, ...result.nodes]);
      setHasMore(result.hasMore);
      setNextCursor(result.nextCursor);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const nodeTypeMeta = schema.nodeTypes.find((nt) => nt.type === type);
  const canWrite = !schema.readonly && schema.registryAvailable;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold">{type}</h1>
          <span className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(type!)}`}>
            node
          </span>
          {nodeTypeMeta && (
            <span className="text-xs text-slate-500">
              ~{nodeTypeMeta.count} found
            </span>
          )}
          {canWrite && !showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="ml-auto px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-500 transition-colors flex items-center gap-1.5"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Create {type}
            </button>
          )}
        </div>
        <p className="text-sm text-slate-400">
          Browse all <strong>{type}</strong> nodes
        </p>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-6">
          <NodeEditor
            schema={schema}
            defaultType={type}
            onSaved={(uid) => {
              setShowCreate(false);
              onDataChanged?.();
              navigate(`/node/${encodeURIComponent(uid)}`);
            }}
            onCancel={() => setShowCreate(false)}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-400 py-12 justify-center">
          <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading nodes...</span>
        </div>
      ) : nodes.length === 0 ? (
        <div className="text-center py-12 text-slate-500">
          <p>No nodes found of type "{type}"</p>
        </div>
      ) : (
        <>
          {/* Table */}
          <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3">
                    UID
                  </th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3">
                    Data
                  </th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3 w-44">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr
                    key={node.aUid}
                    className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        to={`/node/${encodeURIComponent(node.aUid)}`}
                        className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                      >
                        {node.aUid}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-slate-400 font-mono">
                        {truncateData(node.data, 100)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      {formatTimestamp(node.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Load More */}
          {hasMore && (
            <div className="mt-4 text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg text-sm hover:bg-slate-700 transition-colors disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
