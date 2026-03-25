import { createContext, useContext, useCallback, useMemo, type ReactNode } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { CollectionDef } from '../types';
import {
  decodeFsPath,
  encodeFsPath,
  isGraphPath,
  extractGraphScope,
  scopeToNamesPath,
  parseScopeSegments,
  matchCollectionTemplate,
} from '../utils';

export interface ScopeSegment {
  parentUid: string;
  subgraphName: string;
}

export interface CollectionMatch {
  collection: CollectionDef;
  params: Record<string, string>;
}

export type PathType = 'graph' | 'collection' | 'unknown';

export interface PathContextValue {
  /** Decoded Firestore path: "ive", "ive/abc123/memory", "installations" */
  firestorePath: string;
  /** Encoded path for URL: "ive", "ive~2Fabc123~2Fmemory" */
  encodedPath: string;
  /** What type of thing is at this path */
  pathType: PathType;
  /** For graph paths: scope string passed to tRPC (e.g., "abc123/memory" or "") */
  graphScope: string;
  /** For graph paths: names-only scope for allowedIn matching */
  scopeNamesPath: string;
  /** For graph paths: parsed scope segments for breadcrumbs */
  scopeSegments: ScopeSegment[];
  /** For collection paths: matched collection def + extracted params */
  collectionMatch: CollectionMatch | null;
  /** Build a URL for a page within the current Firestore path */
  pathUrl: (pageAction?: string) => string;
  /** Navigate into a subgraph (graph context only) */
  enterSubgraph: (parentUid: string, subgraphName: string) => void;
  /** Navigate to parent path (one subgraph level up, or to root) */
  navigateUp: () => void;
  /** Navigate to the application root page */
  navigateToRoot: () => void;

  // --- Backward compatibility shims (match old useScope interface) ---
  /** Alias for graphScope */
  scopePath: string;
  /** True when inside a subgraph */
  isScoped: boolean;
  /** Alias for pathUrl */
  scopedPath: (pageAction: string) => string;
  /** URL prefix for the current path: /{encodedPath} */
  scopeUrlPrefix: string;
  /** Alias for navigateToRoot */
  exitToRoot: () => void;
  /** Pop scope to a specific depth (0 = graph root) */
  popToDepth: (depth: number) => void;
}

const PathContext = createContext<PathContextValue | null>(null);

interface PathProviderProps {
  children: ReactNode;
  graphCollection?: string;
  collections?: CollectionDef[];
}

export function PathProvider({ children, graphCollection, collections }: PathProviderProps) {
  const { encodedPath: rawEncodedPath } = useParams<{ encodedPath: string }>();
  const navigate = useNavigate();

  const encodedPath = rawEncodedPath ?? '';
  const firestorePath = useMemo(() => decodeFsPath(encodedPath), [encodedPath]);

  const pathType = useMemo<PathType>(() => {
    // Check collection templates first — they're more specific than the graph
    // catch-all prefix. e.g. "ive/operator/inbox" matches collection template
    // "ive/{operatorId}/inbox" and should NOT be treated as graph scope "operator/inbox".
    if (collections) {
      for (const col of collections) {
        if (matchCollectionTemplate(firestorePath, col.path)) return 'collection';
      }
    }
    if (isGraphPath(firestorePath, graphCollection)) return 'graph';
    return 'unknown';
  }, [firestorePath, graphCollection, collections]);

  const graphScope = useMemo(
    () => (pathType === 'graph' && graphCollection ? extractGraphScope(firestorePath, graphCollection) : ''),
    [pathType, firestorePath, graphCollection],
  );

  const scopeNamesPath = useMemo(() => scopeToNamesPath(graphScope), [graphScope]);

  const scopeSegments = useMemo(() => parseScopeSegments(graphScope), [graphScope]);

  const collectionMatch = useMemo<CollectionMatch | null>(() => {
    if (pathType !== 'collection' || !collections) return null;
    for (const col of collections) {
      const params = matchCollectionTemplate(firestorePath, col.path);
      if (params) return { collection: col, params };
    }
    return null;
  }, [pathType, firestorePath, collections]);

  const scopeUrlPrefix = useMemo(() => `/${encodedPath}`, [encodedPath]);

  const pathUrl = useCallback(
    (pageAction?: string) => {
      if (!pageAction) return scopeUrlPrefix;
      // Ensure pageAction starts with /
      const action = pageAction.startsWith('/') ? pageAction.slice(1) : pageAction;
      return `${scopeUrlPrefix}/${action}`;
    },
    [scopeUrlPrefix],
  );

  const enterSubgraph = useCallback(
    (parentUid: string, subgraphName: string) => {
      const newPath = firestorePath + '/' + parentUid + '/' + subgraphName;
      navigate(`/${encodeFsPath(newPath)}`);
    },
    [navigate, firestorePath],
  );

  const navigateUp = useCallback(() => {
    const segments = firestorePath.split('/');
    if (segments.length <= 1) {
      navigate('/');
      return;
    }
    // For graph subgraphs, go up two segments (uid + subgraphName)
    if (pathType === 'graph' && segments.length >= 3) {
      const parentPath = segments.slice(0, -2).join('/');
      navigate(`/${encodeFsPath(parentPath)}`);
    } else {
      navigate('/');
    }
  }, [navigate, firestorePath, pathType]);

  const navigateToRoot = useCallback(() => {
    if (graphCollection) {
      navigate(`/${encodeFsPath(graphCollection)}`);
    } else {
      navigate('/');
    }
  }, [navigate, graphCollection]);

  const exitToRoot = navigateToRoot;

  const popToDepth = useCallback(
    (depth: number) => {
      if (!graphCollection) {
        navigate('/');
        return;
      }
      if (depth === 0) {
        navigate(`/${encodeFsPath(graphCollection)}`);
        return;
      }
      const segs = parseScopeSegments(graphScope);
      const kept = segs.slice(0, depth);
      const scopeParts = kept.map((s) => `${s.parentUid}/${s.subgraphName}`).join('/');
      const newFsPath = scopeParts ? `${graphCollection}/${scopeParts}` : graphCollection;
      navigate(`/${encodeFsPath(newFsPath)}`);
    },
    [navigate, graphCollection, graphScope],
  );

  const value = useMemo<PathContextValue>(
    () => ({
      firestorePath,
      encodedPath,
      pathType,
      graphScope,
      scopeNamesPath,
      scopeSegments,
      collectionMatch,
      pathUrl,
      enterSubgraph,
      navigateUp,
      navigateToRoot,
      // Backward compat
      scopePath: graphScope,
      isScoped: graphScope !== '',
      scopedPath: pathUrl,
      scopeUrlPrefix,
      exitToRoot,
      popToDepth,
    }),
    [
      firestorePath, encodedPath, pathType, graphScope, scopeNamesPath,
      scopeSegments, collectionMatch, pathUrl, enterSubgraph,
      navigateUp, navigateToRoot, scopeUrlPrefix, exitToRoot, popToDepth,
    ],
  );

  return <PathContext.Provider value={value}>{children}</PathContext.Provider>;
}

export function usePath(): PathContextValue {
  const ctx = useContext(PathContext);
  if (!ctx) throw new Error('usePath must be used within a PathProvider');
  return ctx;
}

/** Returns PathContextValue or null when outside a PathProvider. */
export function usePathMaybe(): PathContextValue | null {
  return useContext(PathContext);
}

/** Alias for backward compatibility — components importing useScope can switch to this. */
export const useScope = usePath;
