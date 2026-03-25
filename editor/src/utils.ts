const TYPE_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-cyan-500',
  'bg-pink-500',
  'bg-lime-500',
  'bg-teal-500',
  'bg-orange-500',
];

const TYPE_TEXT_COLORS = [
  'text-blue-400',
  'text-emerald-400',
  'text-amber-400',
  'text-rose-400',
  'text-violet-400',
  'text-cyan-400',
  'text-pink-400',
  'text-lime-400',
  'text-teal-400',
  'text-orange-400',
];

const TYPE_BG_LIGHT_COLORS = [
  'bg-blue-500/15 text-blue-400',
  'bg-emerald-500/15 text-emerald-400',
  'bg-amber-500/15 text-amber-400',
  'bg-rose-500/15 text-rose-400',
  'bg-violet-500/15 text-violet-400',
  'bg-cyan-500/15 text-cyan-400',
  'bg-pink-500/15 text-pink-400',
  'bg-lime-500/15 text-lime-400',
  'bg-teal-500/15 text-teal-400',
  'bg-orange-500/15 text-orange-400',
];

const TYPE_HEX_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#f43f5e', // rose-500
  '#8b5cf6', // violet-500
  '#06b6d4', // cyan-500
  '#ec4899', // pink-500
  '#84cc16', // lime-500
  '#14b8a6', // teal-500
  '#f97316', // orange-500
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getTypeColor(type: string): string {
  return TYPE_COLORS[hashString(type) % TYPE_COLORS.length];
}

export function getTypeTextColor(type: string): string {
  return TYPE_TEXT_COLORS[hashString(type) % TYPE_TEXT_COLORS.length];
}

export function getTypeBadgeColor(type: string): string {
  return TYPE_BG_LIGHT_COLORS[hashString(type) % TYPE_BG_LIGHT_COLORS.length];
}

export function getTypeHexColor(type: string): string {
  return TYPE_HEX_COLORS[hashString(type) % TYPE_HEX_COLORS.length];
}

export function formatTimestamp(ts: string | null | undefined): string {
  if (!ts) return '--';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function truncateData(data: Record<string, unknown>, maxLength = 80): string {
  const str = JSON.stringify(data);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + '...';
}

/**
 * Resolve the best view name for an entity given its config and display context.
 * Mirrors `resolveView` from `src/config.ts` — duplicated to avoid cross-build imports.
 *
 * Priority: context-specific default > global default > 'json'.
 */
/**
 * Build the `scope` input field for tRPC calls.
 * Returns `{ scope }` when scoped, or `{}` for root so the param is omitted.
 */
export function scopeInput(scopePath: string): { scope?: string } {
  return scopePath ? { scope: scopePath } : {};
}

/**
 * Build a URL for browsing a registered plain Firestore collection.
 * Parameterized collections include param values as additional path segments.
 * Pass `pathParams` (from collectionDef.pathParams) to guarantee correct ordering.
 * e.g. collectionBrowseUrl('taskLogs', { nodeUid: 'abc123' }, ['nodeUid']) → '/f/col/taskLogs/abc123'
 */
export function collectionBrowseUrl(name: string, params?: Record<string, string>, pathParams?: string[]): string {
  const base = `/f/col/${encodeURIComponent(name)}`;
  if (!params || Object.keys(params).length === 0) return base;
  const orderedKeys = pathParams?.length ? pathParams : Object.keys(params);
  const paramPath = orderedKeys
    .filter((k) => params[k] !== undefined)
    .map((k) => encodeURIComponent(params[k]))
    .join('/');
  return paramPath ? `${base}/${paramPath}` : base;
}

/**
 * Build a URL for a single document in a registered plain Firestore collection.
 * Pass `pathParams` (from collectionDef.pathParams) to guarantee correct ordering.
 */
export function collectionDocUrl(name: string, docId: string, params?: Record<string, string>, pathParams?: string[]): string {
  return `${collectionBrowseUrl(name, params, pathParams)}/doc/${encodeURIComponent(docId)}`;
}

// --- Scope matching ---
// Mirrors `matchScope`/`matchScopeAny` from `src/scope.ts` to avoid cross-build imports.

function matchSegments(path: string[], pi: number, pattern: string[], qi: number): boolean {
  if (pi === path.length && qi === pattern.length) return true;
  if (qi === pattern.length) return false;
  const seg = pattern[qi];
  if (seg === '**') {
    if (qi === pattern.length - 1) return true;
    for (let skip = 0; skip <= path.length - pi; skip++) {
      if (matchSegments(path, pi + skip, pattern, qi + 1)) return true;
    }
    return false;
  }
  if (pi === path.length) return false;
  if (seg === '*') return matchSegments(path, pi + 1, pattern, qi + 1);
  if (path[pi] === seg) return matchSegments(path, pi + 1, pattern, qi + 1);
  return false;
}

export function matchScope(scopePath: string, pattern: string): boolean {
  if (pattern === 'root') return scopePath === '';
  if (pattern === '**') return true;
  const pathSegments = scopePath === '' ? [] : scopePath.split('/');
  const patternSegments = pattern.split('/');
  return matchSegments(pathSegments, 0, patternSegments, 0);
}

export function matchScopeAny(scopePath: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => matchScope(scopePath, p));
}

// --- Collection path filtering ---

/** Check if a collection's path template is under the graph collection. */
export function isCollectionUnderGraph(colPath: string, graphCollection?: string): boolean {
  if (!graphCollection) return true;
  const firstSegment = colPath.split('/')[0];
  return firstSegment === graphCollection;
}

// --- Page context detection ---

export type PageContext = 'graph' | 'collection' | 'other';

export function detectPageContext(pathname: string): PageContext {
  if (pathname.includes('/col/')) return 'collection';
  return 'graph';
}

export function extractCollectionFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/col\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

export function extractCollectionParams(
  pathname: string,
  colDef: { name: string; pathParams: string[] },
): Record<string, string> {
  const colPrefix = `/col/${encodeURIComponent(colDef.name)}/`;
  const idx = pathname.indexOf(colPrefix);
  if (idx < 0) return {};
  const remainder = pathname.slice(idx + colPrefix.length);
  const beforeDoc = remainder.includes('/doc/') ? remainder.slice(0, remainder.indexOf('/doc/')) : remainder;
  const parts = beforeDoc.split('/').filter(Boolean).map(decodeURIComponent);
  const params: Record<string, string> = {};
  for (let i = 0; i < Math.min(parts.length, colDef.pathParams.length); i++) {
    params[colDef.pathParams[i]] = parts[i];
  }
  return params;
}

export function resolveViewForEntity(
  resolverConfig: { default?: string; listing?: string; detail?: string; inline?: string } | undefined,
  availableViews: Array<{ viewName: string; tagName: string }>,
  context?: 'listing' | 'detail' | 'inline',
): string {
  const availableNames = new Set(availableViews.map((v) => v.viewName));

  if (!resolverConfig) return 'json';

  if (context) {
    const contextDefault = resolverConfig[context];
    if (contextDefault && availableNames.has(contextDefault)) {
      return contextDefault;
    }
  }

  if (resolverConfig.default && availableNames.has(resolverConfig.default)) {
    return resolverConfig.default;
  }

  return 'json';
}
