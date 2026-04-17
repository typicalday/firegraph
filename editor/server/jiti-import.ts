import type * as jitiNS from 'jiti';

/**
 * Dynamically import jiti so the editor server doesn't crash at startup
 * if jiti isn't installed. This allows the editor to work for read-only
 * browsing even without jiti — only TS file loading (registry, views, config)
 * requires it.
 */
export async function importJiti(): Promise<typeof jitiNS> {
  try {
    return await import('jiti');
  } catch {
    throw new Error(
      'The "jiti" package is required to load TypeScript files (registry, views, config).\n' +
        'Install it with: npm install jiti',
    );
  }
}
