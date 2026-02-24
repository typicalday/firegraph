import { createContext, useContext, useState, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { DrillFrame } from './drill-context';

export interface FocusedNode {
  uid: string;
  nodeType: string;
}

export interface FocusContextValue {
  focused: FocusedNode | null;
  setFocused: (node: FocusedNode | null) => void;
  onPeekNearby: (frame: DrillFrame) => void;
  onClearPeek: () => void;
  registerCallbacks: (cbs: {
    peek: (frame: DrillFrame) => void;
    clearPeek: () => void;
  } | null) => void;
}

const FocusContext = createContext<FocusContextValue | null>(null);

export function FocusProvider({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState<FocusedNode | null>(null);
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

  const value = useMemo<FocusContextValue>(
    () => ({ focused, setFocused, onPeekNearby, onClearPeek, registerCallbacks }),
    [focused, setFocused, onPeekNearby, onClearPeek, registerCallbacks],
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
