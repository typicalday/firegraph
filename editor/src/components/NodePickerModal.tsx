import { useState, useEffect } from 'react';
import type { Schema, GraphRecord, WhereClause, FieldMeta } from '../types';
import { trpc } from '../trpc';
import { getTypeBadgeColor, formatTimestamp, truncateData } from '../utils';

interface Props {
  /** The node type to browse */
  nodeType: string;
  schema: Schema;
  onPick: (uid: string) => void;
  onCancel: () => void;
}

const LIMIT_OPTIONS = [10, 25, 50];
const FILTER_OPS: WhereClause['op'][] = ['==', '!=', '<', '<=', '>', '>='];

function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  return raw;
}

export default function NodePickerModal({ nodeType, schema, onPick, onCancel }: Props) {
  const [limit, setLimit] = useState(10);
  const [sortBy, setSortBy] = useState('aUid');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [startAfter, setStartAfter] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<WhereClause[]>([]);
  const [showFilters, setShowFilters] = useState(false);

  const nodeSchema = schema.nodeSchemas?.find((ns) => ns.aType === nodeType && ns.isNodeEntry);
  const fieldMetas = nodeSchema?.fields ?? [];
  const fieldNames = fieldMetas.map((f) => f.name);

  const sortFieldOptions = [
    { value: 'aUid', label: 'UID' },
    { value: 'createdAt', label: 'Created' },
    { value: 'updatedAt', label: 'Updated' },
    ...fieldMetas
      .filter((f) => f.type === 'string' || f.type === 'number' || f.type === 'boolean' || f.type === 'enum')
      .map((f) => ({ value: f.name, label: `data.${f.name}` })),
  ];

  const activeFilters = filters.filter((f) => f.field && f.value !== '');
  const queryInput = {
    type: nodeType,
    limit,
    sortBy,
    sortDir: sortDir as 'asc' | 'desc',
    startAfter,
    ...(activeFilters.length > 0 ? { where: activeFilters } : {}),
  };

  const { data, isLoading: loading } = trpc.getNodes.useQuery(queryInput, {
    placeholderData: (prev) => prev,
  });

  const nodes = (data?.nodes ?? []) as unknown as GraphRecord[];
  const hasMore = data?.hasMore ?? false;
  const nextCursor = data?.nextCursor ?? null;

  useEffect(() => {
    setPage(1);
    setCursorStack([]);
    setStartAfter(undefined);
  }, [limit, sortBy, sortDir, filters]);

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
    setCursorStack(newStack);
    setPage((p) => p - 1);
    setStartAfter(newStack.length > 0 ? newStack[newStack.length - 1] : undefined);
  };

  // Close on Escape
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-2xl mx-4 shadow-2xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">Select a</h3>
            <span className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(nodeType)}`}>
              {nodeType}
            </span>
            <h3 className="text-sm font-semibold">node</h3>
          </div>
          <button onClick={onCancel} className="text-slate-500 hover:text-slate-300 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Toolbar */}
        <div className="px-5 py-3 border-b border-slate-800/50 shrink-0 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Sort */}
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Sort</label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                {sortFieldOptions.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
              <button
                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                className="px-1.5 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 hover:bg-slate-700 transition-colors"
              >
                {sortDir === 'asc' ? '\u2191' : '\u2193'}
              </button>
            </div>

            <div className="w-px h-4 bg-slate-700" />

            {/* Show */}
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

            <div className="w-px h-4 bg-slate-700" />

            {/* Pagination */}
            <div className="flex items-center gap-1">
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

            <div className="w-px h-4 bg-slate-700" />

            {/* Filter toggle */}
            {fieldNames.length > 0 && (
              <button
                onClick={() => setShowFilters(!showFilters)}
                className={`px-2 py-1 rounded text-xs flex items-center gap-1 transition-colors ${
                  showFilters || filters.length > 0
                    ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                    : 'bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700'
                }`}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
                </svg>
                Filters
                {filters.length > 0 && (
                  <span className="bg-indigo-500 text-white text-[10px] w-4 h-4 rounded-full inline-flex items-center justify-center font-bold">
                    {filters.length}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* Filter rows */}
          {showFilters && (
            <PickerFilterBuilder
              filters={filters}
              onFiltersChange={setFilters}
              fieldMetas={fieldMetas}
              fieldNames={fieldNames}
            />
          )}
        </div>

        {/* Node list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-slate-400 py-10 justify-center">
              <div className="w-3.5 h-3.5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs">Loading...</span>
            </div>
          ) : nodes.length === 0 ? (
            <div className="text-center py-10 text-slate-500 text-sm">
              No nodes found{filters.length > 0 ? ' matching filters' : ''}
            </div>
          ) : (
            <div className="divide-y divide-slate-800/50">
              {nodes.map((node) => (
                <button
                  key={node.aUid}
                  onClick={() => onPick(node.aUid)}
                  className="w-full text-left px-5 py-3 hover:bg-slate-800/50 transition-colors flex items-center gap-3 group"
                >
                  <span className="font-mono text-sm text-indigo-400 group-hover:text-indigo-300 shrink-0">
                    {node.aUid}
                  </span>
                  <span className="text-xs text-slate-500 truncate flex-1">
                    {truncateData(node.data, 80)}
                  </span>
                  <span className="text-[10px] text-slate-600 shrink-0">
                    {formatTimestamp(node.createdAt)}
                  </span>
                  <span className="text-xs text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    Select
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Inline filter builder for the picker ---

function PickerFilterBuilder({
  filters,
  onFiltersChange,
  fieldMetas,
  fieldNames,
}: {
  filters: WhereClause[];
  onFiltersChange: (filters: WhereClause[]) => void;
  fieldMetas: FieldMeta[];
  fieldNames: string[];
}) {
  const addFilter = () => {
    const defaultField = fieldNames[0] ?? '';
    const meta = fieldMetas.find((f) => f.name === defaultField);
    let defaultValue: string | number | boolean = '';
    if (meta?.type === 'boolean') defaultValue = true;
    else if (meta?.type === 'enum' && meta.enumValues?.length) defaultValue = meta.enumValues[0];
    onFiltersChange([...filters, { field: defaultField, op: '==', value: defaultValue }]);
  };

  const updateFilter = (index: number, updates: Partial<WhereClause>) => {
    const updated = [...filters];
    updated[index] = { ...updated[index], ...updates };
    onFiltersChange(updated);
  };

  const removeFilter = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  return (
    <div className="border-t border-slate-700/50 pt-2 space-y-1.5">
      {filters.map((clause, i) => {
        const meta = fieldMetas.find((f) => f.name === clause.field);
        const isEnum = meta?.type === 'enum' && meta.enumValues?.length;
        const isBool = meta?.type === 'boolean';
        return (
          <div key={i} className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-600 w-6 shrink-0 text-right">
              {i === 0 ? '' : 'AND'}
            </span>
            <select
              value={clause.field}
              onChange={(e) => {
                const m = fieldMetas.find((f) => f.name === e.target.value);
                let dv: string | number | boolean = '';
                if (m?.type === 'boolean') dv = true;
                else if (m?.type === 'enum' && m.enumValues?.length) dv = m.enumValues[0];
                updateFilter(i, { field: e.target.value, value: dv });
              }}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {fieldNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <select
              value={clause.op}
              onChange={(e) => updateFilter(i, { op: e.target.value as WhereClause['op'] })}
              className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500 w-14"
            >
              {FILTER_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
            </select>
            {isEnum ? (
              <select
                value={String(clause.value)}
                onChange={(e) => updateFilter(i, { value: e.target.value })}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                {meta!.enumValues!.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ) : isBool ? (
              <select
                value={String(clause.value)}
                onChange={(e) => updateFilter(i, { value: e.target.value === 'true' })}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            ) : (
              <input
                type="text"
                value={String(clause.value)}
                onChange={(e) => updateFilter(i, { value: coerceValue(e.target.value) })}
                placeholder="value"
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-28"
              />
            )}
            <button
              onClick={() => removeFilter(i)}
              className="text-slate-600 hover:text-red-400 transition-colors p-0.5 shrink-0"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <button
          onClick={addFilter}
          className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors py-0.5"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add filter
        </button>
        {filters.length > 0 && (
          <button
            onClick={() => onFiltersChange([])}
            className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors"
          >
            Clear all
          </button>
        )}
      </div>
    </div>
  );
}
