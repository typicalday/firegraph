import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Schema, ViewRegistryData, AppConfig } from '../types';
import { useDrill, DrillOverrideContext, type DrillFrame, type Lane } from './drill-context';
import DrillBreadcrumb from './DrillBreadcrumb';
import { NodeDetailContent } from './NodeDetail';

interface Props {
  schema: Schema;
  viewRegistry?: ViewRegistryData | null;
  config: AppConfig;
  onDataChanged?: () => void;
}

export interface PeekPosition {
  laneId: string;
  frameIndex: number;
}

/**
 * How many leading frames of `lane` match `desired` (compared by uid)?
 */
function prefixMatchLength(lane: DrillFrame[], desired: DrillFrame[]): number {
  const len = Math.min(lane.length, desired.length);
  for (let i = 0; i < len; i++) {
    if (lane[i].uid !== desired[i].uid) return i;
  }
  return len;
}

/**
 * Perspective container that renders one NodeDetailContent **per unique uid**
 * across all lanes. The same DOM element is reused regardless of which lane
 * is active, so stateful UI (expanded traversals, resolved nodes, etc.)
 * persists when the user switches lanes or creates new ones.
 *
 * Provides a DrillOverrideContext so EdgeRow's drillIn/drillPath are
 * peek-aware and use smart prefix matching for multi-frame paths.
 */
export default function DrillStack({ schema, viewRegistry, config, onDataChanged }: Props) {
  const {
    lanes, activeLaneId, activeLane, activeIndex,
    extendLane, extendPath, forkAndDrill, createLane,
    switchLane, popTo: ctxPopTo,
  } = useDrill();

  const [peek, setPeek] = useState<PeekPosition | null>(null);
  const enteringUidRef = useRef<string | null>(null);
  const prevUidSetRef = useRef<Set<string>>(new Set());
  const [, setTick] = useState(0);
  const frameRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Clear peek when active lane changes
  useEffect(() => {
    setPeek(null);
  }, [activeLaneId, activeIndex]);

  // Visual position: peek overrides active
  const visualLaneId = peek?.laneId ?? activeLaneId;
  const visualIndex = peek?.frameIndex ?? activeIndex;

  const vLane = useMemo(
    () => lanes.find((l) => l.id === visualLaneId) ?? lanes[0],
    [lanes, visualLaneId],
  );

  const activeUid = vLane?.frames[visualIndex]?.uid;

  // Collect all unique UIDs across every lane (stable order)
  const uniqueUids = useMemo(() => {
    const seen = new Set<string>();
    const uids: string[] = [];
    for (const lane of lanes) {
      for (const frame of lane.frames) {
        if (!seen.has(frame.uid)) {
          seen.add(frame.uid);
          uids.push(frame.uid);
        }
      }
    }
    return uids;
  }, [lanes]);

  // Scroll the newly visible frame to top
  useEffect(() => {
    if (!activeUid) return;
    const el = frameRefs.current.get(activeUid);
    if (el) el.scrollTop = 0;
  }, [activeUid]);

  // Escape key: clear peek -> pop active lane -> nothing
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (peek) {
          setPeek(null);
        } else if (activeIndex > 0) {
          ctxPopTo(activeLaneId, activeIndex - 1);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [peek, activeIndex, activeLaneId, ctxPopTo]);

  // Enter animation: detect new uids appearing
  useEffect(() => {
    const currentUids = new Set(uniqueUids);
    for (const uid of currentUids) {
      if (!prevUidSetRef.current.has(uid)) {
        enteringUidRef.current = uid;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            enteringUidRef.current = null;
            setTick((t) => t + 1);
          });
        });
        break; // animate one at a time
      }
    }
    prevUidSetRef.current = currentUids;
  }, [uniqueUids]);

  // Compute the css class for each uid
  const uidClass = useCallback(
    (uid: string): string => {
      if (enteringUidRef.current === uid) {
        return 'drill-frame drill-frame--entering';
      }
      if (uid === activeUid) {
        return 'drill-frame drill-frame--active';
      }
      // "Behind" = the frame one step deeper in the visual lane
      const behindUid = vLane?.frames[visualIndex + 1]?.uid;
      if (uid === behindUid) {
        return 'drill-frame drill-frame--behind';
      }
      return 'drill-frame drill-frame--hidden';
    },
    [activeUid, vLane, visualIndex],
  );

  // For each uid, derive lane context (isDrilled, drillIndex, laneId)
  // from the visual lane when possible
  const uidContext = useMemo(() => {
    const map = new Map<string, { laneId: string; index: number; isDrilled: boolean }>();
    // First pass: fill from any lane
    for (const lane of lanes) {
      for (let i = 0; i < lane.frames.length; i++) {
        const uid = lane.frames[i].uid;
        if (!map.has(uid)) {
          map.set(uid, { laneId: lane.id, index: i, isDrilled: i > 0 });
        }
      }
    }
    // Second pass: override with visual lane's perspective
    if (vLane) {
      for (let i = 0; i < vLane.frames.length; i++) {
        const uid = vLane.frames[i].uid;
        map.set(uid, { laneId: vLane.id, index: i, isDrilled: i > 0 });
      }
    }
    return map;
  }, [lanes, vLane]);

  // --- Scoped drillIn: extends visual lane at tip, forks at non-tip ---
  const scopedDrillIn = useCallback(
    (frame: DrillFrame) => {
      if (!vLane) return;
      if (visualIndex < vLane.frames.length - 1) {
        forkAndDrill(visualLaneId, visualIndex, frame);
      } else {
        if (visualLaneId !== activeLaneId) switchLane(visualLaneId);
        extendLane(visualLaneId, frame);
      }
      setPeek(null);
    },
    [vLane, visualLaneId, visualIndex, activeLaneId, extendLane, forkAndDrill, switchLane],
  );

  // --- Scoped drillPath: smart prefix matching ---
  const scopedDrillPath = useCallback(
    (frames: DrillFrame[]) => {
      if (frames.length === 0 || !vLane) return;

      // Build the full desired path
      const desiredPath = [...vLane.frames.slice(0, visualIndex + 1), ...frames];

      // 1. Check if any existing lane already contains the desired path
      for (const lane of lanes) {
        const matchLen = prefixMatchLength(lane.frames, desiredPath);
        if (matchLen >= desiredPath.length) {
          // This lane already has our desired path (possibly longer)
          switchLane(lane.id);
          if (lane.frames.length > desiredPath.length) {
            ctxPopTo(lane.id, desiredPath.length - 1);
          }
          setPeek(null);
          return;
        }
      }

      // 2. Find the best lane whose frames are a complete prefix of desiredPath
      let bestLane: Lane | null = null;
      let bestLen = 0;
      for (const lane of lanes) {
        const matchLen = prefixMatchLength(lane.frames, desiredPath);
        if (matchLen === lane.frames.length && matchLen > bestLen) {
          bestLane = lane;
          bestLen = matchLen;
        }
      }

      if (bestLane) {
        // Extend that lane with the remaining frames
        const remaining = desiredPath.slice(bestLen);
        extendPath(bestLane.id, remaining);
      } else {
        // No prefix match — create a new lane with the full desired path
        createLane(desiredPath);
      }

      setPeek(null);
    },
    [vLane, visualLaneId, visualIndex, lanes, activeLaneId, extendPath, createLane, switchLane, ctxPopTo],
  );

  const scopedPopTo = useCallback(
    (laneId: string, index: number) => {
      ctxPopTo(laneId, index);
      setPeek(null);
    },
    [ctxPopTo],
  );

  const override = useMemo(
    () => ({ drillIn: scopedDrillIn, drillPath: scopedDrillPath, popTo: scopedPopTo }),
    [scopedDrillIn, scopedDrillPath, scopedPopTo],
  );

  const handlePeek = useCallback((laneId: string, frameIndex: number) => {
    setPeek({ laneId, frameIndex });
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <DrillBreadcrumb peek={peek} onPeek={handlePeek} schema={schema} />
      <DrillOverrideContext.Provider value={override}>
        <div className="drill-perspective flex-1">
          {uniqueUids.map((uid) => {
            const ctx = uidContext.get(uid)!;
            return (
              <div
                key={uid}
                ref={(el) => {
                  if (el) frameRefs.current.set(uid, el);
                  else frameRefs.current.delete(uid);
                }}
                className={uidClass(uid)}
              >
                <NodeDetailContent
                  uid={uid}
                  schema={schema}
                  viewRegistry={viewRegistry}
                  config={config}
                  onDataChanged={onDataChanged}
                  isDrilled={ctx.isDrilled}
                  drillIndex={ctx.index}
                  laneId={ctx.laneId}
                />
              </div>
            );
          })}
        </div>
      </DrillOverrideContext.Provider>
    </div>
  );
}
