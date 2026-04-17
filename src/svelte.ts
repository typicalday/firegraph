/**
 * Svelte 5 adapter for firegraph views.
 *
 * Wraps a Svelte component into a Web Component (HTMLElement) that satisfies
 * the firegraph `ViewComponentClass` contract. Import from `firegraph/svelte`:
 *
 * @example
 * ```ts
 * import { wrapSvelte } from 'firegraph/svelte';
 * import TaskCard from './TaskCard.svelte';
 *
 * export default [
 *   wrapSvelte(TaskCard, { viewName: 'card', description: 'Compact task card' }),
 * ];
 * ```
 */

import type { ViewComponentClass } from './views.js';

/** Metadata required for every firegraph view. */
export interface ViewMeta {
  /** Short identifier (e.g. 'card', 'detail'). */
  viewName: string;
  /** Optional human-readable description. */
  description?: string;
}

type AnyClass = { new (...args: any[]): any };

/**
 * Get HTMLElement from the runtime environment.
 * Returns a base class for view elements — works in both browser and Node.js
 * (where HTMLElement may be shimmed by the editor server).
 */
function getBaseClass(): AnyClass {
  const g = globalThis as any;
  return g.HTMLElement ?? class {};
}

/**
 * Wrap a Svelte 5 component into a firegraph `ViewComponentClass`.
 *
 * The returned class extends `HTMLElement` and lazily imports `svelte` at
 * mount time. Svelte is resolved from the project's own `node_modules` —
 * firegraph does not bundle or depend on Svelte itself.
 *
 * The Svelte component should accept a `data` prop:
 * ```svelte
 * <script>
 *   let { data } = $props();
 * </script>
 * ```
 *
 * Props are updated by mutating the props object — Svelte 5's reactivity
 * system picks up the changes automatically.
 */

export function wrapSvelte(Component: any, meta: ViewMeta): ViewComponentClass {
  const Base = getBaseClass();

  const Cls = class extends Base {
    static viewName = meta.viewName;
    static description = meta.description;

    _data: Record<string, unknown> = {};

    _instance: any = null;

    _props: any = null;
    _mounted = false;

    set data(v: Record<string, unknown>) {
      this._data = v;
      if (this._props) {
        // Svelte 5: mutating the props object triggers reactivity
        this._props.data = v;
      } else if (this._mounted) {
        this._mount();
      }
    }

    get data() {
      return this._data;
    }

    connectedCallback() {
      this._mounted = true;
      this._mount();
    }

    disconnectedCallback() {
      this._mounted = false;
      if (this._instance) {
        // Dynamic import — resolved from project's node_modules at runtime
        (Function('return import("svelte")')() as Promise<{ unmount: Function }>).then(
          ({ unmount }) => {
            if (this._instance) {
              unmount(this._instance);
              this._instance = null;
              this._props = null;
            }
          },
        );
      }
    }

    async _mount() {
      // Dynamic import — resolved from project's node_modules at runtime

      const svelte: any = await (Function('return import("svelte")')() as Promise<unknown>);
      if (!this._mounted) return; // disconnected while awaiting

      // Clean up previous instance
      if (this._instance) {
        svelte.unmount(this._instance);
      }

      // Svelte 5: pass a props object — mutating it later triggers re-renders
      this._props = { data: this._data };
      this._instance = svelte.mount(Component, {
        target: this,
        props: this._props,
      });
    }
  };

  return Cls as unknown as ViewComponentClass;
}
