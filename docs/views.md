# Firegraph Views — Design Guide

Views are Web Components that render entity data in purpose-driven ways. One entity type can have many views, each optimized for a specific display context — a compact row for listings, a rich card for inline previews, a detailed panel for the node page.

## Core Concept

Every firegraph entity has a `data` payload whose shape is defined by the registry's Zod schema. A view is simply a different way to render that same data. All views for an entity type receive the **same data object** — they just present it differently.

```
Registry schema (contract)       Views (presentation)
┌──────────────────────┐        ┌─────────────┐
│ task                 │        │ row          │  one-line listing
│   title: str         │───────>│ card         │  compact summary
│   description: str   │        │ detail       │  full breakdown
│   status: enum       │        └─────────────┘
│   architect: str     │
└──────────────────────┘
         one data model ──> many views
```

## Display Contexts

The editor renders entities in three contexts. Each context has different space constraints and purposes:

### `listing` — Browse page rows

The listing context appears in the **NodeBrowser** table. Each entity is one row in a table, alongside UID and timestamp columns.

**Design guidelines:**
- **Horizontal layout** — use `display: flex; align-items: center` to flow content in a single line
- **Minimal height** — aim for a single line (24-32px). The row height auto-fits, but tall views create uneven tables
- **Show only identifiers** — title/name, status badge, maybe one key attribute. No descriptions, no nested content
- **Truncate aggressively** — use `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` on text
- **No borders or backgrounds** — the table provides the visual structure. A `row` view should feel like styled table cell content, not a standalone card

```typescript
class TaskRow extends HTMLElement {
  static viewName = 'row';
  static description = 'Horizontal listing row';
  // ...
  private render() {
    const d = this._data;
    this.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;padding:2px 0;">
        ${badge(d.status as string ?? 'created')}
        <span style="color:#e2e8f0;font-size:13px;font-weight:500;
                      flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
          ${d.title ?? 'Untitled'}
        </span>
        <span style="color:#64748b;font-size:11px;">${d.assignee ?? ''}</span>
      </div>
    `;
  }
}
```

### `inline` — Edge rows and traversal results

The inline context appears when an entity is shown **inside another entity's page** — as a resolved node in an edge row, or as a traversal result. Space is limited but not as tight as listing.

**Design guidelines:**
- **Compact card** — a small, self-contained unit with a subtle border/background
- **2-4 lines max** — title, status, one or two key fields
- **No expandable content** — the user can click through to the full detail page
- **Works at ~300-400px width** — edge rows are narrower than full page width

This is typically the `card` view — compact enough for embedding, rich enough to be useful at a glance.

```typescript
class TaskCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact task overview';
  // ...
  private render() {
    const d = this._data;
    this.innerHTML = `
      <div style="padding:14px 16px;border-radius:10px;background:#1e293b;
                  border:1px solid #334155;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <strong style="color:#e2e8f0;font-size:14px;flex:1;
                         overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${d.title ?? 'Untitled'}
          </strong>
          ${badge(d.status as string ?? 'created')}
        </div>
        <div style="color:#94a3b8;font-size:12px;line-height:1.5;
                    display:-webkit-box;-webkit-line-clamp:2;
                    -webkit-box-orient:vertical;overflow:hidden;">
          ${d.description ?? ''}
        </div>
      </div>
    `;
  }
}
```

### `detail` — Node detail page

The detail context is the main content area of a **node's dedicated page**. Full width available, no height constraints.

**Design guidelines:**
- **Show everything** — all fields, full descriptions, nested data, results, errors
- **Use sections and labels** — group related fields with headers
- **Whitespace is fine** — this is the one place where vertical space is abundant
- **Pre-wrap long text** — descriptions, error messages, results should be fully readable
- **Visual hierarchy** — title/status at top, primary content in the middle, metadata at bottom

```typescript
class TaskDetail extends HTMLElement {
  static viewName = 'detail';
  static description = 'Full task details';
  // ...
  private render() {
    const d = this._data;
    this.innerHTML = `
      <div style="padding:16px;border-radius:10px;background:#0f172a;
                  border:1px solid #1e293b;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <h3 style="margin:0;color:#e2e8f0;font-size:16px;font-weight:600;flex:1;">
            ${d.title ?? 'Untitled'}
          </h3>
          ${badge(d.status as string ?? 'created')}
        </div>
        <div style="color:#cbd5e1;font-size:13px;line-height:1.6;
                    white-space:pre-wrap;margin-bottom:12px;">
          ${d.description ?? ''}
        </div>
        ${d.result ? `
          <div style="margin-top:12px;">
            <div style="color:#4ade80;font-size:11px;font-weight:600;
                        margin-bottom:4px;text-transform:uppercase;">Result</div>
            <div style="padding:10px 12px;border-radius:8px;background:#22c55e08;
                        border:1px solid #22c55e20;color:#86efac;font-size:12px;
                        line-height:1.5;white-space:pre-wrap;">${d.result}</div>
          </div>
        ` : ''}
      </div>
    `;
  }
}
```

## Recommended View Set

Not every entity type needs all three views. Here's a practical guide:

| Entity complexity | Recommended views | Notes |
|---|---|---|
| **Simple** (1-2 fields) | `card` only | Card works in all contexts |
| **Medium** (3-5 fields) | `row` + `card` | Row for listings, card for detail + inline |
| **Rich** (many fields, long text) | `row` + `card` + `detail` | Each context gets a tailored view |

If you only define one view (e.g. `card`), it will be used everywhere. The context system gracefully falls back: if a `listing` context-specific default isn't set, the global `default` is used. If no default is set, `json` is shown.

## View Component Contract

Every view is a class extending `HTMLElement` with:

```typescript
class MyView extends HTMLElement {
  static viewName = 'card';           // required — short identifier
  static description = 'A card view'; // optional — shown in gallery

  private _data: Record<string, unknown> = {};

  set data(value: Record<string, unknown>) {
    this._data = value;
    this.render();
  }

  get data() {
    return this._data;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    // Render using this._data
    this.innerHTML = `...`;
  }
}
```

Key rules:
- The `data` setter **must trigger a re-render** — the editor calls it whenever data changes
- `connectedCallback()` should also render (for initial mount)
- The component receives only the `data` portion of the record, never firegraph fields (`aType`, `aUid`, etc.)
- Views are framework-agnostic — no React, no build step required

## Registering Views

Use `defineViews()` to register view components and provide sample data:

```typescript
import { defineViews } from 'firegraph';

export default defineViews({
  nodes: {
    task: {
      views: [TaskRow, TaskCard, TaskDetail],
      sampleData: {
        title: 'Implement authentication',
        description: 'Add JWT-based auth with refresh tokens.',
        status: 'active',
        architect: 'architect',
      },
    },
  },
  edges: {
    hasStep: {
      views: [HasStepCard],
      sampleData: { order: 3 },
    },
  },
});
```

- **Node views** are keyed by `aType`
- **Edge views** are keyed by `axbType`
- **`sampleData`** is a single object matching the entity's Zod schema — it's shared across all views for that entity type (one data model, many presentations)
- Tag names are auto-generated: `fg-{type}-{viewName}` for nodes, `fg-edge-{axbType}-{viewName}` for edges

## Configuring View Defaults

In `firegraph.config.ts`, the `viewDefaults` section controls which view is shown by default in each context:

```typescript
export default defineConfig({
  // ...
  viewDefaults: {
    nodes: {
      task: {
        default: 'card',       // fallback for any context
        listing: 'row',        // NodeBrowser table rows
        detail: 'detail',      // node detail page
        inline: 'card',        // edge rows, traversal results
      },
    },
    edges: {
      hasStep: {
        default: 'card',
        inline: 'card',
      },
    },
  },
});
```

### Resolution Priority

When the editor needs to pick a view, it evaluates in this order:

1. **Context default** — if a context is active (`listing`, `detail`, or `inline`), use the context-specific view name
2. **Global default** — the `default` key
3. **`json` fallback** — raw JSON view (always available)

Only view names that actually exist in the view registry are used — unknown names are silently skipped.

## Styling

Views run inside the editor's page. Options for styling:

- **Inline styles** (simplest) — `style="..."` attributes directly in HTML. Most examples use this.
- **Shadow DOM** (isolated) — call `this.attachShadow({ mode: 'open' })` in the constructor, render into `this.shadowRoot`. Styles won't leak in or out.
- **Adopted stylesheets** — create a `CSSStyleSheet`, add to `this.shadowRoot.adoptedStyleSheets`. Most performant for Shadow DOM.

The editor background is dark (`slate-950`), so views with dark color schemes blend in naturally.

## Shared Helpers

Extract common rendering logic into helper functions to keep view code DRY:

```typescript
const font = 'system-ui, -apple-system, sans-serif';

const statusColors: Record<string, { bg: string; fg: string; border: string }> = {
  active:    { bg: '#3b82f620', fg: '#60a5fa', border: '#3b82f640' },
  completed: { bg: '#22c55e20', fg: '#4ade80', border: '#22c55e40' },
  failed:    { bg: '#ef444420', fg: '#f87171', border: '#ef444440' },
};

function badge(status: string): string {
  const c = statusColors[status] ?? { bg: '#334155', fg: '#94a3b8', border: '#475569' };
  return `<span style="display:inline-block;padding:2px 8px;border-radius:9999px;
    font-size:11px;font-weight:600;background:${c.bg};color:${c.fg};
    border:1px solid ${c.border};text-transform:uppercase;">${status}</span>`;
}

function card(inner: string): string {
  return `<div style="padding:14px 16px;border-radius:10px;background:#1e293b;
    border:1px solid #334155;font-family:${font};">${inner}</div>`;
}

function truncate(s: string, max: number): string {
  return !s ? '' : s.length > max ? s.slice(0, max) + '...' : s;
}
```

## Validation

At startup, the editor validates views against the registry and warns about:

- **Orphaned views** — views registered for entity types that don't exist in the registry
- **Invalid sample data** — sample data that fails the entity's Zod schema validation
- **Unknown view defaults** — `viewDefaults` referencing view names that aren't registered

Warnings appear in the server console and in a collapsible banner at the top of the editor UI.

## View Gallery

The editor includes a built-in gallery at `/views` (visible in the sidebar when views are loaded). It renders every registered view with its sample data, and includes a live JSON editor so you can test views with different data without touching code.
