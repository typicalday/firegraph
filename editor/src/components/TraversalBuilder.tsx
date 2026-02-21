import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Schema, HopDef, TraversalResult, GraphRecord } from '../types';
import { runTraversal } from '../api';
import { getTypeBadgeColor } from '../utils';
import JsonView from './JsonView';

interface Props {
  schema: Schema;
}

/** Standalone traversal page at /traverse */
export default function TraversalBuilder({ schema }: Props) {
  const [startUid, setStartUid] = useState('');

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold mb-1">Graph Traversal</h1>
        <p className="text-sm text-slate-400">
          Build multi-hop traversals to explore graph relationships
        </p>
      </div>

      <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
        <div className="mb-5">
          <label className="block text-xs text-slate-400 mb-1.5">Start Node UID</label>
          <input
            type="text"
            value={startUid}
            onChange={(e) => setStartUid(e.target.value)}
            placeholder="e.g., tour1"
            className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>

        <TraversalPanel schema={schema} startUid={startUid} />
      </div>
    </div>
  );
}

/** Reusable traversal panel — used standalone and embedded in NodeDetail */
export function TraversalPanel({ schema, startUid }: { schema: Schema; startUid: string }) {
  const [hops, setHops] = useState<HopDef[]>([
    { abType: schema.edgeTypes[0]?.abType || '', direction: 'forward', limit: 10 },
  ]);
  const [maxReads, setMaxReads] = useState(100);
  const [result, setResult] = useState<TraversalResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uniqueAbTypes = [...new Set(schema.edgeTypes.map((et) => et.abType))];

  const addHop = () => {
    setHops([...hops, { abType: uniqueAbTypes[0] || '', direction: 'forward', limit: 10 }]);
  };

  const removeHop = (index: number) => {
    if (hops.length <= 1) return;
    setHops(hops.filter((_, i) => i !== index));
  };

  const updateHop = (index: number, updates: Partial<HopDef>) => {
    setHops(hops.map((hop, i) => (i === index ? { ...hop, ...updates } : hop)));
  };

  const executeTraversal = async () => {
    if (!startUid.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await runTraversal(startUid.trim(), hops, maxReads);
      setResult(res);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Hops */}
      <div className="mb-5">
        <label className="block text-xs text-slate-400 mb-2">Hops</label>
        <div className="space-y-3">
          {hops.map((hop, i) => (
            <div key={i} className="flex items-center gap-3 bg-slate-800/50 rounded-lg p-3">
              <span className="text-xs text-slate-500 w-6 shrink-0">#{i + 1}</span>

              <select
                value={hop.direction}
                onChange={(e) => updateHop(i, { direction: e.target.value as 'forward' | 'reverse' })}
                className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
              >
                <option value="forward">Forward</option>
                <option value="reverse">Reverse</option>
              </select>

              <select
                value={hop.abType}
                onChange={(e) => updateHop(i, { abType: e.target.value })}
                className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 flex-1 max-w-xs"
              >
                {uniqueAbTypes.map((abType) => (
                  <option key={abType} value={abType}>
                    {abType}
                  </option>
                ))}
              </select>

              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">limit:</span>
                <input
                  type="number"
                  value={hop.limit}
                  onChange={(e) => updateHop(i, { limit: parseInt(e.target.value) || 10 })}
                  className="w-16 bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                  min={1}
                  max={200}
                />
              </div>

              {hops.length > 1 && (
                <button
                  onClick={() => removeHop(i)}
                  className="text-slate-600 hover:text-red-400 transition-colors p-1"
                  title="Remove hop"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          ))}
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

      {/* Max Reads */}
      <div className="mb-5">
        <label className="block text-xs text-slate-400 mb-1.5">Read Budget</label>
        <input
          type="number"
          value={maxReads}
          onChange={(e) => setMaxReads(parseInt(e.target.value) || 100)}
          className="w-24 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
          min={1}
          max={1000}
        />
        <p className="text-[10px] text-slate-600 mt-1">Max Firestore reads for this traversal</p>
      </div>

      {/* Preview */}
      <div className="mb-5 bg-slate-950 rounded-lg p-3">
        <p className="text-xs text-slate-500 mb-1">Query Preview</p>
        <div className="flex items-center gap-1.5 text-sm font-mono flex-wrap">
          <span className="text-indigo-400">{startUid || '?'}</span>
          {hops.map((hop, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span className="text-slate-600">
                {hop.direction === 'forward' ? '\u2192' : '\u2190'}
              </span>
              <span className="text-emerald-400">{hop.abType || '?'}</span>
            </span>
          ))}
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
          <TraversalResults result={result} />
        </div>
      )}
    </>
  );
}

function TraversalResults({ result }: { result: TraversalResult }) {
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
      </div>

      {/* Hops */}
      <div className="space-y-4">
        {result.hops.map((hop, i) => (
          <div key={i} className="border-l-2 border-indigo-500/30 pl-4">
            <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
              <span className="text-slate-500">Hop {i + 1}:</span>
              <span className="text-indigo-400 font-mono">{hop.abType}</span>
              <span className="text-slate-600 text-xs">
                ({hop.direction}, {hop.edges.length} edges from {hop.sourceCount} sources)
              </span>
              {hop.truncated && (
                <span className="text-amber-400 text-[10px]">truncated</span>
              )}
            </h3>
            <div className="space-y-1">
              {hop.edges.slice(0, 20).map((edge, j) => (
                <HopEdgeRow key={j} edge={edge} direction={hop.direction} />
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
    </div>
  );
}

function HopEdgeRow({ edge, direction }: { edge: GraphRecord; direction: string }) {
  const [expanded, setExpanded] = useState(false);
  const { aType, aUid, bType, bUid, data } = edge;
  const hasData = data && Object.keys(data).length > 0;

  return (
    <div className="bg-slate-800/30 rounded px-3 py-1.5">
      <div className="flex items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(aType)}`}>
          {aType}
        </span>
        <Link to={`/node/${encodeURIComponent(aUid)}`} className="font-mono text-slate-300 hover:text-indigo-400 transition-colors">
          {aUid}
        </Link>
        <span className="text-slate-600">{direction === 'forward' ? '\u2192' : '\u2190'}</span>
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(bType)}`}>
          {bType}
        </span>
        <Link to={`/node/${encodeURIComponent(bUid)}`} className="font-mono text-slate-300 hover:text-indigo-400 transition-colors">
          {bUid}
        </Link>
        {hasData && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="ml-auto text-[10px] text-slate-600 hover:text-slate-400"
          >
            {expanded ? 'hide' : 'data'}
          </button>
        )}
      </div>
      {expanded && hasData && (
        <div className="mt-1 font-mono text-[10px] bg-slate-950 rounded p-2">
          <JsonView data={data} defaultExpanded />
        </div>
      )}
    </div>
  );
}
