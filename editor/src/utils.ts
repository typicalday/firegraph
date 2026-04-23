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

/**
 * Editor-specific scope filter for node/edge type visibility.
 *
 * Core `matchScopeAny` treats missing `allowedIn` as "allowed everywhere"
 * (backwards-compatible for validation). But for the editor UI, types without
 * an explicit `allowedIn` should only appear at root — if they were intended
 * for subgraphs, they'd declare it. This prevents cluttering subgraph views
 * with root-only types.
 */
export function isTypeVisibleInScope(
  scopeNamesPath: string,
  allowedIn: string[] | undefined,
): boolean {
  // At root: show everything (no constraint = root-allowed)
  if (!scopeNamesPath) return matchScopeAny(scopeNamesPath, allowedIn);
  // In a subgraph: types without allowedIn are treated as root-only
  if (!allowedIn || allowedIn.length === 0) return false;
  return matchScopeAny(scopeNamesPath, allowedIn);
}

// --- Collection path filtering ---

/** Check if a collection's path template is under the graph collection. */
export function isCollectionUnderGraph(colPath: string, graphCollection?: string): boolean {
  if (!graphCollection) return true;
  const firstSegment = colPath.split('/')[0];
  return firstSegment === graphCollection;
}

// --- Firestore path encoding (tilde-encoding, same convention as Firestore console) ---

/** Encode a Firestore path for URL usage (/ → ~2F). */
export function encodeFsPath(path: string): string {
  return path.replace(/\//g, '~2F');
}

/** Decode a tilde-encoded Firestore path (~2F → /). */
export function decodeFsPath(encoded: string): string {
  return encoded.replace(/~2F/g, '/');
}

/** Check if a decoded Firestore path belongs to the graph collection. */
export function isGraphPath(fsPath: string, graphCollection?: string): boolean {
  if (!graphCollection) return false;
  return fsPath === graphCollection || fsPath.startsWith(graphCollection + '/');
}

/** Extract graph scope from a decoded Firestore path. Returns "" for root. */
export function extractGraphScope(fsPath: string, graphCollection: string): string {
  if (fsPath === graphCollection) return '';
  return fsPath.slice(graphCollection.length + 1);
}

/** Derive scopeNamesPath from a graph scope string (odd-indexed segments = subgraph names). */
export function scopeToNamesPath(scope: string): string {
  if (!scope) return '';
  const parts = scope.split('/');
  return parts.filter((_, i) => i % 2 === 1).join('/');
}

/** Parse a graph scope into breadcrumb segments. */
export function parseScopeSegments(
  scope: string,
): Array<{ parentUid: string; subgraphName: string }> {
  if (!scope) return [];
  const parts = scope.split('/');
  const segs: Array<{ parentUid: string; subgraphName: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    segs.push({ parentUid: parts[i], subgraphName: parts[i + 1] });
  }
  return segs;
}

/** Match a Firestore path against a collection path template. Returns params or null. */
export function matchCollectionTemplate(
  fsPath: string,
  template: string,
): Record<string, string> | null {
  const fsSegments = fsPath.split('/');
  const tplSegments = template.split('/');
  if (fsSegments.length !== tplSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < tplSegments.length; i++) {
    const tpl = tplSegments[i];
    const paramMatch = tpl.match(/^\{(.+)\}$/);
    if (paramMatch) {
      params[paramMatch[1]] = fsSegments[i];
    } else if (tpl !== fsSegments[i]) {
      return null;
    }
  }
  return params;
}

/** Resolve a collection path template by substituting `{param}` with values from `params`. */
export function resolveCollectionPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
}

/** Build a URL for a Firestore path + optional page action. */
export function fsUrl(fsPath: string, pageAction?: string): string {
  const encoded = encodeFsPath(fsPath);
  if (!pageAction) return `/${encoded}`;
  return `/${encoded}/${pageAction}`;
}

export function resolveViewForEntity(
  resolverConfig:
    | { default?: string; listing?: string; detail?: string; inline?: string }
    | undefined,
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
