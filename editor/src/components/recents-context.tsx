import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';

export type RecentType = 'node' | 'collection-doc' | 'collection';

export interface RecentEntry {
  type: RecentType;
  /** Primary display label (UID, doc ID, or collection name). */
  label: string;
  /** Secondary label (node type, collection name, resolved path). */
  sublabel?: string;
  /** Full pathname to navigate to. */
  url: string;
  timestamp: number;
}

const STORAGE_KEY = 'firegraph:recents';
const MAX_ENTRIES = 20;
const DISPLAY_COUNT = 8;

function load(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as RecentEntry[]) : [];
  } catch {
    return [];
  }
}

function save(entries: RecentEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage full or unavailable — ignore
  }
}

interface RecentsContextValue {
  recents: RecentEntry[];
  displayRecents: RecentEntry[];
  addRecent: (entry: Omit<RecentEntry, 'timestamp'>) => void;
  clearRecents: () => void;
}

const RecentsContext = createContext<RecentsContextValue | null>(null);

export function RecentsProvider({ children }: { children: ReactNode }) {
  const [recents, setRecents] = useState<RecentEntry[]>(load);

  const addRecent = useCallback((entry: Omit<RecentEntry, 'timestamp'>) => {
    setRecents((prev) => {
      const next = [
        { ...entry, timestamp: Date.now() },
        ...prev.filter((r) => r.url !== entry.url),
      ].slice(0, MAX_ENTRIES);
      save(next);
      return next;
    });
  }, []);

  const clearRecents = useCallback(() => {
    setRecents([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  }, []);

  const displayRecents = useMemo(() => recents.slice(0, DISPLAY_COUNT), [recents]);

  const value = useMemo<RecentsContextValue>(
    () => ({ recents, displayRecents, addRecent, clearRecents }),
    [recents, displayRecents, addRecent, clearRecents],
  );

  return <RecentsContext.Provider value={value}>{children}</RecentsContext.Provider>;
}

export function useRecents(): RecentsContextValue {
  const ctx = useContext(RecentsContext);
  if (!ctx) throw new Error('useRecents must be used within a RecentsProvider');
  return ctx;
}
