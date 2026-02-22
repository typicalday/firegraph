import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Schema, ViewRegistryData, AppConfig } from '../types';
import { useDrill, DrillOverrideContext } from './drill-context';
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
 * Perspective container that renders one NodeDetailContent per drill frame
 * across all lanes. Only the visually active frame is shown; all others
 * stay mounted but hidden for instant switching.
 *
 * Provides a DrillOverrideContext so EdgeRow's drillIn is peek-aware:
 * diving from a non-tip peeked frame forks a new lane.
 */
export default function DrillStack({ schema, viewRegistry, config, onDataChanged }: Props) {
  const {
    lanes, activeLaneId, activeLane, activeIndex,
    extendLane, forkAndDrill, switchLane, popTo: ctxPopTo, closeLane,
  } = useDrill();

  const [peek, setPeek] = useState<PeekPosition | null>(null);
  const enteringKeyRef = useRef<string | null>(null);
  const prevFrameCountRef = useRef(totalFrameCount(lanes));
  const [, setTick] = useState(0);
  const frameRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Clear peek when active lane changes (user clicked breadcrumb or new drill committed)
  useEffect(() => {
    setPeek(null);
  }, [activeLaneId, activeIndex]);

  // Visual position: peek overrides active
  const visualLaneId = peek?.laneId ?? activeLaneId;
  const visualIndex = peek?.frameIndex ?? activeIndex;

  // Scroll the newly visible frame to top
  useEffect(() => {
    const key = frameKey(visualLaneId, visualIndex);
    const el = frameRefs.current.get(key);
    if (el) el.scrollTop = 0;
  }, [visualLaneId, visualIndex]);

  // Escape key: clear peek → pop active lane → nothing
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

  // Enter animation: detect new frames across all lanes
  useEffect(() => {
    const count = totalFrameCount(lanes);
    if (count > prevFrameCountRef.current) {
      // Find the newly added frame (last frame of the active lane)
      const aLane = lanes.find((l) => l.id === activeLaneId);
      if (aLane) {
        enteringKeyRef.current = frameKey(activeLaneId, aLane.frames.length - 1);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            enteringKeyRef.current = null;
            setTick((t) => t + 1);
          });
        });
      }
    }
    prevFrameCountRef.current = count;
  }, [lanes, activeLaneId]);

  const frameClass = useCallback(
    (laneId: string, index: number): string => {
      const key = frameKey(laneId, index);
      if (enteringKeyRef.current === key) {
        return 'drill-frame drill-frame--entering';
      }
      if (laneId === visualLaneId && index === visualIndex) {
        return 'drill-frame drill-frame--active';
      }
      if (laneId === visualLaneId && index === visualIndex + 1) {
        return 'drill-frame drill-frame--behind';
      }
      return 'drill-frame drill-frame--hidden';
    },
    [visualLaneId, visualIndex],
  );

  // Scoped drillIn: extends visual lane at tip, forks at non-tip
  const scopedDrillIn = useCallback(
    (frame: import('./drill-context').DrillFrame) => {
      const vLane = lanes.find((l) => l.id === visualLaneId);
      if (!vLane) return;

      if (visualIndex < vLane.frames.length - 1) {
        // Peeking at a non-tip frame: fork
        forkAndDrill(visualLaneId, visualIndex, frame);
      } else {
        // At the tip: extend this lane
        if (visualLaneId !== activeLaneId) switchLane(visualLaneId);
        extendLane(visualLaneId, frame);
      }
      setPeek(null);
    },
    [lanes, visualLaneId, visualIndex, activeLaneId, extendLane, forkAndDrill, switchLane],
  );

  // Scoped popTo: delegates to context with laneId
  const scopedPopTo = useCallback(
    (laneId: string, index: number) => {
      ctxPopTo(laneId, index);
      setPeek(null);
    },
    [ctxPopTo],
  );

  const override = useMemo(
    () => ({ drillIn: scopedDrillIn, popTo: scopedPopTo }),
    [scopedDrillIn, scopedPopTo],
  );

  const handlePeek = useCallback((laneId: string, frameIndex: number) => {
    setPeek({ laneId, frameIndex });
  }, []);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <DrillBreadcrumb peek={peek} onPeek={handlePeek} />
      <DrillOverrideContext.Provider value={override}>
        <div className="drill-perspective flex-1">
          {lanes.flatMap((lane) =>
            lane.frames.map((frame, i) => (
              <div
                key={frameKey(lane.id, i)}
                ref={(el) => {
                  const k = frameKey(lane.id, i);
                  if (el) frameRefs.current.set(k, el);
                  else frameRefs.current.delete(k);
                }}
                className={frameClass(lane.id, i)}
              >
                <NodeDetailContent
                  uid={frame.uid}
                  schema={schema}
                  viewRegistry={viewRegistry}
                  config={config}
                  onDataChanged={onDataChanged}
                  isDrilled={i > 0}
                  drillIndex={i}
                  laneId={lane.id}
                />
              </div>
            )),
          )}
        </div>
      </DrillOverrideContext.Provider>
    </div>
  );
}

function frameKey(laneId: string, index: number): string {
  return `${laneId}-${index}`;
}

function totalFrameCount(lanes: { frames: unknown[] }[]): number {
  let n = 0;
  for (const l of lanes) n += l.frames.length;
  return n;
}
