import { useState, useEffect, useCallback, useRef } from 'react';
import { useDrill } from './drill-context';
import { getTypeBadgeColor } from '../utils';
import type { PeekPosition } from './DrillStack';

interface Props {
  peek: PeekPosition | null;
  onPeek: (laneId: string, frameIndex: number) => void;
}

/** Accumulated deltaY threshold before stepping one lane. */
const WHEEL_THRESHOLD = 80;
/** Cooldown (ms) after a step before the next step can fire. */
const WHEEL_COOLDOWN = 300;

/**
 * Multi-row breadcrumb showing one row per lane.
 *
 * Only one lane is "focused" (interactive) at a time — its items respond to
 * hover and click. Other lanes are visible but dimmed and inert.
 * Mouse wheel over the breadcrumb area scrolls which lane is focused.
 * Clicking a lane's dot also focuses it.
 */
export default function DrillBreadcrumb({ peek, onPeek }: Props) {
  const { lanes, activeLaneId, activeIndex, popTo, closeLane } = useDrill();

  const showBreadcrumbs =
    lanes.length > 1 || (lanes.length === 1 && lanes[0].frames.length > 1);

  // Focused lane index — the only interactive row
  const [focusedIdx, setFocusedIdx] = useState(0);

  // Accumulated wheel delta for debounced stepping
  const wheelAccum = useRef(0);
  const wheelCooldownUntil = useRef(0);

  // Snap focus to active lane when lanes change (fork, close, drill)
  useEffect(() => {
    const idx = lanes.findIndex((l) => l.id === activeLaneId);
    if (idx >= 0) setFocusedIdx(idx);
    wheelAccum.current = 0;
  }, [lanes.length, activeLaneId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clamp if lanes shrink
  useEffect(() => {
    setFocusedIdx((prev) => Math.min(prev, lanes.length - 1));
  }, [lanes.length]);

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (lanes.length <= 1) return;
      e.preventDefault();

      const now = Date.now();
      if (now < wheelCooldownUntil.current) {
        // In cooldown — swallow momentum events
        wheelAccum.current = 0;
        return;
      }

      wheelAccum.current += e.deltaY;

      if (wheelAccum.current >= WHEEL_THRESHOLD) {
        wheelAccum.current = 0;
        wheelCooldownUntil.current = now + WHEEL_COOLDOWN;
        setFocusedIdx((prev) => Math.min(prev + 1, lanes.length - 1));
      } else if (wheelAccum.current <= -WHEEL_THRESHOLD) {
        wheelAccum.current = 0;
        wheelCooldownUntil.current = now + WHEEL_COOLDOWN;
        setFocusedIdx((prev) => Math.max(prev - 1, 0));
      }
    },
    [lanes.length],
  );

  if (!showBreadcrumbs) return null;

  const multiLane = lanes.length > 1;
  const focusedLaneId = lanes[focusedIdx]?.id;

  // Visual highlight: peek position, or active lane tip for the focused lane
  const visualLaneId = peek?.laneId ?? activeLaneId;
  const visualIndex = peek?.frameIndex ?? activeIndex;

  return (
    <nav
      className="flex flex-col gap-0.5 px-4 py-2 bg-slate-900/80 border-b border-slate-800 overflow-y-auto max-h-32 text-xs"
      onWheel={handleWheel}
    >
      {lanes.map((lane) => {
        const isFocused = lane.id === focusedLaneId;

        return (
          <div
            key={lane.id}
            className={`flex items-center gap-1 shrink-0 transition-opacity ${
              !isFocused && multiLane ? 'opacity-40' : ''
            }`}
          >
            {/* Lane indicator dot — clickable to focus, padded hit area */}
            {multiLane && (
              <button
                onClick={() => setFocusedIdx(lanes.indexOf(lane))}
                className="shrink-0 p-1.5 -m-1 flex items-center justify-center"
                title={isFocused ? 'Active lane' : 'Focus this lane'}
              >
                <span
                  className={`block w-2 h-2 rounded-full transition-colors ${
                    isFocused ? 'bg-indigo-500' : 'bg-slate-600 hover:bg-slate-500'
                  }`}
                />
              </button>
            )}

            {/* Frames — only interactive on focused lane */}
            {lane.frames.map((frame, i) => (
              <span key={i} className="flex items-center gap-1 shrink-0">
                {i > 0 && (
                  <span className="text-slate-600 font-mono mx-0.5">
                    {frame.direction === 'out' ? (
                      <>
                        <span className="text-indigo-500/60">{frame.edgeType}</span>
                        <span className="ml-0.5">&rarr;</span>
                      </>
                    ) : (
                      <>
                        <span className="mr-0.5">&larr;</span>
                        <span className="text-indigo-500/60">{frame.edgeType}</span>
                      </>
                    )}
                  </span>
                )}
                {isFocused ? (
                  <button
                    onClick={() => popTo(lane.id, i)}
                    onMouseEnter={() => onPeek(lane.id, i)}
                    className={`flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors ${
                      lane.id === visualLaneId && i === visualIndex
                        ? 'bg-slate-800 text-slate-200'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                    }`}
                  >
                    {frame.nodeType && (
                      <span
                        className={`px-1 py-px rounded text-[9px] font-mono ${getTypeBadgeColor(frame.nodeType)}`}
                      >
                        {frame.nodeType}
                      </span>
                    )}
                    <span className="font-mono truncate max-w-[120px]">{frame.uid}</span>
                  </button>
                ) : (
                  <span className="flex items-center gap-1 px-1.5 py-0.5 text-slate-500">
                    {frame.nodeType && (
                      <span
                        className={`px-1 py-px rounded text-[9px] font-mono opacity-60 ${getTypeBadgeColor(frame.nodeType)}`}
                      >
                        {frame.nodeType}
                      </span>
                    )}
                    <span className="font-mono truncate max-w-[120px]">{frame.uid}</span>
                  </span>
                )}
              </span>
            ))}

            {/* Close button — always interactive */}
            {multiLane && (
              <button
                onClick={() => closeLane(lane.id)}
                className="ml-1 text-slate-600 hover:text-slate-400 transition-colors shrink-0 text-sm leading-none"
                title="Close this lane"
              >
                &times;
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
