import { useState, useMemo } from 'react';
import type { Schema, RegistryEntryMeta } from '../types';
import { trpc } from '../trpc';
import { getTypeBadgeColor } from '../utils';
import SchemaForm from './SchemaForm';
import NodePickerModal from './NodePickerModal';

type TargetMode = 'create' | 'existing' | 'manual';

interface Props {
  schema: Schema;
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
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const canSubmit = (() => {
    if (!currentSchema || loading) return false;
    if (targetMode === 'create') return true; // UID is auto-generated if empty
    return !!targetUid;
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

      {/* Target selection: 3 tabs */}
      <div className="mb-4">
        <label className="block text-xs text-slate-400 mb-2">
          {direction === 'out' ? 'Target' : 'Source'} Node ({targetLabel})
        </label>

        {/* Tab bar */}
        <div className="flex border border-slate-700 rounded-lg overflow-hidden mb-3">
          <TabButton
            active={targetMode === 'create'}
            onClick={() => setTargetMode('create')}
            label="Create New"
          />
          <TabButton
            active={targetMode === 'existing'}
            onClick={() => setTargetMode('existing')}
            label="Select Existing"
          />
          <TabButton
            active={targetMode === 'manual'}
            onClick={() => setTargetMode('manual')}
            label="Enter UID"
          />
        </div>

        {/* Tab content */}
        {targetMode === 'create' && targetType && (
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            <p className="text-xs text-slate-500 mb-3">
              A new <span className="text-slate-300 font-mono">{targetType}</span> node will be created alongside the edge.
            </p>
            {/* Optional UID */}
            <div className="mb-3">
              <label className="block text-[11px] text-slate-500 mb-1">UID (optional, auto-generated if empty)</label>
              <input
                type="text"
                value={nodeUidOverride}
                onChange={(e) => setNodeUidOverride(e.target.value)}
                placeholder="Leave empty to auto-generate"
                className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
            {/* Node data form */}
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
          <div className="bg-slate-800/50 rounded-lg p-4 border border-slate-700/50">
            {targetUid ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Selected:</span>
                <span className="font-mono text-sm text-indigo-400">{targetUid}</span>
                <button
                  onClick={() => { setTargetUid(''); setShowPicker(true); }}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Change
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowPicker(true)}
                className="w-full py-6 border-2 border-dashed border-slate-700 rounded-lg text-sm text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                Browse and select a {targetType} node
              </button>
            )}
          </div>
        )}

        {targetMode === 'manual' && (
          <div>
            <input
              type="text"
              value={targetUid}
              onChange={(e) => setTargetUid(e.target.value)}
              placeholder={`e.g., ${targetLabel}1`}
              className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
            />
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

      {/* Node Picker Modal */}
      {showPicker && targetType && (
        <NodePickerModal
          nodeType={targetType}
          schema={schema}
          onPick={(uid) => {
            setTargetUid(uid);
            setShowPicker(false);
          }}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}

// --- Tab button ---

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
        active
          ? 'bg-indigo-600/20 text-indigo-300 border-b-2 border-indigo-500'
          : 'bg-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800/80'
      }`}
    >
      {label}
    </button>
  );
}