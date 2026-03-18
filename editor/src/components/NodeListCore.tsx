import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { Schema, GraphRecord, ViewRegistryData, AppConfig, FieldMeta, WhereClause } from '../types';
import { trpc } from '../trpc';
import { formatTimestamp, truncateData, resolveViewForEntity, scopeInput } from '../utils';
import { useScope } from './scope-context';
import CustomView from './CustomView';

export interface NodeListCoreProps {
  /** The node type to browse */
  type: string;
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
  /** When provided, rows become pick-able buttons instead of links. */
  onPick?: (uid: string) => void;
  /** Compact mode — smaller padding, constrained height, no bottom pagination */
  compact?: boolean;
}

const LIMIT_OPTIONS = [10, 25, 50, 100];

const BUILTIN_SORT_FIELDS = [
  { value: 'aUid', label: 'UID' },
  { value: 'createdAt', label: 'Created' },
  { value: 'updatedAt', label: 'Updated' },
];

const FILTER_OPS: WhereClause['op'][] = ['==', '!=', '<', '<=', '>', '>='];

/** Coerce a raw string into the appropriate type for a filter value */
function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  return raw;
}

export default function NodeListCore({
  type,
  schema,
  viewRegistry,
  config,
  onPick,
  compact = false,
}: NodeListCoreProps) {
  const { scopePath, scopedPath } = useScope();
  const defaultLimit = compact ? 10 : 25;

  // Toolbar state
  const [limit, setLimit] = useState(defaultLimit);
  const [sortBy, setSortBy] = useState('aUid');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // Multi-filter state
  const [filters, setFilters] = useState<WhereClause[]>([]);
  const [showFilterBuilder, setShowFilterBuilder] = useState(false);

  // Pagination state
  const [page, setPage] = useState(1);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [startAfter, setStartAfter] = useState<string | undefined>(undefined);

  // Only send filters that have a non-empty value to the backend
  const activeFilters = filters.filter((f) => f.field && f.value !== '');
  const queryInput = {
    type,
    limit,
    sortBy,
    sortDir: sortDir as 'asc' | 'desc',
    startAfter,
    ...(activeFilters.length > 0 ? { where: activeFilters } : {}),
    ...scopeInput(scopePath),
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
  }, [type, limit, sortBy, sortDir, filters, scopePath]);

  // Reset filters when type changes
  useEffect(() => {
    setFilters([]);
    setSortBy('aUid');
    setSortDir('asc');
    setShowFilterBuilder(false);
  }, [type]);

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

  const handleRefresh = () => {
    setPage(1);
    setCursorStack([]);
    setStartAfter(undefined);
    refetch();
  };

  // Get field metadata from schema for this type
  const nodeSchema = schema.nodeSchemas?.find((ns) => ns.aType === type && ns.isNodeEntry);
  const fieldMetas = nodeSchema?.fields ?? [];
  const fieldNames = fieldMetas.map((f) => f.name);

  // Build sort field options: builtins + data fields from schema
  const sortFieldOptions = [
    ...BUILTIN_SORT_FIELDS,
    ...fieldMetas
      .filter((f) => f.type === 'string' || f.type === 'number' || f.type === 'boolean' || f.type === 'enum')
      .map((f) => ({ value: f.name, label: `data.${f.name}` })),
  ];

  // View setup for listing rows
  const listingViews = viewRegistry?.nodes[type]?.views ?? [];
  const listingResolverConfig = config?.viewDefaults?.nodes?.[type];

  const limitOptions = compact ? [10, 25, 50] : LIMIT_OPTIONS;

  return (
    <div>
      {/* Toolbar */}
      <div className={`bg-slate-900 rounded-xl border border-slate-800 ${compact ? 'p-2' : 'p-3'} mb-4 space-y-3`}>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Limit */}
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Show</label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
            >
              {limitOptions.map((n) => (
                <option key={n} value={n}>{n}</option>
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
              {sortFieldOptions.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
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

          <div className="w-px h-5 bg-slate-700" />

          {/* Filter toggle */}
          <button
            onClick={() => setShowFilterBuilder(!showFilterBuilder)}
            className={`px-2 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
              showFilterBuilder || filters.length > 0
                ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                : 'bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700'
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Filters
            {filters.length > 0 && (
              <span className="bg-indigo-500 text-white text-[10px] w-4 h-4 rounded-full inline-flex items-center justify-center font-bold">
                {filters.length}
              </span>
            )}
          </button>

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

        {/* Active filter chips */}
        {filters.length > 0 && !showFilterBuilder && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Active</span>
            {filters.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 text-indigo-300 rounded text-xs">
                <span className="text-slate-400">data.</span>{f.field} {f.op}{' '}
                <span className="text-indigo-200">{String(f.value)}</span>
                <button
                  onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))}
                  className="ml-0.5 text-indigo-400 hover:text-indigo-200"
                >
                  &times;
                </button>
              </span>
            ))}
            <button
              onClick={() => setFilters([])}
              className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Filter builder panel */}
        {showFilterBuilder && (
          <FilterBuilder
            filters={filters}
            onFiltersChange={setFilters}
            fieldMetas={fieldMetas}
            fieldNames={fieldNames}
          />
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading ? (
        <div className={`flex items-center gap-2 text-slate-400 ${compact ? 'py-6' : 'py-12'} justify-center`}>
          <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading nodes...</span>
        </div>
      ) : nodes.length === 0 ? (
        <div className={`text-center ${compact ? 'py-6' : 'py-12'} text-slate-500`}>
          <p>No nodes found{filters.length > 0 ? ' matching filters' : ` of type "${type}"`}</p>
        </div>
      ) : (
        <>
          {/* Table */}
          <div className={`bg-slate-900 rounded-xl border border-slate-800 overflow-x-auto ${compact ? 'max-h-64 overflow-y-auto' : ''}`}>
            <table className="w-full min-w-[480px]">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3">
                    UID
                  </th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3">
                    Data
                  </th>
                  {!compact && (
                    <th className="text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold px-4 py-3 w-44">
                      Created
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr
                    key={node.aUid}
                    className={`border-b border-slate-800/50 transition-colors ${
                      onPick
                        ? 'hover:bg-indigo-600/10 cursor-pointer'
                        : 'hover:bg-slate-800/30'
                    }`}
                    onClick={onPick ? () => onPick(node.aUid) : undefined}
                  >
                    <td className="px-4 py-3">
                      {onPick ? (
                        <span className="text-sm font-mono text-indigo-400">
                          {node.aUid}
                        </span>
                      ) : (
                        <Link
                          to={scopedPath(`/node/${encodeURIComponent(node.aUid)}`)}
                          className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          {node.aUid}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <NodeListingCell node={node} views={listingViews} resolverConfig={listingResolverConfig} />
                    </td>
                    {!compact && (
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {formatTimestamp(node.createdAt)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Bottom pagination (full mode only) */}
          {!compact && (
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
          )}
        </>
      )}
    </div>
  );
}

// --- Filter Builder ---

/**
 * Each filter row is immediately "live" — edits to field/op trigger the query
 * right away. For text value inputs, the query fires on Enter or blur (not
 * on every keystroke) so the user can finish typing before the query runs.
 */
function FilterBuilder({
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

  const removeFilter = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, updates: Partial<WhereClause>) => {
    const updated = [...filters];
    updated[index] = { ...updated[index], ...updates };
    onFiltersChange(updated);
  };

  const getFieldMeta = (name: string) => fieldMetas.find((f) => f.name === name);

  return (
    <div className="border-t border-slate-700/50 pt-3 space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Where</span>
        <span className="text-[10px] text-slate-600">
          {filters.length === 0 ? 'No filters — click "Add filter" to start' : `${filters.length} active filter${filters.length > 1 ? 's' : ''}`}
        </span>
        {filters.length > 0 && (
          <button
            onClick={() => onFiltersChange([])}
            className="text-[10px] text-red-400/60 hover:text-red-400 transition-colors ml-auto"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Live filter rows */}
      {filters.map((clause, i) => (
        <FilterRow
          key={i}
          index={i}
          clause={clause}
          fieldNames={fieldNames}
          fieldMeta={getFieldMeta(clause.field)}
          allFieldMetas={fieldMetas}
          totalFilters={filters.length}
          onUpdate={(updates) => updateFilter(i, updates)}
          onRemove={() => removeFilter(i)}
        />
      ))}

      {/* Add filter button */}
      <button
        onClick={addFilter}
        className="flex items-center gap-1.5 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors py-1"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Add filter
      </button>
    </div>
  );
}

/**
 * A single filter row. Field/op changes apply instantly. Text value changes
 * apply on Enter or blur so users can finish typing first.
 */
function FilterRow({
  index,
  clause,
  fieldNames,
  fieldMeta,
  allFieldMetas,
  totalFilters,
  onUpdate,
  onRemove,
}: {
  index: number;
  clause: WhereClause;
  fieldNames: string[];
  fieldMeta: FieldMeta | undefined;
  allFieldMetas: FieldMeta[];
  totalFilters: number;
  onUpdate: (updates: Partial<WhereClause>) => void;
  onRemove: () => void;
}) {
  // Local text value — synced on Enter/blur, not every keystroke
  const [localValue, setLocalValue] = useState(String(clause.value));
  const inputRef = useRef<HTMLInputElement>(null);

  // Sync local value when clause value changes externally (e.g. field type change)
  useEffect(() => {
    setLocalValue(String(clause.value));
  }, [clause.value]);

  const commitTextValue = () => {
    const coerced = coerceValue(localValue.trim());
    if (coerced !== clause.value) {
      onUpdate({ value: coerced });
    }
  };

  // When field changes, reset value to a sensible default for the new field type
  const handleFieldChange = (newField: string) => {
    const meta = allFieldMetas.find((f) => f.name === newField);
    let defaultValue: string | number | boolean = '';
    if (meta?.type === 'boolean') defaultValue = true;
    else if (meta?.type === 'enum' && meta.enumValues?.length) defaultValue = meta.enumValues[0];
    onUpdate({ field: newField, value: defaultValue });
    setLocalValue(String(defaultValue));
  };

  const isEnum = fieldMeta?.type === 'enum' && fieldMeta.enumValues?.length;
  const isBool = fieldMeta?.type === 'boolean';
  const isDropdown = isEnum || isBool;

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[10px] text-slate-600 w-8 shrink-0 text-right">
        {index === 0 ? '' : 'AND'}
      </span>

      {/* Field */}
      {fieldNames.length > 0 ? (
        <select
          value={clause.field}
          onChange={(e) => handleFieldChange(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          {fieldNames.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={clause.field}
          onChange={(e) => onUpdate({ field: e.target.value })}
          onBlur={commitTextValue}
          placeholder="field"
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-28"
        />
      )}

      {/* Op */}
      <select
        value={clause.op}
        onChange={(e) => onUpdate({ op: e.target.value as WhereClause['op'] })}
        className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500 w-14"
      >
        {FILTER_OPS.map((op) => (
          <option key={op} value={op}>{op}</option>
        ))}
      </select>

      {/* Value */}
      {isEnum ? (
        <select
          value={String(clause.value)}
          onChange={(e) => onUpdate({ value: e.target.value })}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          {fieldMeta!.enumValues!.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      ) : isBool ? (
        <select
          value={String(clause.value)}
          onChange={(e) => onUpdate({ value: e.target.value === 'true' })}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={commitTextValue}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitTextValue();
              inputRef.current?.blur();
            }
          }}
          placeholder="value (Enter to apply)"
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-36"
        />
      )}

      {/* Type hint */}
      {fieldMeta && (
        <span className="text-[9px] text-slate-600 shrink-0">{fieldMeta.type}</span>
      )}

      {/* Pending indicator — shows when local text differs from committed value */}
      {!isDropdown && localValue !== String(clause.value) && localValue.trim() !== '' && (
        <span className="text-[9px] text-amber-500 shrink-0" title="Press Enter to apply">
          pending
        </span>
      )}

      {/* Remove */}
      <button
        onClick={onRemove}
        className="text-slate-600 hover:text-red-400 transition-colors p-0.5 shrink-0"
        title="Remove filter"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// --- Node Listing Cell ---

function NodeListingCell({
  node,
  views,
  resolverConfig,
}: {
  node: GraphRecord;
  views: Array<{ viewName: string; tagName: string }>;
  resolverConfig?: { default?: string; listing?: string; detail?: string; inline?: string };
}) {
  const [viewFailed, setViewFailed] = useState(false);

  if (!viewFailed && views.length > 0) {
    const viewName = resolveViewForEntity(resolverConfig, views, 'listing');
    if (viewName !== 'json') {
      const match = views.find((v) => v.viewName === viewName);
      if (match) {
        return (
          <div>
            <CustomView tagName={match.tagName} data={node.data as Record<string, unknown>} onError={() => setViewFailed(true)} />
          </div>
        );
      }
    }
  }
  return (
    <span className="text-xs text-slate-400 font-mono">
      {truncateData(node.data, 100)}
    </span>
  );
}
