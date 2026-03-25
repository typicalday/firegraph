import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Schema, ViewRegistryData, AppConfig } from '../types';
import { getTypeBadgeColor, isTypeVisibleInScope } from '../utils';
import { useScope } from './path-context';
import NodeEditor from './NodeEditor';
import NodeListCore from './NodeListCore';

interface Props {
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
  onDataChanged?: () => void;
  /** When provided by ScopedShell, used instead of route params. */
  typeParam?: string;
}

export default function NodeBrowser({ schema, viewRegistry, config, onDataChanged, typeParam }: Props) {
  const { scopedPath, scopeNamesPath } = useScope();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  const type = typeParam ?? '';
  const canWrite = !schema.readonly;

  // Scope-aware node type filtering (same logic as sidebar)
  const filteredNodeTypes = useMemo(() => {
    const nodeSchemas = schema.nodeSchemas ?? [];
    return schema.nodeTypes.filter((nt) => {
      const meta = nodeSchemas.find((s) => s.aType === nt.type && s.isNodeEntry);
      return isTypeVisibleInScope(scopeNamesPath, meta?.allowedIn);
    });
  }, [schema.nodeTypes, schema.nodeSchemas, scopeNamesPath]);

  // No type selected — show landing
  if (!type) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <div className="mb-4">
          <h1 className="text-xl font-bold text-slate-300">Graph</h1>
          <p className="text-sm text-slate-400 mt-1">Select a node type from the sidebar to browse.</p>
        </div>
        {filteredNodeTypes.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {filteredNodeTypes.map((nt) => (
              <button
                key={nt.type}
                onClick={() => navigate(scopedPath(`/browse/${encodeURIComponent(nt.type)}`))}
                className="block w-full text-left px-4 py-3 bg-slate-900 border border-slate-800 rounded-xl hover:border-indigo-500/40 transition-colors"
              >
                <span className={`inline-block px-2 py-0.5 rounded text-xs font-mono mb-1 ${getTypeBadgeColor(nt.type)}`}>
                  {nt.type}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-xl font-bold">{type}</h1>
          <span className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(type)}`}>
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

      {/* Create form */}
      {showCreate && (
        <div className="mb-6">
          <NodeEditor
            schema={schema}
            defaultType={type}
            onSaved={(uid) => {
              setShowCreate(false);
              onDataChanged?.();
              navigate(scopedPath(`/node/${encodeURIComponent(uid)}`));
            }}
            onCancel={() => setShowCreate(false)}
          />
        </div>
      )}

      {/* Node list */}
      <NodeListCore
        type={type}
        schema={schema}
        viewRegistry={viewRegistry}
        config={config}
      />
    </div>
  );
}
