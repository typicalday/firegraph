import { Fragment, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDrill, type DrillFrame, type Lane } from './drill-context';
import { useScope } from './scope-context';
import { getTypeBadgeColor } from '../utils';
import type { PeekPosition } from './DrillStack';
import type { Schema } from '../types';

interface Props {
  peek: PeekPosition | null;
  onPeek: (laneId: string, frameIndex: number) => void;
  schema: Schema;
}

// --- Trie ---

interface TrieNode {
  frame: DrillFrame;
  depth: number;
  laneIds: string[];
  children: TrieNode[];
}

function buildTrie(lanes: Lane[]): TrieNode | null {
  if (lanes.length === 0 || lanes[0].frames.length === 0) return null;

  function buildChildren(parentLanes: Lane[], depth: number): TrieNode[] {
    const groups = new Map<string, Lane[]>();
    for (const lane of parentLanes) {
      if (depth >= lane.frames.length) continue;
      const uid = lane.frames[depth].uid;
      if (!groups.has(uid)) groups.set(uid, []);
      groups.get(uid)!.push(lane);
    }

    return Array.from(groups.values()).map((groupLanes) => ({
      frame: groupLanes[0].frames[depth],
      depth,
      laneIds: groupLanes.map((l) => l.id),
      children: buildChildren(groupLanes, depth + 1),
    }));
  }

  return {
    frame: lanes[0].frames[0],
    depth: 0,
    laneIds: lanes.map((l) => l.id),
    children: buildChildren(lanes, 1),
  };
}

// --- Component ---

/**
 * Tree-style breadcrumb that merges common lane prefixes.
 *
 * Shared frames are rendered once and vertically centered across
 * descendant branches. All frames are interactive — clicking navigates,
 * hovering peeks.
 */
export default function DrillBreadcrumb({ peek, onPeek, schema }: Props) {
  const navigate = useNavigate();
  const { lanes, activeLaneId, activeIndex, previewLaneId, popTo, closeLane, switchLane } = useDrill();
  const { scopedPath } = useScope();

  const inverseLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const et of schema.edgeTypes) {
      if (et.inverseLabel) map[et.axbType] = et.inverseLabel;
    }
    return map;
  }, [schema.edgeTypes]);

  // Strip preview frame from lanes so it never appears in the breadcrumb
  const visibleLanes = useMemo(() => {
    if (!previewLaneId) return lanes;
    return lanes.map((l) =>
      l.id === previewLaneId ? { ...l, frames: l.frames.slice(0, -1) } : l,
    );
  }, [lanes, previewLaneId]);

  const trie = useMemo(() => buildTrie(visibleLanes), [visibleLanes]);

  const showBreadcrumbs =
    visibleLanes.length > 1 || (visibleLanes.length === 1 && visibleLanes[0].frames.length > 1);

  if (!showBreadcrumbs || !trie) return null;

  const multiLane = visibleLanes.length > 1;
  const visualLaneId = peek?.laneId ?? activeLaneId;
  const visualIndex = peek?.frameIndex ?? activeIndex;

  /** Pick the best lane for interactions on a shared node. */
  function bestLaneFor(node: TrieNode): string {
    if (node.laneIds.includes(activeLaneId)) return activeLaneId;
    return node.laneIds[0];
  }

  /** Edge label between parent and child frame. */
  function renderEdgeLabel(frame: DrillFrame): ReactNode {
    return (
      <span className="text-slate-600 font-mono mx-0.5 shrink-0">
        {frame.direction === 'out' ? (
          <>
            <span className="text-indigo-500/60">{frame.edgeType}</span>
            <span className="ml-0.5">&rarr;</span>
          </>
        ) : inverseLabelMap[frame.edgeType] ? (
          <>
            <span className="text-amber-500/60 cursor-help" title={`Inverse of: ${frame.edgeType}`}>
              {inverseLabelMap[frame.edgeType]}
            </span>
            <span className="ml-0.5">&rarr;</span>
          </>
        ) : (
          <>
            <span className="mr-0.5">&larr;</span>
            <span className="text-indigo-500/60">{frame.edgeType}</span>
          </>
        )}
      </span>
    );
  }

  /** Clickable frame button. */
  function renderFrameButton(node: TrieNode): ReactNode {
    const laneId = bestLaneFor(node);
    const isActive = node.laneIds.includes(activeLaneId) && node.depth === activeIndex;
    const isHighlighted = node.laneIds.includes(visualLaneId) && node.depth === visualIndex;
    return (
      <button
        onClick={() => {
          if (isActive) {
            // "Go to" — navigate fresh, resetting the drill context
            navigate(scopedPath(`/node/${encodeURIComponent(node.frame.uid)}`));
          } else {
            switchLane(laneId);
            popTo(laneId, node.depth);
          }
        }}
        onMouseEnter={() => onPeek(laneId, node.depth)}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0 ${
          isHighlighted
            ? 'bg-slate-800 text-slate-200'
            : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
        }`}
      >
        {node.frame.nodeType && (
          <span className={`px-1 py-px rounded text-[9px] font-mono ${getTypeBadgeColor(node.frame.nodeType)}`}>
            {node.frame.nodeType}
          </span>
        )}
        <span className="font-mono truncate max-w-[120px]">{node.frame.uid}</span>
      </button>
    );
  }

  /**
   * Recursively render a trie node: flatten single-child chains into an
   * inline run, then branch when children > 1.
   */
  function renderSubtree(node: TrieNode, isFirst: boolean): ReactNode {
    // Flatten linear chain (single child at each step)
    const run: TrieNode[] = [node];
    let tip = node;
    while (tip.children.length === 1) {
      tip = tip.children[0];
      run.push(tip);
    }

    return (
      <>
        {/* Linear segment */}
        {run.map((n, i) => (
          <Fragment key={n.depth}>
            {(i > 0 || !isFirst) && renderEdgeLabel(n.frame)}
            {renderFrameButton(n)}
          </Fragment>
        ))}

        {/* Branch point */}
        {tip.children.length > 1 && (
          <div className="flex flex-col border-l border-slate-700/50 ml-1.5 my-0.5">
            {tip.children.map((child, i) => {
              const branchActive = child.laneIds.includes(activeLaneId);
              return (
                <div
                  key={i}
                  className={`flex items-center transition-opacity ${
                    !branchActive && multiLane ? 'opacity-50 hover:opacity-80' : ''
                  }`}
                >
                  <span className="w-2 h-px bg-slate-700/50 shrink-0" />
                  {renderSubtree(child, false)}
                </div>
              );
            })}
          </div>
        )}

        {/* Close button at leaf */}
        {tip.children.length === 0 && multiLane && (
          <button
            onClick={(e) => { e.stopPropagation(); closeLane(tip.laneIds[0]); }}
            className="ml-1 text-slate-600 hover:text-slate-400 transition-colors shrink-0 text-sm leading-none"
            title="Close this lane"
          >
            &times;
          </button>
        )}
      </>
    );
  }

  return (
    <nav
      className="flex items-center px-4 py-2 bg-slate-900/80 border-b border-slate-800 overflow-x-auto overflow-y-auto max-h-32 text-xs"
    >
      {renderSubtree(trie, true)}
    </nav>
  );
}
