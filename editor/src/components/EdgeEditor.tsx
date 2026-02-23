import { useState, useMemo, useEffect, useRef } from 'react';
import type { Schema, RegistryEntryMeta, ViewRegistryData, AppConfig } from '../types';
import { trpc } from '../trpc';
import { getTypeBadgeColor } from '../utils';
import SchemaForm from './SchemaForm';
import NodeListCore from './NodeListCore';

type TargetMode = 'create' | 'existing' | 'manual';

interface Props {
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
  /** The UID of the node we're adding an edge from/to */
  defaultUid?: string;
  /** The type of the node we're adding an edge from/to */
  defaultType?: string;
  /** Direction relative to the current node: 'out' means current node is A-side, 'in' means current node is B-side */
  direction?: 'out' | 'in';
  onSaved: () => void;
  onCancel: () => void;
}

export default function EdgeEditor({
  schema,
  viewRegistry,
  config,
  defaultUid,
  defaultType,
  direction = 'out',
  onSaved,
  onCancel,
}: Props) {
  const edgeSchemas = schema.edgeSchemas ?? [];
  const nodeSchemas = schema.nodeSchemas ?? [];

  // Filter edge schemas based on direction
  const availableEdges = useMemo(() => {
    if (!defaultType) return edgeSchemas;
    if (direction === 'out') {
      return edgeSchemas.filter((es) => es.aType === defaultType);
    } else {
      return edgeSchemas.filter((es) => es.bType === defaultType);
    }
  }, [edgeSchemas, defaultType, direction]);

  const [selectedEdgeKey, setSelectedEdgeKey] = useState(() => {
    const first = availableEdges[0];
    return first ? `${first.aType}:${first.abType}:${first.bType}` : '';
  });
  const [targetUid, setTargetUid] = useState('');
  const [targetMode, setTargetMode] = useState<TargetMode>('create');
  const [edgeFormValues, setEdgeFormValues] = useState<Record<string, unknown>>({});
  const [nodeFormValues, setNodeFormValues] = useState<Record<string, unknown>>({});
  const [nodeUidOverride, setNodeUidOverride] = useState('');
  const [error, setError] = useState<string | null>(null);

  // UID that has been "committed" for validation (set on blur/enter for manual, or on pick)
  const [committedUid, setCommittedUid] = useState('');

  const currentSchema: RegistryEntryMeta | undefined = useMemo(
    () => edgeSchemas.find((es) => `${es.aType}:${es.abType}:${es.bType}` === selectedEdgeKey),
    [edgeSchemas, selectedEdgeKey],
  );

  // The type of the target node (the "other side" from the current node)
  const targetType = direction === 'out' ? currentSchema?.bType : currentSchema?.aType;

  // The node schema for the target type (for the "create inline" form)
  const targetNodeSchema = useMemo(
    () => nodeSchemas.find((ns) => ns.aType === targetType && ns.isNodeEntry),
    [nodeSchemas, targetType],
  );

  // --- Validation queries ---

  // Check if target node exists
  const nodeCheck = trpc.checkNode.useQuery(
    { uid: committedUid },
    { enabled: !!committedUid && (targetMode === 'existing' || targetMode === 'manual') },
  );

  // Compute edge endpoints for edge-exists check
  const edgeAUid = defaultUid && committedUid
    ? (direction === 'out' ? defaultUid : committedUid)
    : '';
  const edgeBUid = defaultUid && committedUid
    ? (direction === 'out' ? committedUid : defaultUid)
    : '';
  const edgeAbType = currentSchema?.abType ?? '';

  const edgeCheck = trpc.checkEdge.useQuery(
    { aUid: edgeAUid, abType: edgeAbType, bUid: edgeBUid },
    { enabled: !!edgeAUid && !!edgeBUid && !!edgeAbType && (targetMode === 'existing' || targetMode === 'manual') },
  );

  // Commit UID when picking from the list
  const handlePick = (uid: string) => {
    setTargetUid(uid);
    setCommittedUid(uid);
  };

  // Commit UID on blur/enter for manual mode
  const manualInputRef = useRef<HTMLInputElement>(null);
  const commitManualUid = () => {
    const trimmed = targetUid.trim();
    if (trimmed && trimmed !== committedUid) {
      setCommittedUid(trimmed);
    }
  };

  // Reset committed UID when target mode or edge type changes
  useEffect(() => {
    setCommittedUid('');
  }, [targetMode, selectedEdgeKey]);

  // --- Mutations ---

  const createEdgeMutation = trpc.createEdge.useMutation({
    onSuccess: () => onSaved(),
    onError: (err) => setError(err.message),
  });

  const createEdgeWithNodeMutation = trpc.createEdgeWithNode.useMutation({
    onSuccess: () => onSaved(),
    onError: (err) => setError(err.message),
  });

  const loading = createEdgeMutation.isPending || createEdgeWithNodeMutation.isPending;

  const handleEdgeChange = (key: string) => {
    setSelectedEdgeKey(key);
    setEdgeFormValues({});
    setNodeFormValues({});
    setTargetUid('');
    setNodeUidOverride('');
    setCommittedUid('');
  };

  const handleSubmit = () => {
    if (!currentSchema || !defaultUid) return;
    setError(null);

    const aType = currentSchema.aType;
    const abType = currentSchema.abType;
    const bType = currentSchema.bType;
    const newNodeSide = direction === 'out' ? 'b' as const : 'a' as const;

    if (targetMode === 'create') {
      createEdgeWithNodeMutation.mutate({
        aType,
        abType,
        bType,
        newNodeSide,
        existingUid: defaultUid,
        newNodeUid: nodeUidOverride || undefined,
        edgeData: edgeFormValues,
        nodeData: nodeFormValues,
      });
    } else {
      // 'existing' or 'manual' — just create the edge
      if (!targetUid) return;

      createEdgeMutation.mutate({
        aType,
        aUid: direction === 'out' ? defaultUid : targetUid,
        abType,
        bType,
        bUid: direction === 'out' ? targetUid : defaultUid,
        data: edgeFormValues,
      });
    }
  };

  // Node validation status
  const nodeValid = committedUid && nodeCheck.data?.exists === true;
  const nodeInvalid = committedUid && nodeCheck.data?.exists === false;
  const nodeChecking = committedUid && nodeCheck.isLoading;

  // Edge duplicate status
  const edgeExists = committedUid && edgeCheck.data?.exists === true;

  const canSubmit = (() => {
    if (!currentSchema || loading) return false;
    if (targetMode === 'create') return true;
    if (!targetUid) return false;
    // For existing/manual: node must exist
    if (nodeInvalid) return false;
    return true;
  })();

  const targetLabel = targetType ?? 'target';

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      <h2 className="text-sm font-semibold mb-4">
        Create {direction === 'out' ? 'Outgoing' : 'Incoming'} Edge
      </h2>

      {/* Edge type selector */}
      {availableEdges.length > 1 && (
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
      )}

      {/* Edge preview badge */}
      {currentSchema && (
        <div className="mb-4 flex items-center gap-2 text-xs font-mono text-slate-400">
          <span className={`px-1.5 py-0.5 rounded ${getTypeBadgeColor(currentSchema.aType)}`}>
            {currentSchema.aType}
          </span>
          <span className="text-slate-600">—[{currentSchema.abType}]→</span>
          <span className={`px-1.5 py-0.5 rounded ${getTypeBadgeColor(currentSchema.bType)}`}>
            {currentSchema.bType}
          </span>
        </div>
      )}

      {/* Target selection */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-3">
          {direction === 'out' ? 'Target' : 'Source'} Node ({targetLabel})
        </label>

        {/* Tab bar — lightweight underline style */}
        <div className="flex gap-4 border-b border-slate-700/50 mb-3 pt-1">
          {(['create', 'existing', 'manual'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setTargetMode(mode)}
              className={`pb-2 text-xs transition-colors relative ${
                targetMode === mode
                  ? 'text-slate-200'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {mode === 'create' ? 'Create new' : mode === 'existing' ? 'Select existing' : 'Enter UID'}
              {targetMode === mode && (
                <span className="absolute bottom-0 left-0 right-0 h-px bg-indigo-500" />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {targetMode === 'create' && targetType && (
          <div>
            <div className="mb-3">
              <label className="block text-[11px] text-slate-500 mb-1">UID (optional, auto-generated if empty)</label>
              <input
                type="text"
                value={nodeUidOverride}
                onChange={(e) => setNodeUidOverride(e.target.value)}
                placeholder="Leave empty to auto-generate"
                className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              {nodeUidOverride && (
                <p className="mt-1.5 text-xs text-amber-400">
                  Custom UIDs can cause Firestore hotspots. Recommended to leave empty for auto-generated IDs.
                </p>
              )}
            </div>
            {targetNodeSchema && targetNodeSchema.fields.length > 0 ? (
              <div>
                <label className="block text-[11px] text-slate-500 mb-2 uppercase tracking-wider font-semibold">
                  {targetType} Data
                </label>
                <SchemaForm fields={targetNodeSchema.fields} values={nodeFormValues} onChange={setNodeFormValues} />
              </div>
            ) : (
              <div>
                <label className="block text-[11px] text-slate-500 mb-1">Data (JSON)</label>
                <textarea
                  value={JSON.stringify(nodeFormValues, null, 2)}
                  onChange={(e) => {
                    try { setNodeFormValues(JSON.parse(e.target.value)); } catch { /* let user type */ }
                  }}
                  rows={4}
                  className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            )}
          </div>
        )}

        {targetMode === 'existing' && targetType && (
          <div>
            {targetUid && (
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] text-slate-500">Selected:</span>
                <span className="font-mono text-sm text-indigo-400">{targetUid}</span>
                <ValidationBadge checking={!!nodeChecking} valid={!!nodeValid} invalid={!!nodeInvalid} />
                <button
                  onClick={() => { setTargetUid(''); setCommittedUid(''); }}
                  className="text-[11px] text-slate-500 hover:text-slate-300 transition-colors"
                >
                  clear
                </button>
              </div>
            )}
            {targetUid && edgeExists && (
              <EdgeExistsWarning />
            )}
            {!targetUid && (
              <NodeListCore
                type={targetType}
                schema={schema}
                viewRegistry={viewRegistry}
                config={config}
                onPick={handlePick}
                compact
              />
            )}
          </div>
        )}

        {targetMode === 'manual' && (
          <div>
            <div className="flex items-center gap-2">
              <input
                ref={manualInputRef}
                type="text"
                value={targetUid}
                onChange={(e) => setTargetUid(e.target.value)}
                onBlur={commitManualUid}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitManualUid();
                    manualInputRef.current?.blur();
                  }
                }}
                placeholder={`e.g., ${targetLabel}1 (Enter to validate)`}
                className="flex-1 max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <ValidationBadge checking={!!nodeChecking} valid={!!nodeValid} invalid={!!nodeInvalid} />
            </div>
            {nodeInvalid && (
              <p className="mt-1.5 text-xs text-red-400">
                No node found with UID "{committedUid}"
              </p>
            )}
            {nodeValid && nodeCheck.data?.node && nodeCheck.data.node.aType !== targetType && (
              <p className="mt-1.5 text-xs text-amber-400">
                Node exists but is type "{nodeCheck.data.node.aType}" (expected "{targetType}")
              </p>
            )}
            {edgeExists && (
              <EdgeExistsWarning />
            )}
          </div>
        )}
      </div>

      {/* Edge data form */}
      {currentSchema && currentSchema.fields.length > 0 && (
        <div className="mb-5">
          <label className="block text-xs text-slate-500 mb-2 uppercase tracking-wider font-semibold">Edge Data</label>
          <SchemaForm fields={currentSchema.fields} values={edgeFormValues} onChange={setEdgeFormValues} />
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
          disabled={!canSubmit}
          className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {loading && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
          {targetMode === 'create'
            ? `Create ${targetLabel} + Edge`
            : edgeExists
              ? 'Update Edge'
              : 'Create Edge'}
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

// --- Validation indicator ---

function ValidationBadge({
  checking,
  valid,
  invalid,
}: {
  checking: boolean;
  valid: boolean;
  invalid: boolean;
}) {
  if (checking) {
    return <div className="w-3.5 h-3.5 border-2 border-slate-500 border-t-transparent rounded-full animate-spin shrink-0" />;
  }
  if (valid) {
    return (
      <svg className="w-4 h-4 text-emerald-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (invalid) {
    return (
      <svg className="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    );
  }
  return null;
}

function EdgeExistsWarning() {
  return (
    <div className="flex items-center gap-1.5 mt-1.5 mb-2 text-xs text-amber-400">
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      Edge already exists — submitting will update it
    </div>
  );
}
