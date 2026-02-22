import path from 'path';
import type { GraphRegistry } from '../../src/types.js';
import { importJiti } from './jiti-import.js';

function isGraphRegistry(value: unknown): value is GraphRegistry {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as GraphRegistry).validate === 'function' &&
    typeof (value as GraphRegistry).lookup === 'function' &&
    typeof (value as GraphRegistry).entries === 'function'
  );
}

export async function loadRegistry(registryPath: string): Promise<GraphRegistry> {
  const absolutePath = path.resolve(process.cwd(), registryPath);

  const { createJiti } = await importJiti();
  const jiti = createJiti(`file://${absolutePath}`, {
    interopDefault: true,
    moduleCache: false,
  });

  let mod: Record<string, unknown>;
  try {
    mod = (await jiti.import(absolutePath)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `Failed to import registry file "${registryPath}":\n${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Check default export, then named "registry" export, then scan all exports
  let registry: GraphRegistry | undefined;

  if (isGraphRegistry(mod.default)) {
    registry = mod.default;
  } else if (isGraphRegistry(mod.registry)) {
    registry = mod.registry;
  } else {
    for (const value of Object.values(mod)) {
      if (isGraphRegistry(value)) {
        registry = value;
        break;
      }
    }
  }

  if (!registry) {
    throw new Error(
      `Registry file "${registryPath}" must export a GraphRegistry (as default, named "registry", or any named export).\n` +
        `Example: export const registry = createRegistry([...]);`,
    );
  }

  return registry;
}
