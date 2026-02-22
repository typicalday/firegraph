import { useParams, Link, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import type { Schema, GraphRecord } from '../types';
import { trpc } from '../trpc';
import { getTypeBadgeColor, formatTimestamp, truncateData } from '../utils';
import NodeEditor from './NodeEditor';

interface Props {
  schema: Schema;
  onDataChanged?: () => void;
}

const LIMIT_OPTIONS = [10, 25, 50, 100];
const SORT_FIELDS = [
  { value: 'aUid', label: 'UID' },
  { value: 'createdAt', label: 'Created' },
  { value: 'updatedAt', label: 'Updated' },
];
const FILTER_OPS = ['==', '!=', '<', '<=', '>', '>='];

export default function NodeBrowser({ schema, onDataChanged }: Props) {
  const { type } = useParams<{ type: string }>();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  // Toolbar state
  const [limit, setLimit] = useState(25);
  const [sortBy, setSortBy] = useState('aUid');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterField, setFilterField] = useState('');
  const [filterOp, setFilterOp] = useState('==');
  const [filterValue, setFilterValue] = useState('');
  const [activeFilter, setActiveFilter] = useState<{ field: string; op: string; value: string } | null>(null);

  // Pagination state
  const [page, setPage] = useState(1);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [startAfter, setStartAfter] = useState<string | undefined>(undefined);

  const queryInput = {
    type,
    limit,
    sortBy,
    sortDir: sortDir as 'asc' | 'desc',
    startAfter,
    ...(activeFilter ? {
      filterField: activeFilter.field,
      filterOp: activeFilter.op,
      filterValue: activeFilter.value,
    } : {}),
  };

  const { data, isLoading: loading, error: queryError, refetch } = trpc.getNodes.useQuery(queryInput, {
    placeholderData: (prev) => prev,
  });

  const nodes = (data?.nodes ?? []) as GraphRecord[];
  const hasMore = data?.hasMore ?? false;
  const nextCursor = data?.nextCursor ?? null;
  const error = queryError?.message ?? null;

  // Reset pagination when type/limit/sort/filter changes
  useEffect(() => {
    setPage(1);
    setCursorStack([]);
    setStartAfter(undefined);
    setShowCreate(false);
  }, [type, limit, sortBy, sortDir, activeFilter]);

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

  const handleAddFilter = () => {
    if (!filterField.trim() || !filterValue.trim()) return;
    setActiveFilter({ field: filterField.trim(), op: filterOp, value: filterValue.trim() });
  };

  const handleRemoveFilter = () => {
    setActiveFilter(null);
    setFilterField('');
    setFilterOp('==');
    setFilterValue('');
  };

  const handleRefresh = () => {
    setPage(1);
    setCursorStack([]);
    setStartAfter(undefined);
    refetch();
  };

  // Get field names from schema for the filter dropdown
  const nodeSchema = schema.nodeSchemas?.find((ns) => ns.aType === type && ns.isNodeEntry);
  const fieldNames = nodeSchema?.fields?.map((f) => f.name) ?? [];

  const canWrite = !schema.readonly;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold">{type}</h1>
          <span className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(type!)}`}>
            node
          </span>
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

      {/* Toolbar */}
      <div className="bg-slate-900 rounded-xl border border-slate-800 p-3 mb-4 space-y-3">
        {/* Row 1: Limit, Sort, Refresh */}
        <div className="flex items-center gap-3 flex-wrap">
          {/* Limit */}
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Show</label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div className="w-px h-5 bg-slate-700" />

          {/* Sort */}
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Sort</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {SORT_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
              className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:bg-slate-700 transition-colors"
              title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
            >
              {sortDir === 'asc' ? '\u2191 Asc' : '\u2193 Desc'}
            </button>
          </div>

          <div className="w-px h-5 bg-slate-700" />

          {/* Pagination */}
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
            onClick={handleRefresh}
            disabled={loading}
            className="ml-auto px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
            title="Refresh"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Row 2: Filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Filter</label>
          {fieldNames.length > 0 ? (
            <select
              value={filterField}
              onChange={(e) => setFilterField(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              <option value="">Field...</option>
              {fieldNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={filterField}
              onChange={(e) => setFilterField(e.target.value)}
              placeholder="data.field"
              className="w-28 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
            />
          )}
          <select
            value={filterOp}
            onChange={(e) => setFilterOp(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            {FILTER_OPS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={filterValue}
            onChange={(e) => setFilterValue(e.target.value)}
            placeholder="value"
            className="w-32 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500"
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddFilter();
            }}
          />
          <button
            onClick={handleAddFilter}
            disabled={!filterField.trim() || filterValue.trim() === ''}
            className="px-2 py-1 bg-indigo-600/20 text-indigo-400 rounded text-xs hover:bg-indigo-600/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Apply
          </button>

          {/* Active filter chip */}
          {activeFilter && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 text-indigo-300 rounded text-xs">
              {activeFilter.field} {activeFilter.op} {activeFilter.value}
              <button
                onClick={handleRemoveFilter}
                className="ml-0.5 text-indigo-400 hover:text-indigo-200"
              >
                &times;
              </button>
            </span>
          )}
        </div>
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
          <p>No nodes found{activeFilter ? ' matching filter' : ` of type "${type}"`}</p>
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

          {/* Bottom pagination */}
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-slate-500">
              {nodes.length} result{nodes.length !== 1 ? 's' : ''} on this page
            </span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={goPrevPage}
                disabled={page <= 1 || loading}
                className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-xs hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Previous
              </button>
              <span className="text-xs text-slate-400 px-2">Page {page}</span>
              <button
                onClick={goNextPage}
                disabled={!hasMore || loading}
                className="px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-xs hover:bg-slate-700 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
