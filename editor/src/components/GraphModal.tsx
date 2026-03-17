import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import cytoscape, { type Core, type ElementDefinition, type LayoutOptions } from 'cytoscape';
import type { GraphRecord, ViewRegistryData, AppConfig, Schema } from '../types';
import { getTypeHexColor, resolveViewForEntity, scopeInput } from '../utils';
import { trpc } from '../trpc';
import { useFocusMaybe } from './focus-context';
import { useScope } from './scope-context';
import CustomView from './CustomView';
import JsonView from './JsonView';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface GraphModalProps {
  /** Focus node — if provided, used for label + data. Otherwise a placeholder is built from focusUid. */
  node?: GraphRecord | null;
  /** Required when `node` is not provided (e.g. standalone traversal page). */
  focusUid?: string;
  /** Explicit edges to render. When provided, FocusContext is NOT used. */
  edges?: GraphRecord[];
  /** Schema — used to resolve titleField/subtitleField per entity type. */
  schema?: Schema;
  viewRegistry?: ViewRegistryData | null;
  config?: AppConfig;
  onClose: () => void;
  onNodeClick: (uid: string, nodeType: string) => void;
}

const EMPTY_CONFIG: AppConfig = { projectId: '', collection: '', readonly: true };

// ---------------------------------------------------------------------------
// Data transformation
// ---------------------------------------------------------------------------

/** Well-known display fields, checked first in priority order. */
const PREFERRED_LABEL_KEYS = ['title', 'name', 'label', 'displayName', 'summary', 'description', 'text', 'subject'];

/**
 * Build a lookup from node/edge type → { titleField, subtitleField } from schema metadata.
 * Node schemas are keyed by aType (since axbType='is'), edge schemas by axbType.
 */
function buildDisplayFieldMap(schema?: Schema): Record<string, { titleField?: string; subtitleField?: string }> {
  const map: Record<string, { titleField?: string; subtitleField?: string }> = {};
  if (!schema) return map;
  for (const n of schema.nodeSchemas ?? []) {
    if (n.titleField || n.subtitleField) {
      map[n.aType] = { titleField: n.titleField, subtitleField: n.subtitleField };
    }
  }
  for (const e of schema.edgeSchemas ?? []) {
    if (e.titleField || e.subtitleField) {
      map[e.axbType] = { titleField: e.titleField, subtitleField: e.subtitleField };
    }
  }
  return map;
}

function pickLabel(
  data: Record<string, unknown>,
  uid: string,
  titleField?: string,
): string {
  const truncate = (s: string) => (s.length > 24 ? s.slice(0, 22) + '\u2026' : s);

  // 0. Schema-configured titleField takes priority
  if (titleField) {
    const v = data[titleField];
    if (typeof v === 'string' && v.length > 0) return truncate(v);
    if (typeof v === 'number' || typeof v === 'boolean') return truncate(String(v));
  }

  // 1. Check well-known keys
  for (const key of PREFERRED_LABEL_KEYS) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return truncate(v);
  }

  // 2. Fall back to the first short string value in the data
  for (const v of Object.values(data)) {
    if (typeof v === 'string' && v.length > 0 && v.length <= 80) return truncate(v);
  }

  return uid.slice(0, 8);
}

type DisplayFieldMap = Record<string, { titleField?: string; subtitleField?: string }>;

function pickNodeLabel(
  data: Record<string, unknown>,
  uid: string,
  nodeType: string,
  dfm: DisplayFieldMap,
): string {
  return pickLabel(data, uid, dfm[nodeType]?.titleField);
}

function graphDataToElements(
  node: GraphRecord,
  outEdges: GraphRecord[],
  inEdges: GraphRecord[],
  resolvedNodes: Record<string, GraphRecord | null>,
  dfm: DisplayFieldMap,
): ElementDefinition[] {
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();

  // Focus node
  seenNodes.add(node.aUid);
  nodes.push({
    data: {
      id: node.aUid,
      label: pickNodeLabel(node.data as Record<string, unknown>, node.aUid, node.aType, dfm),
      nodeType: node.aType,
      isFocus: true,
    },
  });

  // Outgoing edges — target nodes on bUid side
  for (const edge of outEdges) {
    if (!seenNodes.has(edge.bUid)) {
      seenNodes.add(edge.bUid);
      const resolved = resolvedNodes[edge.bUid];
      nodes.push({
        data: {
          id: edge.bUid,
          label: resolved
            ? pickNodeLabel(resolved.data as Record<string, unknown>, edge.bUid, edge.bType, dfm)
            : edge.bUid.slice(0, 8),
          nodeType: edge.bType,
        },
      });
    }
    const edgeId = `${edge.aUid}:${edge.axbType}:${edge.bUid}`;
    if (!seenEdges.has(edgeId)) {
      seenEdges.add(edgeId);
      edges.push({
        data: {
          id: edgeId,
          source: edge.aUid,
          target: edge.bUid,
          label: edge.axbType,
          edgeType: edge.axbType,
        },
      });
    }
  }

  // Incoming edges — source nodes on aUid side
  for (const edge of inEdges) {
    if (!seenNodes.has(edge.aUid)) {
      seenNodes.add(edge.aUid);
      const resolved = resolvedNodes[edge.aUid];
      nodes.push({
        data: {
          id: edge.aUid,
          label: resolved
            ? pickNodeLabel(resolved.data as Record<string, unknown>, edge.aUid, edge.aType, dfm)
            : edge.aUid.slice(0, 8),
          nodeType: edge.aType,
        },
      });
    }
    const edgeId = `${edge.aUid}:${edge.axbType}:${edge.bUid}`;
    if (!seenEdges.has(edgeId)) {
      seenEdges.add(edgeId);
      edges.push({
        data: {
          id: edgeId,
          source: edge.aUid,
          target: edge.bUid,
          label: edge.axbType,
          edgeType: edge.axbType,
        },
      });
    }
  }

  return [...nodes, ...edges];
}

/**
 * Build Cytoscape elements from a flat list of directed edges (e.g. traversal results).
 * All edges have aUid→bUid direction. The focus node is identified by `focusUid`.
 */
function traversalEdgesToElements(
  focusUid: string,
  allEdges: GraphRecord[],
  resolvedNodes: Record<string, GraphRecord | null>,
  dfm: DisplayFieldMap,
): ElementDefinition[] {
  const nodes: ElementDefinition[] = [];
  const edges: ElementDefinition[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();

  // Ensure focus node exists
  if (!seenNodes.has(focusUid)) {
    seenNodes.add(focusUid);
    const resolved = resolvedNodes[focusUid];
    nodes.push({
      data: {
        id: focusUid,
        label: resolved
          ? pickNodeLabel(resolved.data as Record<string, unknown>, focusUid, resolved.aType, dfm)
          : focusUid.slice(0, 8),
        nodeType: resolved?.aType ?? '',
        isFocus: true,
      },
    });
  }

  for (const edge of allEdges) {
    // Source node
    if (!seenNodes.has(edge.aUid)) {
      seenNodes.add(edge.aUid);
      const resolved = resolvedNodes[edge.aUid];
      nodes.push({
        data: {
          id: edge.aUid,
          label: resolved
            ? pickNodeLabel(resolved.data as Record<string, unknown>, edge.aUid, edge.aType, dfm)
            : edge.aUid.slice(0, 8),
          nodeType: edge.aType,
        },
      });
    }
    // Target node
    if (!seenNodes.has(edge.bUid)) {
      seenNodes.add(edge.bUid);
      const resolved = resolvedNodes[edge.bUid];
      nodes.push({
        data: {
          id: edge.bUid,
          label: resolved
            ? pickNodeLabel(resolved.data as Record<string, unknown>, edge.bUid, edge.bType, dfm)
            : edge.bUid.slice(0, 8),
          nodeType: edge.bType,
        },
      });
    }
    // Edge
    const edgeId = `${edge.aUid}:${edge.axbType}:${edge.bUid}`;
    if (!seenEdges.has(edgeId)) {
      seenEdges.add(edgeId);
      edges.push({
        data: {
          id: edgeId,
          source: edge.aUid,
          target: edge.bUid,
          label: edge.axbType,
          edgeType: edge.axbType,
        },
      });
    }
  }

  return [...nodes, ...edges];
}

// ---------------------------------------------------------------------------
// Cytoscape stylesheet
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cytoscape's stylesheet types are overly restrictive
const STYLESHEET: any[] = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(color)',
      'label': 'data(label)',
      'color': '#e2e8f0',
      'text-valign': 'bottom',
      'text-halign': 'center',
      'font-size': '11px',
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'text-margin-y': 6,
      'text-outline-color': '#020617',
      'text-outline-width': 2,
      'width': 28,
      'height': 28,
      'border-width': 2,
      'border-color': '#334155',
    },
  },
  {
    selector: 'node[?isFocus]',
    style: {
      'width': 42,
      'height': 42,
      'border-width': 3,
      'border-color': '#818cf8',
      'font-size': '13px',
      'font-weight': 'bold' as const,
    },
  },
  {
    selector: 'edge',
    style: {
      'width': 1.5,
      'line-color': '#475569',
      'target-arrow-color': '#475569',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'label': 'data(label)',
      'color': '#94a3b8',
      'font-size': '9px',
      'font-family': 'ui-monospace, SFMono-Regular, Menlo, monospace',
      'text-rotation': 'autorotate',
      'text-background-color': '#0f172a',
      'text-background-opacity': 0.85,
      'text-background-padding': '2px',
      'text-background-shape': 'round-rectangle',
    },
  },
  {
    selector: 'node:active',
    style: {
      'overlay-color': '#818cf8',
      'overlay-padding': 4,
      'overlay-opacity': 0.2,
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-color': '#818cf8',
      'border-width': 3,
    },
  },
];

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

type LayoutName = 'concentric' | 'cose' | 'breadthfirst';

function buildLayout(name: LayoutName, focusUid: string): LayoutOptions {
  switch (name) {
    case 'concentric':
      return {
        name: 'concentric',
        concentric: (node: cytoscape.NodeSingular) => (node.id() === focusUid ? 10 : 1),
        levelWidth: () => 1,
        minNodeSpacing: 50,
        animate: true,
        animationDuration: 300,
      } as LayoutOptions;
    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        roots: `#${CSS.escape(focusUid)}`,
        directed: true,
        spacingFactor: 1.25,
        animate: true,
        animationDuration: 300,
      } as LayoutOptions;
    case 'cose':
    default:
      return {
        name: 'cose',
        animate: true,
        animationDuration: 300,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 80,
        gravity: 0.25,
      } as LayoutOptions;
  }
}

// ---------------------------------------------------------------------------
// Tooltip hover state
// ---------------------------------------------------------------------------

interface HoveredNode {
  kind: 'node';
  uid: string;
  nodeType: string;
  x: number;
  y: number;
}

interface HoveredEdge {
  kind: 'edge';
  edgeId: string;
  edgeType: string;
  x: number;
  y: number;
}

type HoveredElement = HoveredNode | HoveredEdge | null;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function GraphModal({
  node,
  focusUid: focusUidProp,
  edges: explicitEdges,
  schema,
  viewRegistry,
  config: configProp,
  onClose,
  onNodeClick,
}: GraphModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [layout, setLayout] = useState<LayoutName>('breadthfirst');
  const [hovered, setHovered] = useState<HoveredElement>(null);

  const config = configProp ?? EMPTY_CONFIG;
  const { scopePath } = useScope();

  // Determine the focus UID — from `node` prop or explicit `focusUid`
  const effectiveFocusUid = node?.aUid ?? focusUidProp ?? '';

  // Two modes: explicit edges (traversal) or FocusContext (node detail page)
  const focus = useFocusMaybe();
  const isExplicitMode = !!explicitEdges;
  const allExplicitEdges = explicitEdges ?? [];
  const outEdges = isExplicitMode ? [] : (focus?.edgeResults.out.edges ?? []);
  const inEdges = isExplicitMode ? [] : (focus?.edgeResults.in.edges ?? []);

  // Collect all UIDs that need batch resolution
  const neighborUids = useMemo(() => {
    const uids = new Set<string>();
    if (isExplicitMode) {
      // Traversal: all aUid and bUid from every edge
      for (const edge of allExplicitEdges) {
        uids.add(edge.aUid);
        uids.add(edge.bUid);
      }
      // Also include the focus UID so we can resolve its label
      uids.add(effectiveFocusUid);
    } else {
      // Node detail: neighbor nodes only
      for (const edge of outEdges) uids.add(edge.bUid);
      for (const edge of inEdges) uids.add(edge.aUid);
    }
    // If we already have the focus node data, no need to re-fetch
    if (node) uids.delete(node.aUid);
    return [...uids];
  }, [isExplicitMode, allExplicitEdges, outEdges, inEdges, node, effectiveFocusUid]);

  // Batch-fetch node data for labels and tooltips
  const { data: batchData } = trpc.getNodesBatch.useQuery(
    { uids: neighborUids, ...scopeInput(scopePath) },
    { enabled: neighborUids.length > 0 },
  );
  const resolvedNodes = useMemo(() => {
    const map = (batchData?.nodes ?? {}) as Record<string, GraphRecord | null>;
    // If we have the focus node from props, inject it
    if (node) map[node.aUid] = node;
    return map;
  }, [batchData, node]);

  // Build edge data lookup for tooltip
  const allEdgesForTooltip = isExplicitMode ? allExplicitEdges : [...outEdges, ...inEdges];
  const edgeDataMap = useMemo(() => {
    const map: Record<string, { edgeType: string; data: Record<string, unknown>; aType: string; bType: string }> = {};
    for (const edge of allEdgesForTooltip) {
      const id = `${edge.aUid}:${edge.axbType}:${edge.bUid}`;
      if (!map[id]) {
        map[id] = {
          edgeType: edge.axbType,
          data: edge.data as Record<string, unknown>,
          aType: edge.aType,
          bType: edge.bType,
        };
      }
    }
    return map;
  }, [allEdgesForTooltip]);

  const displayFieldMap = useMemo(() => buildDisplayFieldMap(schema), [schema]);

  const elements = useMemo(() => {
    if (isExplicitMode) {
      return traversalEdgesToElements(effectiveFocusUid, allExplicitEdges, resolvedNodes, displayFieldMap);
    }
    return graphDataToElements(node!, outEdges, inEdges, resolvedNodes, displayFieldMap);
  }, [isExplicitMode, effectiveFocusUid, allExplicitEdges, node, outEdges, inEdges, resolvedNodes, displayFieldMap]);
  const nodeCount = elements.filter((e) => !e.data.source).length;
  const edgeCount = elements.filter((e) => e.data.source).length;

  // Assign colors to node elements (must be in data for stylesheet to read)
  for (const el of elements) {
    if (!el.data.source && el.data.nodeType) {
      el.data.color = getTypeHexColor(el.data.nodeType as string);
    }
  }

  // Escape key to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Initialize and update Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous instance if any
    if (cyRef.current) {
      cyRef.current.destroy();
      cyRef.current = null;
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: STYLESHEET,
      layout: buildLayout(layout, effectiveFocusUid),
      minZoom: 0.2,
      maxZoom: 4,
      wheelSensitivity: 0.3,
    });

    // Click handler
    cy.on('tap', 'node', (evt) => {
      const tapped = evt.target;
      const uid = tapped.id();
      const nodeType = tapped.data('nodeType') as string;
      if (uid === effectiveFocusUid) return;
      onNodeClick(uid, nodeType);
    });

    // Tooltip hover handlers
    cy.on('mouseover', 'node', (evt) => {
      const el = evt.target;
      const origEvent = evt.originalEvent as MouseEvent;
      setHovered({
        kind: 'node',
        uid: el.id(),
        nodeType: el.data('nodeType') as string,
        x: origEvent.clientX,
        y: origEvent.clientY,
      });
    });

    cy.on('mouseover', 'edge', (evt) => {
      const el = evt.target;
      const origEvent = evt.originalEvent as MouseEvent;
      setHovered({
        kind: 'edge',
        edgeId: el.id(),
        edgeType: el.data('edgeType') as string,
        x: origEvent.clientX,
        y: origEvent.clientY,
      });
    });

    cy.on('mouseout', 'node, edge', () => {
      setHovered(null);
    });

    // Hide tooltip on pan/zoom
    cy.on('viewport', () => setHovered(null));

    cyRef.current = cy;

    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, effectiveFocusUid, elements.length]);

  const handleFit = useCallback(() => {
    cyRef.current?.fit(undefined, 40);
  }, []);

  // Collect unique node types for the legend
  const nodeTypes = [...new Set(elements.filter((e) => !e.data.source).map((e) => e.data.nodeType as string))];

  // Resolve tooltip content
  const tooltipContent = useMemo(() => {
    if (!hovered) return null;

    if (hovered.kind === 'node') {
      const { uid, nodeType } = hovered;
      const nodeData: Record<string, unknown> =
        (node && uid === node.aUid)
          ? (node.data as Record<string, unknown>)
          : ((resolvedNodes[uid]?.data as Record<string, unknown>) ?? null);

      if (!nodeData) {
        return { title: `${nodeType}  ${uid}`, tagName: null, data: null };
      }

      // Resolve the best view for this node type
      const views = viewRegistry?.nodes[nodeType]?.views ?? [];
      const viewDefaults = config.viewDefaults?.nodes?.[nodeType];
      const viewName = resolveViewForEntity(viewDefaults, views);
      const tagName = viewName !== 'json'
        ? views.find((v) => v.viewName === viewName)?.tagName ?? null
        : null;

      return { title: `${nodeType}  ${uid}`, tagName, data: nodeData };
    }

    // Edge
    const { edgeId, edgeType } = hovered;
    const edgeInfo = edgeDataMap[edgeId];
    if (!edgeInfo) return null;

    const views = viewRegistry?.edges[edgeType]?.views ?? [];
    const viewDefaults = config.viewDefaults?.edges?.[edgeType];
    const viewName = resolveViewForEntity(viewDefaults, views);
    const tagName = viewName !== 'json'
      ? views.find((v) => v.viewName === viewName)?.tagName ?? null
      : null;

    return {
      title: `${edgeInfo.aType} \u2014[${edgeType}]\u2192 ${edgeInfo.bType}`,
      tagName,
      data: edgeInfo.data,
    };
  }, [hovered, node, resolvedNodes, viewRegistry, config, edgeDataMap]);

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: '90vw', height: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-700/60 bg-slate-900/80 shrink-0">
          <span className="text-sm font-medium text-slate-200">Graph</span>
          <span className="text-xs text-slate-500">
            {nodeCount} nodes, {edgeCount} edges
          </span>

          <div className="ml-auto flex items-center gap-2">
            {/* Layout picker */}
            <select
              value={layout}
              onChange={(e) => setLayout(e.target.value as LayoutName)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1 text-xs text-slate-300 focus:outline-none focus:border-slate-500"
            >
              <option value="breadthfirst">Tree</option>
              <option value="concentric">Concentric</option>
              <option value="cose">Force-directed</option>
            </select>

            {/* Fit button */}
            <button
              onClick={handleFit}
              className="px-2.5 py-1 bg-slate-800 border border-slate-700 text-slate-300 rounded-lg text-xs hover:bg-slate-700 transition-colors"
              title="Fit to viewport"
            >
              Fit
            </button>

            {/* Close button */}
            <button
              onClick={onClose}
              className="px-2 py-1 text-slate-400 hover:text-slate-200 transition-colors text-lg leading-none"
              title="Close"
            >
              &times;
            </button>
          </div>
        </div>

        {/* Cytoscape container */}
        <div ref={containerRef} className="flex-1 bg-slate-950" />

        {/* Legend */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-slate-700/60 bg-slate-900/80 shrink-0 overflow-x-auto">
          {nodeTypes.map((t) => (
            <span key={t} className="flex items-center gap-1.5 text-xs text-slate-400 whitespace-nowrap">
              <span
                className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: getTypeHexColor(t) }}
              />
              {t}
            </span>
          ))}
          <span className="text-xs text-slate-600 ml-auto whitespace-nowrap">
            Click a node to drill in
          </span>
        </div>
      </div>

      {/* Tooltip — rendered via React so we can use CustomView */}
      {hovered && tooltipContent && tooltipContent.data && (
        <GraphTooltip x={hovered.x} y={hovered.y} title={tooltipContent.title} tagName={tooltipContent.tagName} data={tooltipContent.data} />
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// GraphTooltip — positioned card with CustomView or JsonView
// ---------------------------------------------------------------------------

function GraphTooltip({
  x,
  y,
  title,
  tagName,
  data,
}: {
  x: number;
  y: number;
  title: string;
  tagName: string | null;
  data: Record<string, unknown>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 12, top: y + 12 });
  const [viewFailed, setViewFailed] = useState(false);

  // Reposition after first render to avoid overflowing viewport
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 12;
    let left = x + pad;
    let top = y + pad;
    if (left + rect.width > window.innerWidth - pad) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - pad) top = y - rect.height - pad;
    setPos({ left, top });
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="fixed z-[60] max-w-sm rounded-lg border border-slate-600 bg-slate-900 shadow-2xl overflow-hidden pointer-events-none"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-3 py-1.5 border-b border-slate-700/60 text-xs text-slate-400 font-mono truncate">
        {title}
      </div>
      {/* Body */}
      <div className="p-2 max-h-64 overflow-auto">
        {tagName && !viewFailed ? (
          <CustomView tagName={tagName} data={data} onError={() => setViewFailed(true)} />
        ) : (
          <div className="text-xs font-mono">
            <JsonView data={data} defaultExpanded depth={0} />
          </div>
        )}
      </div>
    </div>
  );
}
