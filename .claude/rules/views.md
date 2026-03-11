---
paths:
  - "**/views*.ts"
  - "**/views*.tsx"
  - "**/*.svelte"
  - "src/views.ts"
  - "src/react.ts"
  - "src/svelte.ts"
  - "editor/server/views-bundler.ts"
  - "editor/server/entities-loader.ts"
  - "editor/src/components/CustomView.tsx"
  - "editor/src/components/ViewSwitcher.tsx"
  - "editor/src/components/ViewGallery.tsx"
---

# Model Views

Model views let projects define **multiple, purpose-driven visual representations** for each entity type. Views are **framework-agnostic** Web Components (Custom Elements). The data contract for each view is the `data` shape defined by the entity's JSON Schema.

## View Component Contract

```typescript
interface ViewComponentClass {
  new (...args: any[]): { data: Record<string, unknown> };
  viewName: string;        // required -- short identifier (e.g. 'card')
  description?: string;    // optional -- shown in gallery and tooltips
}
```

Key rules:
- The `data` setter must trigger a re-render
- `connectedCallback()` should also render (for initial mount)
- Use inline styles or Shadow DOM for styling
- The component receives only the `data` portion, never firegraph fields (aType, aUid, etc.)

## `defineViews()` API

```typescript
import { defineViews } from 'firegraph';
```

- **Browser**: calls `customElements.define()` for each view class with deterministic tag names
- **Node.js**: only returns metadata, no DOM APIs called

Tag name format: `fg-{entityType}-{viewName}` for nodes, `fg-edge-{axbType}-{viewName}` for edges. Non-alphanumeric characters replaced with hyphens, consecutive hyphens collapsed.

## Framework Adapters

**React** (`firegraph/react`):
```tsx
import { wrapReact } from 'firegraph/react';
const TaskCard = wrapReact(({ data }) => (
  <div style={{ padding: 12 }}><strong>{String(data.title ?? '')}</strong></div>
), { viewName: 'card', description: 'Compact task card' });
export default [TaskCard];
```

**Svelte 5** (`firegraph/svelte`):
```ts
import { wrapSvelte } from 'firegraph/svelte';
import TaskCard from './TaskCard.svelte';
export default [
  wrapSvelte(TaskCard, { viewName: 'card', description: 'Compact task card' }),
];
```

How adapters work:
- `wrapReact` returns an HTMLElement that lazily imports `react` and `react-dom/client`, creates a React root
- `wrapSvelte` returns an HTMLElement that lazily imports `svelte`, mounts with `{ data }` props
- React/Svelte resolved from project's `node_modules` by esbuild
- Browser shim in `views-bundler.ts` routes `firegraph/react` and `firegraph/svelte` to adapter implementations
- Svelte projects need `esbuild-svelte` installed for `.svelte` compilation

Peer deps (all optional): `react` ^18/^19, `react-dom` ^18/^19, `svelte` ^5, `esbuild-svelte`

## Editor Startup Flow

1. **Metadata extraction**: `entities-loader.ts` uses `jiti` to import per-entity `views.ts` in Node.js (HTMLElement shim injected)
2. **Browser bundle**: `views-bundler.ts` generates synthetic entry, bundles with esbuild (ESM, browser, es2022), kept in memory with content hash
3. **API endpoints**: `GET /api/views` (metadata JSON), `GET /api/views/bundle` (compiled JS with caching headers)
4. **Frontend loading**: `App.tsx` injects `<script type="module">` if `hasViews` is true, triggering `customElements.define()` in browser

## Editor Integration

- **Node detail**: ViewSwitcher toolbar shows `[JSON] [card] [profile]`, swaps between JsonView and CustomView
- **Edge rows**: view switchers if views registered for that edge's `axbType`
- **View Gallery** (`/views`): Storybook-like preview page with live sample data editing

## `CustomView` React Wrapper

Bridges React and Web Components: creates custom element imperatively via `document.createElement(tagName)`, sets `.data` property on changes, replaces element if tagName changes, cleans up on unmount.

## Styling

Views run inside the editor page (dark background, slate-950). Options: inline styles, Shadow DOM, adopted stylesheets.

## Examples

See `examples/entities/nodes/tour/views.ts`, `examples/entities/edges/hasDeparture/views.ts`, and `examples/07-model-views.ts`.
