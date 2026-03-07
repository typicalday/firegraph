import { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Schema, HopDef, HopResult, TraversalResult, GraphRecord, WhereClause, FieldMeta, EdgeType, ViewRegistryData, AppConfig, ViewMeta } from '../types';
import { trpc } from '../trpc';
import { getTypeBadgeColor, resolveViewForEntity } from '../utils';
import { useDrillMaybe, type DrillFrame } from './drill-context';
import GraphModal from './GraphModal';
import JsonView from './JsonView';
import ViewSwitcher from './ViewSwitcher';
import CustomView from './CustomView';

interface Props {
  schema: Schema;
}

// --- Helpers ---

/** Given a source node type + direction, return valid edge types from the schema */
function getAvailableEdgeTypes(
  schema: Schema,
  sourceType: string | undefined,
  direction: 'forward' | 'reverse',
): EdgeType[] {
  if (!sourceType) return schema.edgeTypes;
  const filtered = schema.edgeTypes.filter((et) =>
    direction === 'forward' ? et.aType === sourceType : et.bType === sourceType,
  );
  return filtered.length > 0 ? filtered : schema.edgeTypes;
}

/** Unique axbType strings from a list of edge types */
function uniqueAxbTypes(edgeTypes: EdgeType[]): string[] {
  return [...new Set(edgeTypes.map((et) => et.axbType))];
}

interface TypeFlowEntry {
  sourceType: string | undefined;
  targetType: string | undefined;
}

/** Compute cascading source/target types for each hop */
function inferTypeFlow(
  schema: Schema,
  startType: string | undefined,
  hops: HopDef[],
): TypeFlowEntry[] {
  const flow: TypeFlowEntry[] = [];
  let currentType = startType;

  for (const hop of hops) {
    const matching = schema.edgeTypes.filter((et) => et.axbType === hop.axbType);
    let targetType: string | undefined;

    if (currentType && matching.length > 0) {
      if (hop.direction === 'forward') {
        const match = matching.find((et) => et.aType === currentType);
        targetType = match?.bType;
      } else {
        const match = matching.find((et) => et.bType === currentType);
        targetType = match?.aType;
      }
    } else if (matching.length === 1) {
      // Only one entry for this axbType — infer target even without known source
      targetType = hop.direction === 'forward' ? matching[0].bType : matching[0].aType;
    }

    flow.push({ sourceType: currentType, targetType });
    currentType = targetType;
  }

  return flow;
}

/** Get schema fields for an edge type's data schema */
function getFieldsForEdgeType(schema: Schema, axbType: string): FieldMeta[] {
  const entry = schema.edgeSchemas?.find((es) => es.axbType === axbType && !es.isNodeEntry);
  return entry?.fields ?? [];
}

// --- Components ---

/** Standalone traversal page at /traverse */
export default function TraversalBuilder({ schema }: Props) {
  const [startUid, setStartUid] = useState('');
  const [startNodeType, setStartNodeType] = useState<string>('');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold mb-1">Graph Traversal</h1>
        <p className="text-sm text-slate-400">
          Build multi-hop traversals to explore graph relationships
        </p>
      </div>

      <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
        <div className="mb-5 flex gap-4 items-end">
          <div className="flex-1 max-w-sm">
            <label className="block text-xs text-slate-400 mb-1.5">Start Node UID</label>
            <input
              type="text"
              value={startUid}
              onChange={(e) => setStartUid(e.target.value)}
              placeholder="paste a node UID"
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Node Type</label>
            <select
              value={startNodeType}
              onChange={(e) => setStartNodeType(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
            >
              <option value="">Any type</option>
              {schema.nodeTypes.map((nt) => (
                <option key={nt.type} value={nt.type}>{nt.type}</option>
              ))}
            </select>
          </div>
        </div>

        <TraversalPanel schema={schema} startUid={startUid} startNodeType={startNodeType || undefined} />
      </div>
    </div>
  );
}

// --- TraversalPanel ---

interface TraversalPanelProps {
  schema: Schema;
  startUid: string;
  startNodeType?: string;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
}

/** Reusable traversal panel — used standalone and embedded in NodeDetail */
export function TraversalPanel({ schema, startUid, startNodeType, viewRegistry, config }: TraversalPanelProps) {
  // Initialize first hop with a sensible default based on startNodeType
  const initialAxbType = useMemo(() => {
    if (startNodeType) {
      const available = getAvailableEdgeTypes(schema, startNodeType, 'forward');
      const types = uniqueAxbTypes(available);
      return types[0] || schema.edgeTypes[0]?.axbType || '';
    }
    return schema.edgeTypes[0]?.axbType || '';
  }, [schema, startNodeType]);

  const [hops, setHops] = useState<HopDef[]>([
    { axbType: initialAxbType, direction: 'forward', limit: 10 },
  ]);
  const [maxReads, setMaxReads] = useState(100);
  const [concurrency, setConcurrency] = useState(5);
  const [result, setResult] = useState<TraversalResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedAdvanced, setExpandedAdvanced] = useState<Set<number>>(new Set());

  const traverseMutation = trpc.traverse.useMutation({
    onSuccess: (data) => setResult(data as unknown as TraversalResult),
    onError: (err) => setError(err.message),
  });
  const loading = traverseMutation.isPending;

  const typeFlow = useMemo(
    () => inferTypeFlow(schema, startNodeType, hops),
    [schema, startNodeType, hops],
  );

  const addHop = () => {
    const lastTarget = typeFlow[typeFlow.length - 1]?.targetType;
    const available = getAvailableEdgeTypes(schema, lastTarget, 'forward');
    const types = uniqueAxbTypes(available);
    setHops([...hops, { axbType: types[0] || '', direction: 'forward', limit: 10 }]);
  };

  const removeHop = (index: number) => {
    if (hops.length <= 1) return;
    setHops(hops.filter((_, i) => i !== index));
    setExpandedAdvanced((prev) => {
      const next = new Set<number>();
      for (const idx of prev) {
        if (idx < index) next.add(idx);
        else if (idx > index) next.add(idx - 1);
      }
      return next;
    });
  };

  const updateHop = (index: number, updates: Partial<HopDef>) => {
    setHops((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], ...updates };

      // If direction changed, revalidate axbType against filtered options
      if ('direction' in updates) {
        const flow = inferTypeFlow(schema, startNodeType, updated);
        const sourceType = flow[index]?.sourceType;
        const available = uniqueAxbTypes(
          getAvailableEdgeTypes(schema, sourceType, updated[index].direction),
        );
        if (available.length > 0 && !available.includes(updated[index].axbType)) {
          updated[index] = { ...updated[index], axbType: available[0] };
        }
      }

      return updated;
    });
  };

  const toggleAdvanced = (index: number) => {
    setExpandedAdvanced((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const executeTraversal = () => {
    if (!startUid.trim()) return;
    setError(null);
    setResult(null);
    traverseMutation.mutate({
      startUid: startUid.trim(),
      hops,
      maxReads,
      concurrency,
    });
  };

  return (
    <>
      {/* Start node context */}
      {startNodeType && (
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xs text-slate-500">Starting from</span>
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${getTypeBadgeColor(startNodeType)}`}>
            {startNodeType}
          </span>
          <span className="text-xs text-slate-400 font-mono">{startUid}</span>
        </div>
      )}

      {/* Hops */}
      <div className="mb-5">
        <label className="block text-xs text-slate-400 mb-2">Hops</label>
        <div className="space-y-2">
          {hops.map((hop, i) => {
            const flow = typeFlow[i];
            const sourceType = flow?.sourceType;
            const targetType = flow?.targetType;
            const availableEdges = getAvailableEdgeTypes(schema, sourceType, hop.direction);
            const axbTypes = uniqueAxbTypes(availableEdges);
            const isAdvOpen = expandedAdvanced.has(i);
            const fields = getFieldsForEdgeType(schema, hop.axbType);

            return (
              <div key={i} className="bg-slate-800/50 rounded-lg">
                {/* Main hop row */}
                <div className="flex items-center gap-2 p-3">
                  <span className="text-xs text-slate-500 w-6 shrink-0">#{i + 1}</span>

                  {/* Source type badge */}
                  {sourceType ? (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${getTypeBadgeColor(sourceType)}`}>
                      {sourceType}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-700 text-slate-500 shrink-0">?</span>
                  )}

                  <select
                    value={hop.direction}
                    onChange={(e) => updateHop(i, { direction: e.target.value as 'forward' | 'reverse' })}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="forward">Forward</option>
                    <option value="reverse">Reverse</option>
                  </select>

                  <select
                    value={hop.axbType}
                    onChange={(e) => updateHop(i, { axbType: e.target.value })}
                    className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 flex-1 max-w-xs"
                  >
                    {axbTypes.map((ab) => (
                      <option key={ab} value={ab}>{ab}</option>
                    ))}
                  </select>

                  <span className="text-slate-600 text-xs">{'\u2192'}</span>

                  {/* Target type badge */}
                  {targetType ? (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0 ${getTypeBadgeColor(targetType)}`}>
                      {targetType}
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-slate-700 text-slate-500 shrink-0">?</span>
                  )}

                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-500">limit:</span>
                    <input
                      type="number"
                      value={hop.limit}
                      onChange={(e) => updateHop(i, { limit: parseInt(e.target.value) || 10 })}
                      className="w-14 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                      min={1}
                      max={200}
                    />
                  </div>

                  {/* Advanced toggle */}
                  <button
                    onClick={() => toggleAdvanced(i)}
                    className={`p-1 transition-colors ${isAdvOpen ? 'text-indigo-400' : 'text-slate-600 hover:text-slate-400'}`}
                    title="Advanced options"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>

                  {hops.length > 1 && (
                    <button
                      onClick={() => removeHop(i)}
                      className="text-slate-600 hover:text-red-400 transition-colors p-1"
                      title="Remove hop"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Advanced options panel */}
                {isAdvOpen && (
                  <AdvancedHopOptions
                    hop={hop}
                    index={i}
                    fields={fields}
                    updateHop={updateHop}
                  />
                )}
              </div>
            );
          })}
        </div>

        <button
          onClick={addHop}
          className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Hop
        </button>
      </div>

      {/* Global options */}
      <div className="mb-5 flex gap-5 items-end">
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Read Budget</label>
          <input
            type="number"
            value={maxReads}
            onChange={(e) => setMaxReads(parseInt(e.target.value) || 100)}
            className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            min={1}
            max={1000}
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">Concurrency</label>
          <input
            type="number"
            value={concurrency}
            onChange={(e) => setConcurrency(parseInt(e.target.value) || 5)}
            className="w-20 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
            min={1}
            max={20}
          />
        </div>
      </div>

      {/* Preview */}
      <div className="mb-5 bg-slate-950 rounded-lg p-3">
        <p className="text-xs text-slate-500 mb-1">Query Preview</p>
        <div className="flex items-center gap-1.5 text-sm font-mono flex-wrap">
          <span className="text-indigo-400">{startUid || '?'}</span>
          {startNodeType && (
            <span className="text-slate-500 text-xs">({startNodeType})</span>
          )}
          {hops.map((hop, i) => {
            const target = typeFlow[i]?.targetType;
            return (
              <span key={i} className="flex items-center gap-1.5">
                <span className="text-slate-600">
                  {hop.direction === 'forward' ? '\u2192' : '\u2190'}
                </span>
                <span className="text-emerald-400">{hop.axbType || '?'}</span>
                {target && (
                  <>
                    <span className="text-slate-600">{'\u2192'}</span>
                    <span className="text-cyan-400 text-xs">{target}</span>
                  </>
                )}
              </span>
            );
          })}
        </div>
      </div>

      {/* Execute */}
      <button
        onClick={executeTraversal}
        disabled={loading || !startUid.trim()}
        className="px-5 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
      >
        {loading ? (
          <>
            <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            Running...
          </>
        ) : (
          <>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Run Traversal
          </>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 mt-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mt-5">
          <TraversalResults result={result} startUid={startUid} schema={schema} viewRegistry={viewRegistry} config={config} />
        </div>
      )}
    </>
  );
}

// --- Advanced Hop Options ---

function AdvancedHopOptions({
  hop,
  index,
  fields,
  updateHop,
}: {
  hop: HopDef;
  index: number;
  fields: FieldMeta[];
  updateHop: (index: number, updates: Partial<HopDef>) => void;
}) {
  const addWhere = () => {
    const current = hop.where ?? [];
    updateHop(index, {
      where: [...current, { field: fields[0]?.name || '', op: '==', value: '' }],
    });
  };

  const updateWhere = (wi: number, updates: Partial<WhereClause>) => {
    const current = [...(hop.where ?? [])];
    current[wi] = { ...current[wi], ...updates };
    updateHop(index, { where: current });
  };

  const removeWhere = (wi: number) => {
    const current = (hop.where ?? []).filter((_, i) => i !== wi);
    updateHop(index, { where: current.length > 0 ? current : undefined });
  };

  return (
    <div className="border-t border-slate-700/50 px-3 pb-3 pt-2 space-y-3">
      {/* Order By */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-slate-500 w-16 shrink-0">Order By</span>
        {fields.length > 0 ? (
          <select
            value={hop.orderBy?.field || ''}
            onChange={(e) =>
              updateHop(index, {
                orderBy: e.target.value ? { field: e.target.value, direction: hop.orderBy?.direction ?? 'asc' } : undefined,
              })
            }
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="">None</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={hop.orderBy?.field || ''}
            onChange={(e) =>
              updateHop(index, {
                orderBy: e.target.value ? { field: e.target.value, direction: hop.orderBy?.direction ?? 'asc' } : undefined,
              })
            }
            placeholder="field name"
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-32"
          />
        )}
        {hop.orderBy && (
          <select
            value={hop.orderBy.direction}
            onChange={(e) =>
              updateHop(index, {
                orderBy: { ...hop.orderBy!, direction: e.target.value as 'asc' | 'desc' },
              })
            }
            className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
          >
            <option value="asc">asc</option>
            <option value="desc">desc</option>
          </select>
        )}
      </div>

      {/* Where clauses */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-slate-500 w-16 shrink-0">Where</span>
          <button
            onClick={addWhere}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            + Add filter
          </button>
        </div>
        {(hop.where ?? []).map((clause, wi) => (
          <div key={wi} className="flex items-center gap-1.5 ml-[4.5rem] mb-1">
            {fields.length > 0 ? (
              <select
                value={clause.field}
                onChange={(e) => updateWhere(wi, { field: e.target.value })}
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                {fields.map((f) => (
                  <option key={f.name} value={f.name}>{f.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={clause.field}
                onChange={(e) => updateWhere(wi, { field: e.target.value })}
                placeholder="field"
                className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-24"
              />
            )}
            <select
              value={clause.op}
              onChange={(e) => updateWhere(wi, { op: e.target.value as WhereClause['op'] })}
              className="bg-slate-800 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none focus:border-indigo-500 w-14"
            >
              <option value="==">==</option>
              <option value="!=">!=</option>
              <option value="<">&lt;</option>
              <option value="<=">&lt;=</option>
              <option value=">">&gt;</option>
              <option value=">=">&gt;=</option>
            </select>
            <input
              type="text"
              value={String(clause.value)}
              onChange={(e) => {
                const num = Number(e.target.value);
                const value = e.target.value === 'true' ? true
                  : e.target.value === 'false' ? false
                  : !isNaN(num) && e.target.value !== '' ? num
                  : e.target.value;
                updateWhere(wi, { value });
              }}
              placeholder="value"
              className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-28"
            />
            <button
              onClick={() => removeWhere(wi)}
              className="text-slate-600 hover:text-red-400 transition-colors p-0.5"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Path reconstruction ---

/**
 * Given a target edge at hopIndex, trace backwards through earlier hops
 * to reconstruct the full chain of DrillFrames from hop 0 to the target.
 * This produces an accurate breadcrumb like:
 *   project → hasTask → task → hasStep → step
 * instead of the wrong:
 *   project → hasStep → step
 */
function reconstructPath(
  allHops: HopResult[],
  hopIndex: number,
  targetEdge: GraphRecord,
): DrillFrame[] {
  // Walk backwards from hopIndex to hop 0, finding the edge at each hop
  // whose target UID matches the source UID of the next hop's edge.
  const chain: { edge: GraphRecord; direction: string }[] = [];

  // Start: the source of the clicked edge is what we need to trace
  const targetDir = allHops[hopIndex].direction;
  let needUid = targetDir === 'forward' ? targetEdge.aUid : targetEdge.bUid;

  for (let h = hopIndex - 1; h >= 0; h--) {
    const hop = allHops[h];
    const match = hop.edges.find((e) =>
      hop.direction === 'forward' ? e.bUid === needUid : e.aUid === needUid,
    );
    if (!match) break;
    chain.unshift({ edge: match, direction: hop.direction });
    needUid = hop.direction === 'forward' ? match.aUid : match.bUid;
  }

  // Convert chain to DrillFrames (each frame is the target node of the edge)
  const frames: DrillFrame[] = chain.map(({ edge, direction }) => ({
    uid: direction === 'forward' ? edge.bUid : edge.aUid,
    nodeType: direction === 'forward' ? edge.bType : edge.aType,
    edgeType: edge.axbType,
    direction: direction === 'forward' ? 'out' as const : 'in' as const,
  }));

  // Add the final frame (the node the user clicked)
  frames.push({
    uid: targetDir === 'forward' ? targetEdge.bUid : targetEdge.aUid,
    nodeType: targetDir === 'forward' ? targetEdge.bType : targetEdge.aType,
    edgeType: targetEdge.axbType,
    direction: targetDir === 'forward' ? 'out' : 'in',
  });

  return frames;
}

// --- Results ---

const EXPLORE_MAX_LANES = 20;

function makeRootFrame(uid: string): DrillFrame {
  return { uid, nodeType: '', edgeType: '', direction: 'out' };
}

function TraversalResults({
  result,
  startUid,
  schema,
  viewRegistry,
  config,
}: {
  result: TraversalResult;
  startUid: string;
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
}) {
  const drill = useDrillMaybe();
  const navigate = useNavigate();
  const [showGraph, setShowGraph] = useState(false);

  // Flatten all hop edges into a single array for the graph modal
  const allEdges = useMemo(
    () => result.hops.flatMap((hop) => hop.edges) as GraphRecord[],
    [result.hops],
  );

  const handleExplore = (hopIndex: number) => {
    const hop = result.hops[hopIndex];
    const edges = hop.edges.slice(0, EXPLORE_MAX_LANES);
    const paths = edges.map((edge) => reconstructPath(result.hops, hopIndex, edge));

    if (drill) {
      // Inside a DrillProvider (TraversalPanel on a node page) — create lanes directly
      for (const frames of paths) {
        drill.createLane([makeRootFrame(startUid), ...frames]);
      }
    } else {
      // Standalone /traverse page — navigate to node detail with paths
      navigate(`/node/${encodeURIComponent(startUid)}`, {
        state: { initialPaths: paths },
      });
    }
  };

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      {/* Stats */}
      <div className="flex items-center gap-6 mb-5">
        <div>
          <div className="text-lg font-bold">{result.nodes.length}</div>
          <div className="text-[10px] text-slate-500">Result Nodes</div>
        </div>
        <div>
          <div className="text-lg font-bold">{result.hops.length}</div>
          <div className="text-[10px] text-slate-500">Hops</div>
        </div>
        <div>
          <div className="text-lg font-bold">{result.totalReads}</div>
          <div className="text-[10px] text-slate-500">Firestore Reads</div>
        </div>
        {result.truncated && (
          <div className="px-2 py-1 bg-amber-500/10 text-amber-400 rounded text-xs">
            Truncated (budget exceeded)
          </div>
        )}
        <button
          onClick={() => setShowGraph(true)}
          className="ml-auto px-3 py-1.5 bg-slate-800 text-slate-300 rounded-lg text-xs hover:bg-slate-700 transition-colors"
        >
          Graph
        </button>
      </div>

      {/* Hops */}
      <div className="space-y-4">
        {result.hops.map((hop, i) => (
          <div key={i} className="border-l-2 border-indigo-500/30 pl-4">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
              <span className="text-slate-500">Hop {i + 1}:</span>
              <span className="text-indigo-400 font-mono">{hop.axbType}</span>
              <span className="text-slate-600 text-xs">
                ({hop.direction}, {hop.edges.length} edges from {hop.sourceCount} sources)
              </span>
              {hop.truncated && (
                <span className="text-amber-400 text-[10px]">truncated</span>
              )}
              {hop.edges.length > 0 && (
                <button
                  onClick={() => handleExplore(i)}
                  className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors ml-auto"
                >
                  show paths
                </button>
              )}
            </h3>
            <div className="space-y-1.5">
              {hop.edges.slice(0, 20).map((edge, j) => (
                <HopEdgeRow
                  key={j}
                  edge={edge}
                  direction={hop.direction}
                  allHops={result.hops}
                  hopIndex={i}
                  edgeViews={viewRegistry?.edges[edge.axbType]?.views ?? []}
                  nodeViews={viewRegistry?.nodes[hop.direction === 'forward' ? edge.bType : edge.aType]?.views ?? []}
                  config={config}
                />
              ))}
              {hop.edges.length > 20 && (
                <p className="text-xs text-slate-500 pl-2">
                  ... and {hop.edges.length - 20} more
                </p>
              )}
              {hop.edges.length === 0 && (
                <p className="text-xs text-slate-500">No edges found</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Graph modal for traversal results */}
      {showGraph && allEdges.length > 0 && (
        <GraphModal
          focusUid={startUid}
          edges={allEdges}
          schema={schema}
          viewRegistry={viewRegistry}
          config={config}
          onClose={() => setShowGraph(false)}
          onNodeClick={(clickedUid, nodeType) => {
            setShowGraph(false);
            if (drill) {
              drill.drillIn({ uid: clickedUid, nodeType, edgeType: '', direction: 'out' });
            } else {
              navigate(`/node/${encodeURIComponent(clickedUid)}`);
            }
          }}
        />
      )}
    </div>
  );
}

function HopEdgeRow({
  edge,
  direction,
  allHops,
  hopIndex,
  edgeViews = [],
  nodeViews = [],
  config,
}: {
  edge: GraphRecord;
  direction: string;
  allHops: HopResult[];
  hopIndex: number;
  edgeViews?: ViewMeta[];
  nodeViews?: ViewMeta[];
  config?: AppConfig;
}) {
  const drill = useDrillMaybe();
  const utils = trpc.useUtils();
  const [edgeExpanded, setEdgeExpanded] = useState(false);
  const [nodeExpanded, setNodeExpanded] = useState(false);
  const [nodeData, setNodeData] = useState<GraphRecord | null | undefined>(undefined);
  const [nodeLoading, setNodeLoading] = useState(false);

  const { aType, aUid, bType, bUid, data } = edge;
  const hasData = data && Object.keys(data).length > 0;

  // The "target" is the node at the end of traversal direction
  const targetUid = direction === 'forward' ? bUid : aUid;
  const targetType = direction === 'forward' ? bType : aType;
  const sourceUid = direction === 'forward' ? aUid : bUid;
  const sourceType = direction === 'forward' ? aType : bType;

  const isResolved = nodeData !== undefined;

  // Resolve initial edge view from config defaults
  const initialEdgeView = () => {
    const rc = config?.viewDefaults?.edges?.[edge.axbType];
    if (rc && edgeViews.length > 0) {
      const resolved = resolveViewForEntity(rc, edgeViews, 'inline');
      if (resolved !== 'json') {
        const match = edgeViews.find((v) => v.viewName === resolved);
        if (match) return match.tagName;
      }
    }
    return 'json';
  };
  const [edgeViewMode, setEdgeViewMode] = useState(initialEdgeView);

  // Resolve initial node view from config defaults
  const initialNodeView = () => {
    const rc = config?.viewDefaults?.nodes?.[targetType];
    if (rc && nodeViews.length > 0) {
      const resolved = resolveViewForEntity(rc, nodeViews, 'inline');
      if (resolved !== 'json') {
        const match = nodeViews.find((v) => v.viewName === resolved);
        if (match) return match.tagName;
      }
    }
    return 'json';
  };
  const [nodeViewMode, setNodeViewMode] = useState(initialNodeView);

  const handleDive = () => {
    if (!drill) return;
    const frames = reconstructPath(allHops, hopIndex, edge);
    drill.drillPath(frames);
  };

  const handleResolve = async () => {
    setNodeLoading(true);
    try {
      const res = await utils.getNodesBatch.fetch({ uids: [targetUid] });
      const resolved = (res.nodes[targetUid] as GraphRecord | null) ?? null;
      setNodeData(resolved);
      setNodeExpanded(true);
      if (resolved) {
        const rc = config?.viewDefaults?.nodes?.[targetType];
        if (rc && nodeViews.length > 0) {
          const viewName = resolveViewForEntity(rc, nodeViews, 'inline');
          if (viewName !== 'json') {
            const match = nodeViews.find((v) => v.viewName === viewName);
            if (match) setNodeViewMode(match.tagName);
          }
        }
      }
    } catch {
      // silently fail
    } finally {
      setNodeLoading(false);
    }
  };

  return (
    <div className="bg-slate-800/50 rounded-lg">
      {/* Source line */}
      <div className="px-3 pt-2 pb-1 flex items-center gap-2 text-xs text-slate-500">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(sourceType)}`}>
          {sourceType}
        </span>
        <span className="font-mono text-slate-400">{sourceUid}</span>
        <span className="text-slate-600">
          {direction === 'forward' ? '\u2192' : '\u2190'}
        </span>
        <span className="text-slate-600 font-mono text-[10px]">{edge.axbType}</span>
      </div>

      {/* Target line with actions */}
      <div className="px-3 pb-2 flex items-center gap-3">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(targetType)}`}>
          {targetType}
        </span>
        {drill ? (
          <button
            onClick={handleDive}
            className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
            title="Dive into this node"
          >
            {targetUid}
          </button>
        ) : (
          <Link
            to={`/node/${encodeURIComponent(targetUid)}`}
            className="text-sm font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            {targetUid}
          </Link>
        )}
        <Link
          to={`/node/${encodeURIComponent(targetUid)}`}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          title="Navigate to this node's page"
        >
          go to
        </Link>
        {hasData && (
          <button
            onClick={() => setEdgeExpanded(!edgeExpanded)}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {edgeExpanded ? 'hide edge' : 'show edge'}
          </button>
        )}
        {!isResolved && !nodeLoading && (
          <button
            onClick={handleResolve}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            resolve
          </button>
        )}
        {nodeLoading && (
          <span className="w-2.5 h-2.5 border border-slate-400 border-t-transparent rounded-full animate-spin" />
        )}
        {isResolved && (
          <button
            onClick={() => setNodeExpanded(!nodeExpanded)}
            className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
          >
            {nodeExpanded ? 'hide node' : 'show node'}
          </button>
        )}
      </div>

      {/* Edge data */}
      {edgeExpanded && hasData && (
        <div className="px-3 pb-2">
          {edgeViews.length > 0 && (
            <div className="mb-2">
              <ViewSwitcher views={edgeViews} activeView={edgeViewMode} onSwitch={setEdgeViewMode} />
            </div>
          )}
          {edgeViewMode === 'json' ? (
            <div className="font-mono text-[11px] leading-relaxed bg-slate-950 rounded p-2 overflow-auto max-h-40">
              <JsonView data={data} defaultExpanded />
            </div>
          ) : (
            <CustomView tagName={edgeViewMode} data={data as Record<string, unknown>} />
          )}
        </div>
      )}

      {/* Resolved node data */}
      {nodeExpanded && isResolved && (
        <div className="px-3 pb-2">
          {nodeData === null ? (
            <p className="text-[11px] text-slate-500 italic">Node not found</p>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold">
                  Node Data
                </span>
                {nodeViews.length > 0 && (
                  <ViewSwitcher views={nodeViews} activeView={nodeViewMode} onSwitch={setNodeViewMode} />
                )}
              </div>
              {nodeViewMode === 'json' ? (
                <div className="font-mono text-[11px] leading-relaxed bg-slate-950 rounded p-2 overflow-auto max-h-40">
                  <JsonView data={nodeData.data} defaultExpanded />
                </div>
              ) : (
                <CustomView tagName={nodeViewMode} data={nodeData.data as Record<string, unknown>} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
