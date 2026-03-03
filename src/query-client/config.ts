import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG_FILES = ['firegraph.config.ts', 'firegraph.config.js', 'firegraph.config.mjs'];
const DEFAULT_PORT = 3884;

/**
 * Read the editor port from firegraph config files using regex.
 * Zero-dependency — no jiti needed.
 */
export function readEditorPort(cwd?: string): number {
  const dir = cwd ?? process.cwd();
  for (const name of CONFIG_FILES) {
    try {
      const content = readFileSync(join(dir, name), 'utf8');
      const editorBlock = content.match(/editor\s*:\s*\{[^}]*\}/s)?.[0] ?? '';
      const portMatch = editorBlock.match(/port\s*:\s*(\d+)/);
      if (portMatch) return parseInt(portMatch[1], 10);
    } catch {
      continue;
    }
  }
  return DEFAULT_PORT;
}
