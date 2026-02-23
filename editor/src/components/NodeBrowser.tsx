import { useParams, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import type { Schema, ViewRegistryData, AppConfig } from '../types';
import { getTypeBadgeColor } from '../utils';
import NodeEditor from './NodeEditor';
import NodeListCore from './NodeListCore';

interface Props {
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
  onDataChanged?: () => void;
}

export default function NodeBrowser({ schema, viewRegistry, config, onDataChanged }: Props) {
  const { type } = useParams<{ type: string }>();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

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

      {/* Node list */}
      {type && (
        <NodeListCore
          type={type}
          schema={schema}
          viewRegistry={viewRegistry}
          config={config}
        />
      )}
    </div>
  );
}
