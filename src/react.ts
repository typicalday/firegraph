/**
 * React adapter for firegraph views.
 *
 * Wraps a React function component into a Web Component (HTMLElement) that
 * satisfies the firegraph `ViewComponentClass` contract. Import from
 * `firegraph/react`:
 *
 * @example
 * ```tsx
 * import { wrapReact } from 'firegraph/react';
 *
 * const TaskCard = wrapReact(({ data }) => (
 *   <div style={{ padding: 12 }}>
 *     <strong>{String(data.title ?? '')}</strong>
 *   </div>
 * ), { viewName: 'card', description: 'Compact task card' });
 *
 * export default [TaskCard];
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

/** A React function component that receives entity data. */
export type ReactViewComponent = (props: { data: Record<string, unknown> }) => unknown;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClass = { new (...args: any[]): any };

/**
 * Get HTMLElement from the runtime environment.
 * Returns a base class for view elements — works in both browser and Node.js
 * (where HTMLElement may be shimmed by the editor server).
 */
function getBaseClass(): AnyClass {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  return g.HTMLElement ?? class {};
}

/**
 * Wrap a React function component into a firegraph `ViewComponentClass`.
 *
 * The returned class extends `HTMLElement` and lazily imports `react` and
 * `react-dom/client` at render time. React is resolved from the project's
 * own `node_modules` — firegraph does not bundle or depend on React itself.
 */
export function wrapReact(
  Component: ReactViewComponent,
  meta: ViewMeta,
): ViewComponentClass {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let React: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ReactDOM: any = null;
  let loaded = false;

  async function ensureReact() {
    if (loaded) return;
    // Dynamic imports — resolved from project's node_modules at runtime
    const [r, rd] = await Promise.all([
      Function('return import("react")')() as Promise<unknown>,
      Function('return import("react-dom/client")')() as Promise<unknown>,
    ]);
    React = r;
    ReactDOM = rd;
    loaded = true;
  }

  const Base = getBaseClass();

  const Cls = class extends Base {
    static viewName = meta.viewName;
    static description = meta.description;

    _data: Record<string, unknown> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _root: any = null;
    _mounted = false;

    set data(v: Record<string, unknown>) {
      this._data = v;
      this._render();
    }

    get data() {
      return this._data;
    }

    connectedCallback() {
      this._mounted = true;
      this._render();
    }

    disconnectedCallback() {
      this._mounted = false;
      this._root?.unmount();
      this._root = null;
    }

    async _render() {
      if (!this._mounted) return;
      await ensureReact();
      if (!this._mounted) return; // may have disconnected while awaiting

      if (!this._root) {
        this._root = ReactDOM.createRoot(this);
      }
      this._root.render(React.createElement(Component, { data: this._data }));
    }
  };

  return Cls as unknown as ViewComponentClass;
}
