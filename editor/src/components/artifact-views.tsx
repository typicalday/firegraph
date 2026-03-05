import { useState } from 'react';
import { NodeDataCard } from './NodeDetail';
import JsonView from './JsonView';
import { getTypeBadgeColor } from '../utils';
import type { ChatArtifact } from '../artifact-types';
import type { ViewRegistryData, AppConfig } from '../types';

// ---------------------------------------------------------------------------
// Shared sub-types (matching query-client output shapes)
// ---------------------------------------------------------------------------

interface SummarizedRecord {
  type: string;
  uid: string;
  data?: Record<string, unknown>;
}

interface SummarizedEdge {
  fromType: string;
  fromUid: string;
  relation: string;
  toType: string;
  toUid: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Title Helper
// ---------------------------------------------------------------------------

export function getArtifactTitle(artifact: ChatArtifact): string {
  const d = artifact.data as Record<string, unknown>;
  switch (artifact.kind) {
    case 'node-detail': {
      const node = d.node as SummarizedRecord | null;
      return node ? `${node.type}:${node.uid}` : 'Node Not Found';
    }
    case 'nodes-list':
      return `${(Array.isArray(d.nodes) ? d.nodes : []).length} Nodes`;
    case 'edges-list':
      return `${(Array.isArray(d.edges) ? d.edges : []).length} Edges`;
    case 'traverse':
      return `Traversal (${(Array.isArray(d.hops) ? d.hops : []).length} hops)`;
    case 'search':
      return `Search Results`;
    case 'schema':
      return 'Schema';
    default:
      return 'Query Result';
  }
}

// ---------------------------------------------------------------------------
// Content Router
// ---------------------------------------------------------------------------

export function ArtifactContent({
  artifact,
  viewRegistry,
  config,
  onNavigate,
}: {
  artifact: ChatArtifact;
  viewRegistry: ViewRegistryData;
  config: AppConfig;
  onNavigate: (uid: string) => void;
}) {
  switch (artifact.kind) {
    case 'node-detail':
      return <NodeDetailView data={artifact.data as Record<string, unknown>} viewRegistry={viewRegistry} config={config} onNavigate={onNavigate} />;
    case 'nodes-list':
      return <NodesListView data={artifact.data as Record<string, unknown>} onNavigate={onNavigate} />;
    case 'edges-list':
      return <EdgesListView data={artifact.data as Record<string, unknown>} onNavigate={onNavigate} />;
    case 'traverse':
      return <TraverseView data={artifact.data as Record<string, unknown>} onNavigate={onNavigate} />;
    case 'search':
      return <SearchView data={artifact.data as Record<string, unknown>} onNavigate={onNavigate} />;
    case 'schema':
      return <SchemaView data={artifact.data as Record<string, unknown>} />;
    default:
      return <JsonView data={(artifact.data ?? {}) as Record<string, unknown>} defaultExpanded />;
  }
}

// ---------------------------------------------------------------------------
// Node Detail View
// ---------------------------------------------------------------------------

function NodeDetailView({
  data,
  viewRegistry,
  config,
  onNavigate,
}: {
  data: Record<string, unknown>;
  viewRegistry: ViewRegistryData;
  config: AppConfig;
  onNavigate: (uid: string) => void;
}) {
  const node = data.node as SummarizedRecord | null;

  if (!node) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
        <h2 className="text-lg font-semibold mb-2">Node Not Found</h2>
        <p className="text-sm text-slate-400">The queried node was not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(node.type)}`}>
          {node.type}
        </span>
        <h1 className="text-xl font-bold font-mono">{node.uid}</h1>
        <button
          onClick={() => onNavigate(node.uid)}
          className="ml-auto px-3 py-1.5 bg-indigo-600/20 text-indigo-400 rounded-lg text-xs hover:bg-indigo-600/30 transition-colors"
        >
          View full details
        </button>
      </div>

      {/* Data card — same component used on the node page */}
      <NodeDataCard
        nodeType={node.type}
        data={node.data ?? {}}
        viewRegistry={viewRegistry}
        config={config}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nodes List View
// ---------------------------------------------------------------------------

function NodesListView({
  data,
  onNavigate,
}: {
  data: Record<string, unknown>;
  onNavigate: (uid: string) => void;
}) {
  const nodes = (data.nodes ?? []) as SummarizedRecord[];
  const hasMore = data.hasMore as boolean | undefined;

  return (
    <div className="space-y-2">
      {nodes.map((node, i) => (
        <div key={i} className="bg-slate-900 rounded-lg border border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(node.type)}`}>
              {node.type}
            </span>
            <button
              onClick={() => onNavigate(node.uid)}
              className="font-mono text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {node.uid}
            </button>
          </div>
          {node.data && Object.keys(node.data).length > 0 && (
            <div className="mt-1">
              <JsonView data={node.data} defaultExpanded={false} />
            </div>
          )}
        </div>
      ))}
      {hasMore && (
        <p className="text-[10px] text-slate-500 text-center py-1">Results truncated — use a higher limit to see more</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edges List View
// ---------------------------------------------------------------------------

function EdgesListView({
  data,
  onNavigate,
}: {
  data: Record<string, unknown>;
  onNavigate: (uid: string) => void;
}) {
  const edges = (data.edges ?? []) as SummarizedEdge[];
  const hasMore = data.hasMore as boolean | undefined;

  return (
    <div className="space-y-1">
      <EdgeList edges={edges} onNavigate={onNavigate} />
      {hasMore && (
        <p className="text-[10px] text-slate-500 text-center py-1">Results truncated — use a higher limit to see more</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Traverse View
// ---------------------------------------------------------------------------

function TraverseView({
  data,
  onNavigate,
}: {
  data: Record<string, unknown>;
  onNavigate: (uid: string) => void;
}) {
  const hops = (data.hops ?? []) as {
    relation: string;
    direction: string;
    depth: number;
    edgeCount: number;
    edges: SummarizedEdge[];
    truncated: boolean;
  }[];
  const totalReads = data.totalReads as number | undefined;

  return (
    <div className="space-y-4">
      {hops.map((hop, i) => (
        <Section
          key={i}
          title={`Hop ${hop.depth}: ${hop.relation} (${hop.direction})`}
          badge={`${hop.edgeCount} edges`}
        >
          <EdgeList edges={hop.edges} onNavigate={onNavigate} />
          {hop.truncated && (
            <p className="text-[10px] text-amber-500 mt-1">Truncated — increase limit to see more</p>
          )}
        </Section>
      ))}
      {totalReads != null && (
        <p className="text-[10px] text-slate-500 text-right">{totalReads} total reads</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search View
// ---------------------------------------------------------------------------

function SearchView({
  data,
  onNavigate,
}: {
  data: Record<string, unknown>;
  onNavigate: (uid: string) => void;
}) {
  const results = (data.results ?? []) as (SummarizedRecord & { matchType: string | null })[];

  if (results.length === 0) {
    return <p className="text-slate-400 text-sm">No results found</p>;
  }

  return (
    <div className="space-y-2">
      {results.map((r, i) => (
        <div key={i} className="bg-slate-900 rounded-lg border border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(r.type)}`}>
              {r.type}
            </span>
            <button
              onClick={() => onNavigate(r.uid)}
              className="font-mono text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              {r.uid}
            </button>
            {r.matchType && (
              <span className="text-[9px] text-slate-500 ml-auto">{r.matchType}</span>
            )}
          </div>
          {r.data && Object.keys(r.data).length > 0 && (
            <div className="mt-1">
              <JsonView data={r.data} defaultExpanded={false} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schema View
// ---------------------------------------------------------------------------

function SchemaView({ data }: { data: Record<string, unknown> }) {
  const nodeTypes = (data.nodeTypes ?? []) as string[];
  const edgeTypes = (data.edgeTypes ?? []) as { relation: string; from: string; to: string; inverseLabel: string | null }[];

  return (
    <div className="space-y-4">
      <Section title={`Node Types (${nodeTypes.length})`}>
        <div className="flex flex-wrap gap-1.5">
          {nodeTypes.map((t) => (
            <span key={t} className={`px-2 py-0.5 rounded text-xs font-mono ${getTypeBadgeColor(t)}`}>
              {t}
            </span>
          ))}
        </div>
      </Section>

      <Section title={`Edge Types (${edgeTypes.length})`}>
        <div className="space-y-1">
          {edgeTypes.map((e, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs font-mono">
              <span className={`px-1 py-0.5 rounded text-[10px] ${getTypeBadgeColor(e.from)}`}>{e.from}</span>
              <span className="text-slate-500">--[</span>
              <span className="text-indigo-400">{e.relation}</span>
              <span className="text-slate-500">]--&gt;</span>
              <span className={`px-1 py-0.5 rounded text-[10px] ${getTypeBadgeColor(e.to)}`}>{e.to}</span>
              {e.inverseLabel && (
                <span className="text-[10px] text-slate-600 ml-1">({e.inverseLabel})</span>
              )}
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared Components
// ---------------------------------------------------------------------------

function Section({
  title,
  badge,
  trailing,
  children,
}: {
  title: string;
  badge?: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="bg-slate-900 rounded-xl border border-slate-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
          {badge && (
            <span className="text-[10px] text-slate-500">{badge}</span>
          )}
        </div>
        {trailing}
      </div>
      {children}
    </section>
  );
}

function EdgeList({
  edges,
  onNavigate,
}: {
  edges: SummarizedEdge[];
  onNavigate: (uid: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  return (
    <div className="space-y-0.5">
      {edges.map((edge, i) => (
        <div key={i}>
          <div className="flex items-center gap-1.5 py-1.5 text-xs">
            <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(edge.fromType)}`}>
              {edge.fromType}
            </span>
            <button
              onClick={() => onNavigate(edge.fromUid)}
              className="font-mono text-indigo-400 hover:text-indigo-300 transition-colors truncate max-w-[100px]"
              title={edge.fromUid}
            >
              {edge.fromUid}
            </button>
            <span className="text-slate-500 shrink-0">--[</span>
            <span className="text-indigo-400 shrink-0">{edge.relation}</span>
            <span className="text-slate-500 shrink-0">]--&gt;</span>
            <span className={`px-1 py-0.5 rounded text-[10px] font-mono ${getTypeBadgeColor(edge.toType)}`}>
              {edge.toType}
            </span>
            <button
              onClick={() => onNavigate(edge.toUid)}
              className="font-mono text-indigo-400 hover:text-indigo-300 transition-colors truncate max-w-[100px]"
              title={edge.toUid}
            >
              {edge.toUid}
            </button>
            {edge.data && Object.keys(edge.data).length > 0 && (
              <button
                onClick={() => {
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  });
                }}
                className="text-[10px] text-slate-500 hover:text-slate-300 ml-auto shrink-0"
              >
                {expanded.has(i) ? 'hide' : 'data'}
              </button>
            )}
          </div>
          {expanded.has(i) && edge.data && (
            <div className="ml-4 mb-1">
              <JsonView data={edge.data} defaultExpanded />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
