import { createContext, useContext, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { DrillFrame } from './drill-context';
import type { GraphRecord } from '../types';

export interface FocusedNode {
  uid: string;
  nodeType: string;
}

/** Edge results published by PaginatedEdgeSection for NearbyPanel to consume. */
export interface EdgeResultsState {
  edges: GraphRecord[];
  hasMore: boolean;
  loading: boolean;
}

const EMPTY_EDGE_RESULTS: EdgeResultsState = { edges: [], hasMore: false, loading: false };

export interface FocusContextValue {
  focused: FocusedNode | null;
  setFocused: (node: FocusedNode | null) => void;
  onPeekNearby: (frame: DrillFrame) => void;
  onClearPeek: () => void;
  registerCallbacks: (cbs: {
    peek: (frame: DrillFrame) => void;
    clearPeek: () => void;
  } | null) => void;
  edgeResults: { out: EdgeResultsState; in: EdgeResultsState };
  setEdgeResults: (direction: 'out' | 'in', results: EdgeResultsState) => void;
}

const FocusContext = createContext<FocusContextValue | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState<FocusedNode | null>(null);
  const [edgeResults, setEdgeResultsState] = useState<{ out: EdgeResultsState; in: EdgeResultsState }>({
    out: EMPTY_EDGE_RESULTS,
    in: EMPTY_EDGE_RESULTS,
  });
  const callbacksRef = useRef<{
    peek: (frame: DrillFrame) => void;
    clearPeek: () => void;
  } | null>(null);

  const registerCallbacks = useCallback(
    (cbs: typeof callbacksRef.current) => {
      callbacksRef.current = cbs;
    },
    [],
  );

  const onPeekNearby = useCallback((frame: DrillFrame) => {
    callbacksRef.current?.peek(frame);
  }, []);

  const onClearPeek = useCallback(() => {
    callbacksRef.current?.clearPeek();
  }, []);

  const setEdgeResults = useCallback((direction: 'out' | 'in', results: EdgeResultsState) => {
    setEdgeResultsState((prev) => ({ ...prev, [direction]: results }));
  }, []);

  const value = useMemo<FocusContextValue>(
    () => ({ focused, setFocused, onPeekNearby, onClearPeek, registerCallbacks, edgeResults, setEdgeResults }),
    [focused, setFocused, onPeekNearby, onClearPeek, registerCallbacks, edgeResults, setEdgeResults],
  );

  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext);
  if (!ctx) throw new Error('useFocus must be used within a FocusProvider');
  return ctx;
}

export function useFocusMaybe(): FocusContextValue | null {
  return useContext(FocusContext);
}
