import { useState } from 'react';

import { trpc } from '../trpc';
import type { CollectionDef } from '../types';
import SchemaForm from './SchemaForm';

interface Props {
  collectionDef: CollectionDef;
  params?: Record<string, string>;
  /** When provided, editing an existing document. Otherwise creating new. */
  existingDoc?: { id: string; data: Record<string, unknown> };
  onSaved: (id: string) => void;
  onCancel: () => void;
}

export default function CollectionDocEditor({
  collectionDef,
  params,
  existingDoc,
  onSaved,
  onCancel,
}: Props) {
  const isEdit = !!existingDoc;
  const [formValues, setFormValues] = useState<Record<string, unknown>>(existingDoc?.data ?? {});
  const [jsonText, setJsonText] = useState(
    existingDoc ? JSON.stringify(existingDoc.data, null, 2) : '{}',
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMutation = trpc.createCollectionDoc.useMutation({
    onSuccess: (data) => onSaved(data.id),
    onError: (err) => setError(err.message),
  });
  const updateMutation = trpc.updateCollectionDoc.useMutation({
    onSuccess: () => onSaved(existingDoc!.id),
    onError: (err) => setError(err.message),
  });

  const loading = createMutation.isPending || updateMutation.isPending;
  const hasSchema = collectionDef.hasSchema && collectionDef.fields.length > 0;

  const handleSubmit = () => {
    setError(null);
    let data: Record<string, unknown>;

    if (hasSchema) {
      data = formValues;
    } else {
      try {
        data = JSON.parse(jsonText) as Record<string, unknown>;
        setJsonError(null);
      } catch {
        setJsonError('Invalid JSON');
        return;
      }
    }

    if (isEdit) {
      updateMutation.mutate({
        collectionName: collectionDef.name,
        params,
        docId: existingDoc!.id,
        data,
      });
    } else {
      createMutation.mutate({
        collectionName: collectionDef.name,
        params,
        data,
      });
    }
  };

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      <h2 className="text-sm font-semibold mb-1">
        {isEdit ? `Edit Document: ${existingDoc!.id}` : `New Document in ${collectionDef.name}`}
      </h2>
      {collectionDef.description && (
        <p className="text-xs text-slate-500 mb-4">{collectionDef.description}</p>
      )}

      <div className="mb-5">
        {hasSchema ? (
          <SchemaForm fields={collectionDef.fields} values={formValues} onChange={setFormValues} />
        ) : (
          <div>
            <label className="block text-xs text-slate-400 mb-1">Data (JSON)</label>
            <textarea
              value={jsonText}
              onChange={(e) => {
                setJsonText(e.target.value);
                setJsonError(null);
              }}
              rows={10}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors resize-y"
              spellCheck={false}
            />
            {jsonError && <p className="mt-1 text-xs text-red-400">{jsonError}</p>}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={loading}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
        >
          {loading ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Document'}
        </button>
        <button
          onClick={onCancel}
          disabled={loading}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-lg text-xs font-medium transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
