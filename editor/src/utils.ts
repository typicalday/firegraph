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
