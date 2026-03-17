import { useState, useMemo } from 'react';
import type { Schema, RegistryEntryMeta, GraphRecord } from '../types';
import { trpc } from '../trpc';
import { scopeInput } from '../utils';
import { useScope } from './scope-context';
import SchemaForm from './SchemaForm';

interface Props {
  schema: Schema;
  /** If provided, editing an existing node. Otherwise creating new. */
  existingNode?: GraphRecord;
  /** Pre-selected type (for creating from NodeBrowser) */
  defaultType?: string;
  onSaved: (uid: string) => void;
  onCancel: () => void;
}

export default function NodeEditor({ schema, existingNode, defaultType, onSaved, onCancel }: Props) {
  const { scopePath } = useScope();
  const isEdit = !!existingNode;
  const nodeSchemas = schema.nodeSchemas ?? [];

  const [selectedType, setSelectedType] = useState(existingNode?.aType ?? defaultType ?? nodeSchemas[0]?.aType ?? '');
  const [uid, setUid] = useState(existingNode?.aUid ?? '');
  const [formValues, setFormValues] = useState<Record<string, unknown>>(existingNode?.data ?? {});
  const [error, setError] = useState<string | null>(null);

  const createMutation = trpc.createNode.useMutation({
    onSuccess: (data) => onSaved(data.uid),
    onError: (err) => setError(err.message),
  });
  const updateMutation = trpc.updateNode.useMutation({
    onSuccess: () => onSaved(existingNode!.aUid),
    onError: (err) => setError(err.message),
  });

  const loading = createMutation.isPending || updateMutation.isPending;

  const currentSchema: RegistryEntryMeta | undefined = useMemo(
    () => nodeSchemas.find((ns) => ns.aType === selectedType),
    [nodeSchemas, selectedType],
  );

  const handleTypeChange = (newType: string) => {
    setSelectedType(newType);
    if (!isEdit) {
      setFormValues({});
    }
  };

  const handleSubmit = () => {
    setError(null);
    if (isEdit) {
      updateMutation.mutate({ uid: existingNode!.aUid, data: formValues, ...scopeInput(scopePath) });
    } else {
      createMutation.mutate({ aType: selectedType, uid: uid || undefined, data: formValues, ...scopeInput(scopePath) });
    }
  };

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      <h2 className="text-sm font-semibold mb-4">
        {isEdit ? `Edit Node: ${existingNode!.aUid}` : 'Create Node'}
      </h2>

      {/* Type selector */}
      {!isEdit && (
        <div className="mb-4">
          <label className="block text-xs text-slate-400 mb-1">Node Type</label>
          <select
            value={selectedType}
            onChange={(e) => handleTypeChange(e.target.value)}
            className="w-full max-w-xs bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
          >
            {nodeSchemas.map((ns) => (
              <option key={ns.aType} value={ns.aType}>
                {ns.aType}
                {ns.description ? ` — ${ns.description}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* UID */}
      {!isEdit && (
        <div className="mb-4">
          <label className="block text-xs text-slate-400 mb-1">UID (optional, auto-generated if empty)</label>
          <input
            type="text"
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder="Leave empty to auto-generate"
            className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>
      )}

      {/* Schema-driven form */}
      {currentSchema && currentSchema.fields.length > 0 ? (
        <div className="mb-5">
          <label className="block text-xs text-slate-500 mb-2 uppercase tracking-wider font-semibold">Data Fields</label>
          <SchemaForm fields={currentSchema.fields} values={formValues} onChange={setFormValues} />
        </div>
      ) : (
        <div className="mb-5">
          <label className="block text-xs text-slate-400 mb-1">Data (JSON)</label>
          <textarea
            value={JSON.stringify(formValues, null, 2)}
            onChange={(e) => {
              try {
                setFormValues(JSON.parse(e.target.value));
              } catch {
                // Let user keep typing
              }
            }}
            rows={6}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
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
          disabled={loading || !selectedType}
          className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {isEdit ? 'Save Changes' : 'Create Node'}
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
