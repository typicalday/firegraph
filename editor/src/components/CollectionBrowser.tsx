import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CollectionDef } from '../types';
import { trpc } from '../trpc';
import { collectionBrowseUrl, collectionDocUrl, formatTimestamp, truncateData } from '../utils';
import CollectionDocEditor from './CollectionDocEditor';

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

  // Reset cursor when the collection or its param values change (prevents stale pagination)
  const paramsKey = JSON.stringify(params);
  useEffect(() => {
    setCursor(undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionDef.name, paramsKey]);

  // Check if any required path params are missing
  const missingParams = collectionDef.pathParams.filter((p) => !params[p]);

  // Local state for filling in missing params
  const [paramInputs, setParamInputs] = useState<Record<string, string>>(
    Object.fromEntries(collectionDef.pathParams.map((p) => [p, params[p] ?? ''])),
  );

  // Reset paramInputs when switching to a different collection definition
  useEffect(() => {
    setParamInputs(Object.fromEntries(collectionDef.pathParams.map((p) => [p, params[p] ?? ''])));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionDef.name]);

  const allParamsProvided = missingParams.length === 0 ||
    missingParams.every((p) => paramInputs[p]?.trim());

  const resolvedParams = { ...params, ...paramInputs };

  const { data, isLoading, error, refetch } = trpc.getCollectionDocs.useQuery(
    {
      collectionName: collectionDef.name,
      params: resolvedParams,
      cursor,
      limit: 50,
    },
    { enabled: allParamsProvided },
  );

  // If path params are needed but not provided, show param input form
  if (missingParams.length > 0) {
    const handleParamSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!missingParams.every((p) => paramInputs[p]?.trim())) return;
      const filled = { ...params };
      for (const p of missingParams) {
        filled[p] = paramInputs[p];
      }
      navigate(collectionBrowseUrl(collectionDef.name, filled, collectionDef.pathParams));
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <h1 className="text-sm font-semibold text-slate-200">{collectionDef.name}</h1>
          </div>
          {collectionDef.description && (
            <p className="text-xs text-slate-500 mt-0.5">{collectionDef.description}</p>
          )}
          <p className="text-[10px] text-slate-600 font-mono mt-0.5">
            {collectionDef.path.replace(/\{([^}]+)\}/g, (_, k) => resolvedParams[k] ?? `{${k}}`)}
          </p>
        </div>
        {!readonly && (
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Document
          </button>
        )}
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="px-6 py-4 border-b border-slate-800 shrink-0">
          <CollectionDocEditor
            collectionDef={collectionDef}
            params={resolvedParams}
            onSaved={(id) => {
              setShowCreate(false);
              void refetch();
              navigate(collectionDocUrl(collectionDef.name, id, resolvedParams, collectionDef.pathParams));
            }}
            onCancel={() => setShowCreate(false)}
          />
        </div>
      )}

      {/* Document list */}
      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        {error && (
          <div className="px-6 py-4 text-sm text-red-400">{error.message}</div>
        )}
        {data && data.documents.length === 0 && (
          <div className="px-6 py-8 text-center text-xs text-slate-500">
            No documents found
            {collectionDef.typeField && (
              <span className="block mt-1">
                (filtered by {collectionDef.typeField} = {String(collectionDef.typeValue)})
              </span>
            )}
          </div>
        )}
        {data && data.documents.length > 0 && (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-950 border-b border-slate-800">
              <tr>
                <th className="px-6 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold w-48">
                  ID
                </th>
                {collectionDef.fields.slice(0, 3).map((f) => (
                  <th key={f.name} className="px-4 py-2 text-left text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
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
                  <td className="px-6 py-2.5">
                    <Link
                      to={collectionDocUrl(collectionDef.name, doc.id, resolvedParams, collectionDef.pathParams)}
                      className="text-indigo-400 hover:text-indigo-300 font-mono transition-colors"
                    >
                      {doc.id.length > 16 ? `${doc.id.slice(0, 14)}…` : doc.id}
                    </Link>
                  </td>
                  {collectionDef.fields.slice(0, 3).map((f) => (
                    <td key={f.name} className="px-4 py-2.5 text-slate-400 truncate max-w-xs">
                      {doc.data[f.name] !== undefined
                        ? String(doc.data[f.name])
                        : <span className="text-slate-600">—</span>
                      }
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

        {/* Pagination */}
        {data?.hasMore && (
          <div className="px-6 py-4 border-t border-slate-800">
            <button
              onClick={() => setCursor(data.nextCursor ?? undefined)}
              className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Load more →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
