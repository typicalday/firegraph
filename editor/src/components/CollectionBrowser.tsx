import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { trpc } from '../trpc';
import type { CollectionDef, FieldMeta, WhereClause } from '../types';
import { fsUrl, resolveCollectionPath, truncateData } from '../utils';
import CollectionBreadcrumb from './CollectionBreadcrumb';
import CollectionDocEditor from './CollectionDocEditor';
import { useRecents } from './recents-context';

const FILTER_OPS: WhereClause['op'][] = ['==', '!=', '<', '<=', '>', '>='];

function coerceValue(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  return raw;
}

interface Props {
  collectionDef: CollectionDef;
  /** Resolved path parameter values, keyed by param name. */
  params: Record<string, string>;
  readonly?: boolean;
}

export default function CollectionBrowser({ collectionDef, params, readonly }: Props) {
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<WhereClause[]>([]);
  const [showFilterBuilder, setShowFilterBuilder] = useState(false);
  const { addRecent } = useRecents();

  // Reset cursor when the collection or its param values change (prevents stale pagination)
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    setCursor(undefined);
  }, [collectionDef.name, paramsKey]);

  // Reset filters when switching collections
  useEffect(() => {
    setFilters([]);
    setShowFilterBuilder(false);
  }, [collectionDef.name]);

  // Reset cursor when filters change
  useEffect(() => {
    setCursor(undefined);
  }, [filters]);

  // Check if any required path params are missing
  const missingParams = collectionDef.pathParams.filter((p) => !params[p]);

  // Local state for filling in missing params
  const [paramInputs, setParamInputs] = useState<Record<string, string>>(
    Object.fromEntries(collectionDef.pathParams.map((p) => [p, params[p] ?? ''])),
  );

  // Reset paramInputs when switching to a different collection definition
  useEffect(() => {
    setParamInputs(Object.fromEntries(collectionDef.pathParams.map((p) => [p, params[p] ?? ''])));
  }, [collectionDef.name]);

  const allParamsProvided =
    missingParams.length === 0 || missingParams.every((p) => paramInputs[p]?.trim());

  const resolvedParams = { ...params, ...paramInputs };

  const activeFilters = filters.filter((f) => f.field && f.value !== '');

  const { data, isLoading, error, refetch } = trpc.getCollectionDocs.useQuery(
    {
      collectionName: collectionDef.name,
      params: resolvedParams,
      cursor,
      limit: 50,
      ...(activeFilters.length > 0 ? { where: activeFilters } : {}),
    },
    { enabled: allParamsProvided },
  );

  // Record this collection browse in recents once params are resolved
  useEffect(() => {
    if (!allParamsProvided) return;
    addRecent({
      type: 'collection',
      label: collectionDef.name,
      sublabel: resolveCollectionPath(collectionDef.path, resolvedParams),
      url: fsUrl(resolveCollectionPath(collectionDef.path, resolvedParams)),
    });
  }, [collectionDef.name, paramsKey]);

  // If path params are needed but not provided, show param input form
  if (missingParams.length > 0) {
    const handleParamSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!missingParams.every((p) => paramInputs[p]?.trim())) return;
      const filled = { ...params };
      for (const p of missingParams) {
        filled[p] = paramInputs[p];
      }
      navigate(fsUrl(resolveCollectionPath(collectionDef.path, filled)));
    };

    return (
      <div className="p-6 max-w-lg">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-slate-200">{collectionDef.name}</h2>
          {collectionDef.description && (
            <p className="text-xs text-slate-500 mt-1">{collectionDef.description}</p>
          )}
          <p className="text-xs text-slate-500 mt-1 font-mono">{collectionDef.path}</p>
        </div>
        <form onSubmit={handleParamSubmit} className="space-y-3">
          {missingParams.map((p) => (
            <div key={p}>
              <label className="block text-xs text-slate-400 mb-1">{p}</label>
              <input
                type="text"
                value={paramInputs[p] ?? ''}
                onChange={(e) => setParamInputs((prev) => ({ ...prev, [p]: e.target.value }))}
                placeholder={`Enter ${p}...`}
                className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
          ))}
          <button
            type="submit"
            disabled={!missingParams.every((p) => paramInputs[p]?.trim())}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
          >
            Browse
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-4">
        <div className="mb-1.5">
          <CollectionBreadcrumb collectionDef={collectionDef} params={resolvedParams} />
        </div>
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold">{collectionDef.name}</h1>
          <span className="px-2 py-0.5 rounded text-xs font-mono bg-amber-500/15 text-amber-400">
            collection
          </span>
          {!readonly && !showCreate && (
            <button
              onClick={() => setShowCreate(true)}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
              New Document
            </button>
          )}
        </div>
        {collectionDef.description && (
          <p className="text-sm text-slate-400">{collectionDef.description}</p>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="mb-6">
          <CollectionDocEditor
            collectionDef={collectionDef}
            params={resolvedParams}
            onSaved={(id) => {
              setShowCreate(false);
              void refetch();
              navigate(
                fsUrl(
                  resolveCollectionPath(collectionDef.path, resolvedParams),
                  `doc/${encodeURIComponent(id)}`,
                ),
              );
            }}
            onCancel={() => setShowCreate(false)}
          />
        </div>
      )}

      {/* Document list card */}
      <section className="bg-slate-900 rounded-xl border border-slate-800">
        {/* Filter toolbar */}
        <div className="px-5 py-3 border-b border-slate-800">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setShowFilterBuilder(!showFilterBuilder)}
              className={`px-2 py-1 rounded text-xs flex items-center gap-1.5 transition-colors ${
                showFilterBuilder || filters.length > 0
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30'
                  : 'bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
                />
              </svg>
              Filters
              {activeFilters.length > 0 && (
                <span className="bg-indigo-500 text-white text-[10px] w-4 h-4 rounded-full inline-flex items-center justify-center font-bold">
                  {activeFilters.length}
                </span>
              )}
            </button>

            {/* Active filter chips (shown when builder is collapsed; only complete filters) */}
            {activeFilters.length > 0 && !showFilterBuilder && (
              <>
                {filters.map((f, i) => {
                  if (!f.field || f.value === '') return null;
                  return (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-600/20 text-indigo-300 rounded text-xs"
                    >
                      {f.field} {f.op} <span className="text-indigo-200">{String(f.value)}</span>
                      <button
                        onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))}
                        className="ml-0.5 text-indigo-400 hover:text-indigo-200"
                      >
                        &times;
                      </button>
                    </span>
                  );
                })}
                <button
                  onClick={() => setFilters([])}
                  className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Clear all
                </button>
              </>
            )}
          </div>

          {/* Filter builder panel */}
          {showFilterBuilder && (
            <div className="mt-2">
              <CollectionFilterBuilder
                filters={filters}
                onFiltersChange={setFilters}
                fieldMetas={collectionDef.fields}
              />
            </div>
          )}
        </div>

        {/* Document table */}
        <div className="overflow-auto">
          {isLoading && (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {error && <div className="px-5 py-4 text-sm text-red-400">{error.message}</div>}
          {data && data.documents.length === 0 && (
            <div className="px-5 py-8 text-center text-xs text-slate-500">
              No documents found
              {activeFilters.length > 0 && (
                <span className="block mt-1">(try adjusting or clearing filters)</span>
              )}
              {collectionDef.typeField && activeFilters.length === 0 && (
                <span className="block mt-1">
                  (filtered by {collectionDef.typeField} = {String(collectionDef.typeValue)})
                </span>
              )}
            </div>
          )}
          {data && data.documents.length > 0 && (
            <table className="w-full min-w-[480px] text-xs">
              <thead className="sticky top-0 bg-slate-900 border-b border-slate-800">
                <tr>
                  <th className="px-5 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold w-48">
                    ID
                  </th>
                  {collectionDef.fields.slice(0, 3).map((f) => (
                    <th
                      key={f.name}
                      className="px-4 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold"
                    >
                      {f.name}
                    </th>
                  ))}
                  {collectionDef.fields.length === 0 && (
                    <th className="px-4 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
                      Data
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {data.documents.map((doc) => (
                  <tr
                    key={doc.id}
                    className="hover:bg-slate-800/30 transition-colors cursor-pointer"
                  >
                    <td className="px-5 py-2.5">
                      <Link
                        to={fsUrl(
                          resolveCollectionPath(collectionDef.path, resolvedParams),
                          `doc/${encodeURIComponent(doc.id)}`,
                        )}
                        className="text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
                      >
                        {doc.id.length > 16 ? `${doc.id.slice(0, 14)}\u2026` : doc.id}
                      </Link>
                    </td>
                    {collectionDef.fields.slice(0, 3).map((f) => (
                      <td key={f.name} className="px-4 py-2.5 text-slate-400 truncate max-w-xs">
                        {doc.data[f.name] !== undefined ? (
                          String(doc.data[f.name])
                        ) : (
                          <span className="text-slate-600">&mdash;</span>
                        )}
                      </td>
                    ))}
                    {collectionDef.fields.length === 0 && (
                      <td className="px-4 py-2.5 text-slate-600 font-mono text-[10px] truncate max-w-xs">
                        {truncateData(doc.data, 60)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {data?.hasMore && (
          <div className="px-5 py-3 border-t border-slate-800">
            <button
              onClick={() => setCursor(data.nextCursor ?? undefined)}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Load more &rarr;
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

// --- Collection Filter Builder ---

function CollectionFilterBuilder({
  filters,
  onFiltersChange,
  fieldMetas,
}: {
  filters: WhereClause[];
  onFiltersChange: (filters: WhereClause[]) => void;
  fieldMetas: FieldMeta[];
}) {
  const fieldNames = fieldMetas.map((f) => f.name);
  const activeCount = filters.filter((f) => f.field && f.value !== '').length;

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
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          Where
        </span>
        <span className="text-[10px] text-slate-600">
          {filters.length === 0
            ? 'No filters \u2014 click "Add filter" to start'
            : activeCount > 0
              ? `${activeCount} active filter${activeCount > 1 ? 's' : ''}${filters.length > activeCount ? ` (${filters.length - activeCount} incomplete)` : ''}`
              : `${filters.length} filter${filters.length > 1 ? 's' : ''} (none active yet)`}
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

      {filters.map((clause, i) => (
        <CollectionFilterRow
          key={i}
          index={i}
          clause={clause}
          fieldMetas={fieldMetas}
          fieldNames={fieldNames}
          onUpdate={(updates) => updateFilter(i, updates)}
          onRemove={() => removeFilter(i)}
        />
      ))}

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

function CollectionFilterRow({
  index,
  clause,
  fieldMetas,
  fieldNames,
  onUpdate,
  onRemove,
}: {
  index: number;
  clause: WhereClause;
  fieldMetas: FieldMeta[];
  fieldNames: string[];
  onUpdate: (updates: Partial<WhereClause>) => void;
  onRemove: () => void;
}) {
  const fieldMeta = fieldMetas.find((f) => f.name === clause.field);
  const [localValue, setLocalValue] = useState(String(clause.value));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalValue(String(clause.value));
  }, [clause.value]);

  const commitTextValue = () => {
    const coerced = coerceValue(localValue.trim());
    if (coerced !== clause.value) {
      onUpdate({ value: coerced });
    }
  };

  const handleFieldChange = (newField: string) => {
    const meta = fieldMetas.find((f) => f.name === newField);
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
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={clause.field}
          onChange={(e) => onUpdate({ field: e.target.value })}
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
          <option key={op} value={op}>
            {op}
          </option>
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
            <option key={v} value={v}>
              {v}
            </option>
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
      {fieldMeta && <span className="text-[9px] text-slate-600 shrink-0">{fieldMeta.type}</span>}

      {/* Pending indicator */}
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
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>
  );
}
