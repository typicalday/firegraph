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
 * Resolve the best view name for an entity given its data and config.
 * Mirrors `resolveView` from `src/config.ts` — duplicated to avoid cross-build imports.
 */
export function resolveViewForEntity(
  data: Record<string, unknown>,
  resolverConfig: { default?: string; rules?: Array<{ when: Record<string, unknown>; view: string }> } | undefined,
  availableViews: Array<{ viewName: string; tagName: string }>,
): string {
  const availableNames = new Set(availableViews.map((v) => v.viewName));

  if (!resolverConfig) return 'json';

  if (resolverConfig.rules) {
    for (const rule of resolverConfig.rules) {
      const matches = Object.entries(rule.when).every(([k, v]) => data[k] === v);
      if (matches && availableNames.has(rule.view)) {
        return rule.view;
      }
    }
  }

  if (resolverConfig.default && availableNames.has(resolverConfig.default)) {
    return resolverConfig.default;
  }

  return 'json';
}
