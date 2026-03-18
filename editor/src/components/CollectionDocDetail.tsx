import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CollectionDef, ViewRegistryData } from '../types';
import { trpc } from '../trpc';
import { collectionBrowseUrl } from '../utils';
import JsonView from './JsonView';
import CollectionDocEditor from './CollectionDocEditor';
import ViewSwitcher from './ViewSwitcher';
import CustomView from './CustomView';

interface Props {
  collectionDef: CollectionDef;
  docId: string;
  params: Record<string, string>;
  readonly?: boolean;
  viewRegistry?: ViewRegistryData | null;
}

export default function CollectionDocDetail({ collectionDef, docId, params, readonly, viewRegistry }: Props) {
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [activeView, setActiveView] = useState('json');

  // Reset view to JSON whenever the displayed document or collection changes.
  useEffect(() => {
    setActiveView('json');
  }, [docId, collectionDef.name]);

  const views = viewRegistry?.collections?.[collectionDef.name]?.views ?? [];

  const { data, isLoading, error, refetch } = trpc.getCollectionDoc.useQuery({
    collectionName: collectionDef.name,
    params,
    docId,
  });

  const deleteMutation = trpc.deleteCollectionDoc.useMutation({
    onSuccess: () => {
      navigate(collectionBrowseUrl(collectionDef.name, params, collectionDef.pathParams));
    },
    onError: (err) => alert(`Delete failed: ${err.message}`),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-4 text-sm text-red-400">{error.message}</div>
    );
  }

  if (!data) return null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-800 shrink-0">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs text-slate-500 mb-3">
          <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <Link
            to={collectionBrowseUrl(collectionDef.name, params, collectionDef.pathParams)}
            className="text-amber-400 hover:text-amber-300 transition-colors"
          >
            {collectionDef.name}
          </Link>
          <span>/</span>
          <span className="font-mono text-slate-400">{docId}</span>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold text-slate-200 font-mono">{docId}</h1>
            <p className="text-[10px] text-slate-600 font-mono mt-0.5">
              {collectionDef.path.replace(/\{([^}]+)\}/g, (_, k) => params[k] ?? `{${k}}`)}
            </p>
          </div>
          {!readonly && !isEditing && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsEditing(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition-colors"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                Edit
              </button>
              {!confirmDelete ? (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600/20 hover:bg-red-600/30 text-red-400 rounded-lg text-xs font-medium transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Delete
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-400">Confirm?</span>
                  <button
                    onClick={() => deleteMutation.mutate({ collectionName: collectionDef.name, params, docId })}
                    disabled={deleteMutation.isPending}
                    className="px-2 py-1 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded text-xs transition-colors"
                  >
                    {deleteMutation.isPending ? '...' : 'Yes, delete'}
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-400 rounded text-xs transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {isEditing ? (
          <CollectionDocEditor
            collectionDef={collectionDef}
            params={params}
            existingDoc={{ id: data.id, data: data.data }}
            onSaved={() => {
              setIsEditing(false);
              void refetch();
            }}
            onCancel={() => setIsEditing(false)}
          />
        ) : (
          <>
            {views.length > 0 && (
              <ViewSwitcher views={views} activeView={activeView} onSwitch={setActiveView} />
            )}
            {activeView !== 'json' ? (
              <CustomView tagName={activeView} data={data.data} onError={() => setActiveView('json')} />
            ) : (
              <div className="space-y-4">
                {collectionDef.fields.length > 0 ? (
                  <div className="space-y-2">
                    {collectionDef.fields.map((f) => (
                      <div key={f.name} className="flex gap-3 py-2 border-b border-slate-800/50">
                        <span className="text-xs text-slate-500 w-36 shrink-0 font-mono">{f.name}</span>
                        <span className="text-xs text-slate-300 break-all">
                          {data.data[f.name] !== undefined
                            ? typeof data.data[f.name] === 'object'
                              ? <code className="text-[10px] font-mono text-slate-400">{JSON.stringify(data.data[f.name])}</code>
                              : String(data.data[f.name])
                            : <span className="text-slate-600">—</span>
                          }
                        </span>
                      </div>
                    ))}
                    {/* Show any extra fields not in schema */}
                    {Object.entries(data.data)
                      .filter(([k]) => !collectionDef.fields.some((f) => f.name === k))
                      .map(([k, v]) => (
                        <div key={k} className="flex gap-3 py-2 border-b border-slate-800/50">
                          <span className="text-xs text-slate-600 w-36 shrink-0 font-mono">{k}</span>
                          <span className="text-xs text-slate-500 break-all">
                            {typeof v === 'object' ? (
                              <code className="text-[10px] font-mono">{JSON.stringify(v)}</code>
                            ) : String(v)}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : (
                  <JsonView data={data.data} />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
