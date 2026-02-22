import { createContext, useContext, useReducer, useEffect, useCallback, useMemo, type ReactNode } from 'react';

export interface DrillFrame {
  uid: string;
  nodeType: string;
  edgeType: string;
  direction: 'out' | 'in';
}

export interface Lane {
  id: string;
  frames: DrillFrame[];
}

export interface DrillContextValue {
  lanes: Lane[];
  activeLaneId: string;
  activeLane: Lane;
  activeIndex: number;
  drillIn: (frame: DrillFrame) => void;
  drillPath: (frames: DrillFrame[]) => void;
  extendLane: (laneId: string, frame: DrillFrame) => void;
  extendPath: (laneId: string, frames: DrillFrame[]) => void;
  forkAndDrill: (fromLaneId: string, fromIndex: number, frame: DrillFrame) => void;
  forkAndDrillPath: (fromLaneId: string, fromIndex: number, frames: DrillFrame[]) => void;
  createLane: (frames: DrillFrame[]) => void;
  popTo: (laneId: string, index: number) => void;
  closeLane: (laneId: string) => void;
  switchLane: (laneId: string) => void;
  setRootType: (nodeType: string) => void;
}

// --- Reducer ---

interface DrillState {
  lanes: Lane[];
  activeLaneId: string;
}

type DrillAction =
  | { type: 'RESET'; rootUid: string }
  | { type: 'EXTEND_LANE'; laneId: string; frame: DrillFrame }
  | { type: 'EXTEND_PATH'; laneId: string; frames: DrillFrame[] }
  | { type: 'FORK_AND_DRILL'; fromLaneId: string; fromIndex: number; frame: DrillFrame; newLaneId: string }
  | { type: 'FORK_AND_DRILL_PATH'; fromLaneId: string; fromIndex: number; frames: DrillFrame[]; newLaneId: string }
  | { type: 'CREATE_LANE'; newLaneId: string; frames: DrillFrame[] }
  | { type: 'POP_TO'; laneId: string; index: number }
  | { type: 'CLOSE_LANE'; laneId: string; rootUid: string }
  | { type: 'SWITCH_LANE'; laneId: string }
  | { type: 'SET_ROOT_TYPE'; nodeType: string };

let laneCounter = 0;
function nextLaneId(): string {
  return `lane-${++laneCounter}`;
}

function makeRootFrame(uid: string): DrillFrame {
  return { uid, nodeType: '', edgeType: '', direction: 'out' };
}

function drillReducer(state: DrillState, action: DrillAction): DrillState {
  switch (action.type) {
    case 'RESET': {
      laneCounter = 0;
      const id = nextLaneId();
      return {
        lanes: [{ id, frames: [makeRootFrame(action.rootUid)] }],
        activeLaneId: id,
      };
    }
    case 'EXTEND_LANE': {
      return {
        lanes: state.lanes.map((l) =>
          l.id === action.laneId ? { ...l, frames: [...l.frames, action.frame] } : l,
        ),
        activeLaneId: action.laneId,
      };
    }
    case 'EXTEND_PATH': {
      return {
        lanes: state.lanes.map((l) =>
          l.id === action.laneId ? { ...l, frames: [...l.frames, ...action.frames] } : l,
        ),
        activeLaneId: action.laneId,
      };
    }
    case 'FORK_AND_DRILL': {
      const source = state.lanes.find((l) => l.id === action.fromLaneId);
      if (!source) return state;
      const newLane: Lane = {
        id: action.newLaneId,
        frames: [...source.frames.slice(0, action.fromIndex + 1), action.frame],
      };
      return {
        lanes: [...state.lanes, newLane],
        activeLaneId: action.newLaneId,
      };
    }
    case 'FORK_AND_DRILL_PATH': {
      const source = state.lanes.find((l) => l.id === action.fromLaneId);
      if (!source) return state;
      const newLane: Lane = {
        id: action.newLaneId,
        frames: [...source.frames.slice(0, action.fromIndex + 1), ...action.frames],
      };
      return {
        lanes: [...state.lanes, newLane],
        activeLaneId: action.newLaneId,
      };
    }
    case 'CREATE_LANE': {
      return {
        lanes: [...state.lanes, { id: action.newLaneId, frames: action.frames }],
        activeLaneId: action.newLaneId,
      };
    }
    case 'POP_TO': {
      return {
        lanes: state.lanes.map((l) =>
          l.id === action.laneId ? { ...l, frames: l.frames.slice(0, action.index + 1) } : l,
        ),
        activeLaneId: action.laneId,
      };
    }
    case 'CLOSE_LANE': {
      const remaining = state.lanes.filter((l) => l.id !== action.laneId);
      if (remaining.length === 0) {
        const id = nextLaneId();
        return {
          lanes: [{ id, frames: [makeRootFrame(action.rootUid)] }],
          activeLaneId: id,
        };
      }
      return {
        lanes: remaining,
        activeLaneId:
          state.activeLaneId === action.laneId ? remaining[0].id : state.activeLaneId,
      };
    }
    case 'SWITCH_LANE': {
      return { ...state, activeLaneId: action.laneId };
    }
    case 'SET_ROOT_TYPE': {
      return {
        ...state,
        lanes: state.lanes.map((l) => {
          if (l.frames[0]?.nodeType === action.nodeType) return l;
          const frames = [...l.frames];
          frames[0] = { ...frames[0], nodeType: action.nodeType };
          return { ...l, frames };
        }),
      };
    }
    default:
      return state;
  }
}

// --- Contexts ---

const DrillContext = createContext<DrillContextValue | null>(null);
export const DrillOverrideContext = createContext<Partial<DrillContextValue> | null>(null);

// --- Provider ---

export function DrillProvider({ rootUid, children }: { rootUid: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(drillReducer, rootUid, (uid) => {
    laneCounter = 0;
    const id = nextLaneId();
    return { lanes: [{ id, frames: [makeRootFrame(uid)] }], activeLaneId: id };
  });

  useEffect(() => {
    dispatch({ type: 'RESET', rootUid });
  }, [rootUid]);

  const activeLane = useMemo(
    () => state.lanes.find((l) => l.id === state.activeLaneId) ?? state.lanes[0],
    [state.lanes, state.activeLaneId],
  );

  const drillIn = useCallback(
    (frame: DrillFrame) => {
      dispatch({ type: 'EXTEND_LANE', laneId: state.activeLaneId, frame });
    },
    [state.activeLaneId],
  );

  const drillPath = useCallback(
    (frames: DrillFrame[]) => {
      if (frames.length === 0) return;
      dispatch({ type: 'EXTEND_PATH', laneId: state.activeLaneId, frames });
    },
    [state.activeLaneId],
  );

  const extendLane = useCallback((laneId: string, frame: DrillFrame) => {
    dispatch({ type: 'EXTEND_LANE', laneId, frame });
  }, []);

  const extendPath = useCallback((laneId: string, frames: DrillFrame[]) => {
    if (frames.length === 0) return;
    dispatch({ type: 'EXTEND_PATH', laneId, frames });
  }, []);

  const forkAndDrill = useCallback(
    (fromLaneId: string, fromIndex: number, frame: DrillFrame) => {
      const newLaneId = nextLaneId();
      dispatch({ type: 'FORK_AND_DRILL', fromLaneId, fromIndex, frame, newLaneId });
    },
    [],
  );

  const forkAndDrillPath = useCallback(
    (fromLaneId: string, fromIndex: number, frames: DrillFrame[]) => {
      if (frames.length === 0) return;
      const newLaneId = nextLaneId();
      dispatch({ type: 'FORK_AND_DRILL_PATH', fromLaneId, fromIndex, frames, newLaneId });
    },
    [],
  );

  const createLane = useCallback((frames: DrillFrame[]) => {
    if (frames.length === 0) return;
    const newLaneId = nextLaneId();
    dispatch({ type: 'CREATE_LANE', newLaneId, frames });
  }, []);

  const popTo = useCallback((laneId: string, index: number) => {
    dispatch({ type: 'POP_TO', laneId, index });
  }, []);

  const closeLane = useCallback(
    (laneId: string) => {
      dispatch({ type: 'CLOSE_LANE', laneId, rootUid });
    },
    [rootUid],
  );

  const switchLane = useCallback((laneId: string) => {
    dispatch({ type: 'SWITCH_LANE', laneId });
  }, []);

  const setRootType = useCallback((nodeType: string) => {
    dispatch({ type: 'SET_ROOT_TYPE', nodeType });
  }, []);

  const value = useMemo<DrillContextValue>(
    () => ({
      lanes: state.lanes,
      activeLaneId: state.activeLaneId,
      activeLane,
      activeIndex: activeLane.frames.length - 1,
      drillIn,
      drillPath,
      extendLane,
      extendPath,
      forkAndDrill,
      forkAndDrillPath,
      createLane,
      popTo,
      closeLane,
      switchLane,
      setRootType,
    }),
    [state.lanes, state.activeLaneId, activeLane, drillIn, drillPath, extendLane, extendPath, forkAndDrill, forkAndDrillPath, createLane, popTo, closeLane, switchLane, setRootType],
  );

  return (
    <DrillContext.Provider value={value}>
      {children}
    </DrillContext.Provider>
  );
}

// --- Hook ---

export function useDrill(): DrillContextValue {
  const ctx = useContext(DrillContext);
  if (!ctx) throw new Error('useDrill must be used within a DrillProvider');
  const override = useContext(DrillOverrideContext);
  return override ? { ...ctx, ...override } : ctx;
}

/** Safe version — returns null when outside a DrillProvider */
export function useDrillMaybe(): DrillContextValue | null {
  const ctx = useContext(DrillContext);
  const override = useContext(DrillOverrideContext);
  if (!ctx) return null;
  return override ? { ...ctx, ...override } : ctx;
}
