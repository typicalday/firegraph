import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Schema, GraphRecord } from '../types';
import { getTypeBadgeColor } from '../utils';
import { useFocus } from './focus-context';
import { useScope } from './path-context';
import type { DrillFrame } from './drill-context';

interface Props {
  schema: Schema;
}

export default function NearbyPanel({ schema }: Props) {
  const { focused, onPeekNearby, onClearPeek, edgeResults } = useFocus();
  const navigate = useNavigate();

  const rootFrame: DrillFrame = useMemo(
    () => focused
      ? { uid: focused.uid, nodeType: focused.nodeType, edgeType: '', direction: 'out' as const }
      : { uid: '', nodeType: '', edgeType: '', direction: 'out' as const },
    [focused?.uid, focused?.nodeType],
  );

  if (!focused) {
    return (
      <div className="px-3 py-6 text-center">
        <svg className="w-6 h-6 mx-auto mb-2 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <p className="text-[11px] text-slate-500">Navigate to a node to explore nearby relationships</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-auto">
      {/* Current node header — hoverable to peek back to root */}
      <div
        className="px-3 py-2 border-b border-slate-800 shrink-0 cursor-pointer hover:bg-slate-800/50 transition-colors"
        onMouseEnter={() => onPeekNearby(rootFrame)}
      >
        <div className="flex items-center gap-1.5">
          <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono ${getTypeBadgeColor(focused.nodeType)}`}>
            {focused.nodeType}
          </span>
          <span className="text-[11px] font-mono text-slate-300 truncate">{focused.uid}</span>
        </div>
      </div>

      {/* Edge sections — reads from FocusContext (published by PaginatedEdgeSection) */}
      <NearbyEdgeSection
        direction="out"
        results={edgeResults.out}
        schema={schema}
        onPeek={onPeekNearby}
        onClearPeek={onClearPeek}
        navigate={navigate}
      />
      <NearbyEdgeSection
        direction="in"
        results={edgeResults.in}
        schema={schema}
        onPeek={onPeekNearby}
        onClearPeek={onClearPeek}
        navigate={navigate}
      />
    </div>
  );
}

function NearbyEdgeSection({
  direction,
  results,
  schema,
  onPeek,
  onClearPeek,
  navigate,
}: {
  direction: 'out' | 'in';
  results: { edges: GraphRecord[]; hasMore: boolean; loading: boolean };
  schema: Schema;
  onPeek: (frame: DrillFrame) => void;
  onClearPeek: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { edges, hasMore, loading: isLoading } = results;

  // Build inverse label map
  const inverseLabelMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const et of schema.edgeTypes) {
      if (et.inverseLabel) map[et.axbType] = et.inverseLabel;
    }
    return map;
  }, [schema.edgeTypes]);

  // Group edges by axbType
  const groups = useMemo(() => {
    const g: Record<string, GraphRecord[]> = {};
    for (const edge of edges) {
      if (!g[edge.axbType]) g[edge.axbType] = [];
      g[edge.axbType].push(edge);
    }
    return g;
  }, [edges]);

  const groupEntries = Object.entries(groups);

  if (isLoading) {
    return (
      <div className="px-3 py-2">
        <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1">
          {direction === 'out' ? 'Outgoing' : 'Incoming'}
        </h3>
        <div className="flex items-center gap-1.5 py-1">
          <span className="w-2.5 h-2.5 border border-slate-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-[10px] text-slate-600">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-2 py-2">
      <h3 className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-1 px-1">
        {direction === 'out' ? 'Outgoing' : 'Incoming'}
      </h3>
      {groupEntries.length === 0 ? (
        <p className="text-[10px] text-slate-600 px-1">None</p>
      ) : (
        groupEntries.map(([axbType, groupEdges]) => (
          <NearbyGroup
            key={axbType}
            axbType={axbType}
            edges={groupEdges}
            direction={direction}
            inverseLabel={direction === 'in' ? inverseLabelMap[axbType] : undefined}
            onPeek={onPeek}
            onClearPeek={onClearPeek}
            navigate={navigate}
          />
        ))
      )}
      {hasMore && (
        <p className="text-[10px] text-slate-600 px-1 mt-1">and more...</p>
      )}
    </div>
  );
}

function NearbyGroup({
  axbType,
  edges,
  direction,
  inverseLabel,
  onPeek,
  onClearPeek,
  navigate,
}: {
  axbType: string;
  edges: GraphRecord[];
  direction: 'out' | 'in';
  inverseLabel?: string;
  onPeek: (frame: DrillFrame) => void;
  onClearPeek: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1 px-1 py-0.5 rounded text-left hover:bg-slate-800/50 transition-colors group"
      >
        <svg
          className={`w-3 h-3 text-slate-600 transition-transform ${expanded ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        {inverseLabel ? (
          <span className="text-amber-400/80 text-[11px] font-mono cursor-help" title={`Inverse of: ${axbType}`}>
            {inverseLabel}
          </span>
        ) : (
          <span className="text-indigo-400/80 text-[11px] font-mono">{axbType}</span>
        )}
        <span className="text-slate-600 text-[10px]">({edges.length})</span>
      </button>
      {expanded && (
        <div className="ml-3 space-y-px">
          {edges.map((edge) => {
            const targetUid = direction === 'out' ? edge.bUid : edge.aUid;
            const targetType = direction === 'out' ? edge.bType : edge.aType;
            return (
              <NearbyItem
                key={`${edge.aUid}:${edge.axbType}:${edge.bUid}`}
                targetUid={targetUid}
                targetType={targetType}
                edgeType={edge.axbType}
                direction={direction}
                onPeek={onPeek}
                onClearPeek={onClearPeek}
                navigate={navigate}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function NearbyItem({
  targetUid,
  targetType,
  edgeType,
  direction,
  onPeek,
  onClearPeek,
  navigate,
}: {
  targetUid: string;
  targetType: string;
  edgeType: string;
  direction: 'out' | 'in';
  onPeek: (frame: DrillFrame) => void;
  onClearPeek: () => void;
  navigate: ReturnType<typeof useNavigate>;
}) {
  const { scopedPath } = useScope();
  const peekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frame: DrillFrame = useMemo(
    () => ({ uid: targetUid, nodeType: targetType, edgeType, direction }),
    [targetUid, targetType, edgeType, direction],
  );

  const handleMouseEnter = useCallback(() => {
    if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
    peekTimerRef.current = setTimeout(() => {
      peekTimerRef.current = null;
      onPeek(frame);
    }, 150);
  }, [frame, onPeek]);

  const handleMouseLeave = useCallback(() => {
    // Only cancel pending peek timer — don't clear an active peek.
    // The peek persists until the user hovers a different item or navigates away.
    if (peekTimerRef.current) {
      clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
  }, []);

  const handleClick = useCallback(() => {
    if (peekTimerRef.current) {
      clearTimeout(peekTimerRef.current);
      peekTimerRef.current = null;
    }
    onClearPeek();
    navigate(scopedPath(`/node/${encodeURIComponent(targetUid)}`));
  }, [targetUid, onClearPeek, navigate]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (peekTimerRef.current) clearTimeout(peekTimerRef.current);
    };
  }, []);

  return (
    <button
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-left transition-colors text-slate-400 hover:bg-slate-800 hover:text-slate-200"
    >
      <span className={`px-1 py-px rounded text-[9px] font-mono shrink-0 ${getTypeBadgeColor(targetType)}`}>
        {targetType}
      </span>
      <span className="text-[11px] font-mono truncate">{targetUid}</span>
    </button>
  );
}
