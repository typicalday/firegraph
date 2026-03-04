import path from 'path';
import fs from 'fs';
import { importJiti } from './jiti-import.js';

/**
 * Structural interface for a firegraph config object.
 * Mirrors `FiregraphConfig` from `src/config.ts` but defined locally
 * to avoid import-path issues in the bundled editor server.
 */
export interface LoadedConfig {
  entities?: string;
  project?: string;
  collection?: string;
  emulator?: string;
  editor?: {
    port?: number;
    readonly?: boolean;
  };
  chat?: false | {
    model?: string;
    maxConcurrency?: number;
  };
  viewDefaults?: {
    nodes?: Record<string, { default?: string; listing?: string; detail?: string; inline?: string }>;
    edges?: Record<string, { default?: string; listing?: string; detail?: string; inline?: string }>;
  };
}

/** Config file names to search for, in priority order. */
const CONFIG_FILES = [
  'firegraph.config.ts',
  'firegraph.config.js',
  'firegraph.config.mjs',
];

/**
 * Discover the config file path.
 *
 * 1. If `explicitPath` is provided (from --config CLI flag), use it.
 * 2. Otherwise search cwd for known config file names.
 * 3. Returns `null` if no config file found (not an error).
 */
export function discoverConfigPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const abs = path.resolve(process.cwd(), explicitPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Config file not found: ${explicitPath} (resolved to ${abs})`);
    }
    return abs;
  }

  const cwd = process.cwd();
  for (const name of CONFIG_FILES) {
    const candidate = path.join(cwd, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Load and return a firegraph config file.
 * Returns `null` if no config file exists.
 */
export async function loadConfig(explicitPath?: string): Promise<{
  config: LoadedConfig;
  configPath: string;
} | null> {
  const configPath = discoverConfigPath(explicitPath);
  if (!configPath) return null;

  const { createJiti } = await importJiti();
  const jiti = createJiti(`file://${configPath}`, {
    interopDefault: true,
    moduleCache: false,
  });

  let mod: Record<string, unknown>;
  try {
    mod = (await jiti.import(configPath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to import config file "${configPath}":\n${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Accept default export or named "config" export
  const config = (mod.default ?? mod.config) as LoadedConfig | undefined;
  if (!config || typeof config !== 'object') {
    throw new Error(
      `Config file "${configPath}" must export a FiregraphConfig object.\n` +
        `Example: export default defineConfig({ entities: './entities' });`,
    );
  }

  return { config, configPath };
}
