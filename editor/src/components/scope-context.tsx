import { createContext, useContext, useCallback, useMemo, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export interface ScopeSegment {
  parentUid: string;
  subgraphName: string;
}

export interface ScopeContextValue {
  /** Full scope path: "uid1/name1/uid2/name2" or "" for root. Passed to tRPC. */
  scopePath: string;
  /** Parsed segments for breadcrumb display. */
  segments: ScopeSegment[];
  /** True when inside a subgraph. */
  isScoped: boolean;
  /** URL prefix for this scope: "/g/uid1:name1/uid2:name2" or "/g" at root. */
  scopeUrlPrefix: string;
  /** Prepend the scope URL prefix to a page path (must start with /). */
  scopedPath: (path: string) => string;
  /** Enter a subgraph under the given parent node. */
  enterSubgraph: (parentUid: string, subgraphName: string) => void;
  /** Pop scope to a specific depth (0 = root graph at /g). */
  popToDepth: (depth: number) => void;
  /** Return to root graph (/g). */
  exitToRoot: () => void;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

/**
 * A scope segment has the form "nanoidUid:subgraphName" where both sides
 * consist of URL-safe word chars ([A-Za-z0-9_-]+). UIDs are 21-char nanoids;
 * subgraph names must not contain ':' or '/'.
 */
const SCOPE_SEGMENT_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;

/**
 * Parse the splat portion of a /g/* path into scope segments + page route.
 *
 * Scope segments are path parts matching uid:name (both sides [A-Za-z0-9_-]+).
 * The first part not matching that pattern starts the page route.
 * Each part is URI-decoded before processing.
 *
 * Examples:
 *   "" → segments=[], pageRoute="/"
 *   "browse/task" → segments=[], pageRoute="/browse/task"
 *   "uid123:memory" → segments=[{uid123, memory}], pageRoute="/"
 *   "uid123:memory/browse/task" → segments=[{uid123, memory}], pageRoute="/browse/task"
 *   "uid1:name1/uid2:name2/node/abc" → segments=[...2], pageRoute="/node/abc"
 */
export function parseScopeSplat(splat: string): { segments: ScopeSegment[]; pageRoute: string } {
  const parts = splat.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  const segments: ScopeSegment[] = [];
  let i = 0;
  while (i < parts.length && SCOPE_SEGMENT_RE.test(parts[i])) {
    const colonIdx = parts[i].indexOf(':');
    const parentUid = parts[i].slice(0, colonIdx);
    const subgraphName = parts[i].slice(colonIdx + 1);
    // Both sides guaranteed non-empty by the regex, but guard for safety
    if (parentUid && subgraphName) {
      segments.push({ parentUid, subgraphName });
    }
    i++;
  }
  const pageRoute = parts.slice(i).length > 0 ? '/' + parts.slice(i).join('/') : '/';
  return { segments, pageRoute };
}

/**
 * Build the URL prefix for a given set of scope segments.
 * Always starts with /g. Returns "/g" for empty (root).
 */
export function buildScopeUrlPrefix(segments: ScopeSegment[]): string {
  if (segments.length === 0) return '/g';
  return '/g/' + segments.map((s) => `${s.parentUid}:${s.subgraphName}`).join('/');
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();

  // Derive scope from pathname. All graph paths live under /g.
  const segments = useMemo((): ScopeSegment[] => {
    if (!location.pathname.startsWith('/g')) return [];
    // Extract splat: everything after "/g" (skip the leading slash too)
    const splat = location.pathname.slice('/g'.length).replace(/^\//, '');
    return parseScopeSplat(splat).segments;
  }, [location.pathname]);

  const scopePath = useMemo(
    () => segments.map((s) => `${s.parentUid}/${s.subgraphName}`).join('/'),
    [segments],
  );

  const scopeUrlPrefix = useMemo(() => buildScopeUrlPrefix(segments), [segments]);

  const scopedPath = useCallback(
    (path: string) => scopeUrlPrefix + path,
    [scopeUrlPrefix],
  );

  const enterSubgraph = useCallback(
    (parentUid: string, subgraphName: string) => {
      navigate(`${scopeUrlPrefix}/${parentUid}:${subgraphName}`);
    },
    [navigate, scopeUrlPrefix],
  );

  const popToDepth = useCallback(
    (depth: number) => {
      navigate(buildScopeUrlPrefix(segments.slice(0, depth)));
    },
    [navigate, segments],
  );

  const exitToRoot = useCallback(() => {
    navigate('/g');
  }, [navigate]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      scopePath,
      segments,
      isScoped: segments.length > 0,
      scopeUrlPrefix,
      scopedPath,
      enterSubgraph,
      popToDepth,
      exitToRoot,
    }),
    [scopePath, segments, scopeUrlPrefix, scopedPath, enterSubgraph, popToDepth, exitToRoot],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) throw new Error('useScope must be used within a ScopeProvider');
  return ctx;
}
