import path from 'path';
import type { ViewRegistry } from '../../src/views.js';
import { importJiti } from './jiti-import.js';

function isViewRegistry(value: unknown): value is ViewRegistry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nodes === 'object' &&
    v.nodes !== null &&
    typeof v.edges === 'object' &&
    v.edges !== null
  );
}

export async function loadViews(viewsPath: string): Promise<ViewRegistry> {
  const absolutePath = path.resolve(process.cwd(), viewsPath);

  // Shim HTMLElement for Node.js so view classes that extend it can be parsed.
  // The actual custom element registration is skipped on the server (defineViews
  // checks for globalThis.customElements), but the class declarations need a
  // base class to extend.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const hadHTMLElement = 'HTMLElement' in g;
  if (!hadHTMLElement) {
    g.HTMLElement = class HTMLElement {};
  }

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
      `Failed to import views file "${viewsPath}":\n${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Clean up the shim so we don't pollute the global scope
    if (!hadHTMLElement) {
      delete g.HTMLElement;
    }
  }

  // Check default export, then named "views" export, then scan all exports
  let viewRegistry: ViewRegistry | undefined;

  if (isViewRegistry(mod.default)) {
    viewRegistry = mod.default;
  } else if (isViewRegistry(mod.views)) {
    viewRegistry = mod.views;
  } else {
    for (const value of Object.values(mod)) {
      if (isViewRegistry(value)) {
        viewRegistry = value;
        break;
      }
    }
  }

  if (!viewRegistry) {
    throw new Error(
      `Views file "${viewsPath}" must export a ViewRegistry (as default, named "views", or any named export).\n` +
        `Example: export default defineViews({ nodes: { ... }, edges: { ... } });`,
    );
  }

  return viewRegistry;
}
