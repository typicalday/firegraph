import { useState, useMemo } from 'react';
import type { Schema, RegistryEntryMeta } from '../types';
import { createEdge } from '../api';
import SchemaForm from './SchemaForm';

interface Props {
  schema: Schema;
  /** Pre-fill the source node UID */
  defaultAUid?: string;
  /** Pre-fill the source node type */
  defaultAType?: string;
  onSaved: () => void;
  onCancel: () => void;
}

export default function EdgeEditor({ schema, defaultAUid, defaultAType, onSaved, onCancel }: Props) {
  const edgeSchemas = schema.edgeSchemas ?? [];

  // Filter to edge schemas matching the source type if provided
  const availableEdges = useMemo(
    () => (defaultAType ? edgeSchemas.filter((es) => es.aType === defaultAType) : edgeSchemas),
    [edgeSchemas, defaultAType],
  );

  const [selectedEdgeKey, setSelectedEdgeKey] = useState(() => {
    const first = availableEdges[0];
    return first ? `${first.aType}:${first.abType}:${first.bType}` : '';
  });
  const [aUid, setAUid] = useState(defaultAUid ?? '');
  const [bUid, setBUid] = useState('');
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentSchema: RegistryEntryMeta | undefined = useMemo(
    () => edgeSchemas.find((es) => `${es.aType}:${es.abType}:${es.bType}` === selectedEdgeKey),
    [edgeSchemas, selectedEdgeKey],
  );

  const handleEdgeChange = (key: string) => {
    setSelectedEdgeKey(key);
    setFormValues({});
  };

  const handleSubmit = async () => {
    if (!currentSchema) return;
    setLoading(true);
    setError(null);
    try {
      await createEdge(
        currentSchema.aType,
        aUid,
        currentSchema.abType,
        currentSchema.bType,
        bUid,
        formValues,
      );
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      <h2 className="text-sm font-semibold mb-4">Create Edge</h2>

      {/* Edge type selector */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-1">Edge Type</label>
        <select
          value={selectedEdgeKey}
          onChange={(e) => handleEdgeChange(e.target.value)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
        >
          {availableEdges.map((es) => {
            const key = `${es.aType}:${es.abType}:${es.bType}`;
            return (
              <option key={key} value={key}>
                {es.aType} —[{es.abType}]→ {es.bType}
                {es.description ? ` — ${es.description}` : ''}
              </option>
            );
          })}
        </select>
      </div>

      {/* Source UID */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-1">
          Source UID ({currentSchema?.aType ?? 'source'})
        </label>
        <input
          type="text"
          value={aUid}
          onChange={(e) => setAUid(e.target.value)}
          placeholder="e.g., tour1"
          className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
        />
      </div>

      {/* Target UID */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-1">
          Target UID ({currentSchema?.bType ?? 'target'})
        </label>
        <input
          type="text"
          value={bUid}
          onChange={(e) => setBUid(e.target.value)}
          placeholder="e.g., dep1"
          className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
        />
      </div>

      {/* Edge data form */}
      {currentSchema && currentSchema.fields.length > 0 && (
        <div className="mb-5">
          <label className="block text-xs text-slate-500 mb-2 uppercase tracking-wider font-semibold">Edge Data</label>
          <SchemaForm fields={currentSchema.fields} values={formValues} onChange={setFormValues} />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mb-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleSubmit}
          disabled={loading || !aUid || !bUid || !currentSchema}
          className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          Create Edge
        </button>
        <button
          onClick={onCancel}
          disabled={loading}
          className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
