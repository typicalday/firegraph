/**
 * Model Views — define multiple visual representations per entity type
 *
 * Views are framework-agnostic Web Components (Custom Elements) that receive
 * an entity's `data` payload and render it in purpose-driven ways.
 *
 * Each view class:
 * - Extends HTMLElement
 * - Has a static `viewName` identifier (e.g. 'row', 'card', 'detail')
 * - Receives data via a `data` property setter
 *
 * Common view types and their display contexts:
 *
 *   row     Compact, horizontal, single-line. Used in NodeBrowser table rows
 *           (listing context). No borders — the table provides structure.
 *
 *   card    Self-contained compact card with background/border. Used for
 *           inline previews in edge rows and traversal results (inline context).
 *
 *   detail  Full-height panel showing all data. Used on the node detail page
 *           (detail context). No height constraints.
 *
 * All views for an entity type receive the same data object — one data model,
 * rendered differently depending on the context.
 *
 * See docs/views.md for full design guidelines.
 *
 * To use views in the editor:
 *   npx firegraph editor --registry ./src/registry.ts --views ./examples/07-model-views.ts
 */
import { defineViews } from '../src/index.js';

// ═══════════════════════════════════════════════════════════════
// 1. Define view components as Web Components
// ═══════════════════════════════════════════════════════════════

class TourCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact tour overview card';

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
    const d = this._data;
    const difficultyColors: Record<string, string> = {
      easy: '#22c55e',
      medium: '#eab308',
      hard: '#ef4444',
    };
    const color = difficultyColors[d.difficulty as string] ?? '#94a3b8';

    this.innerHTML = `
      <div style="padding: 16px; border-radius: 12px; background: #1e293b; border: 1px solid #334155; font-family: system-ui, sans-serif;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
          <strong style="color: #e2e8f0; font-size: 16px;">${d.name ?? 'Unnamed Tour'}</strong>
          <span style="padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 600; background: ${color}20; color: ${color}; border: 1px solid ${color}40;">
            ${d.difficulty ?? '—'}
          </span>
        </div>
        <div style="color: #94a3b8; font-size: 13px;">
          Max riders: <span style="color: #e2e8f0;">${d.maxRiders ?? '—'}</span>
        </div>
      </div>
    `;
  }
}

class TourDetail extends HTMLElement {
  static viewName = 'detail';
  static description = 'Full tour details panel';

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
    const d = this._data;
    const fields = Object.entries(d)
      .map(
        ([key, val]) => `
        <tr>
          <td style="padding: 4px 12px 4px 0; color: #64748b; font-size: 12px; white-space: nowrap;">${key}</td>
          <td style="padding: 4px 0; color: #e2e8f0; font-size: 13px;">${JSON.stringify(val)}</td>
        </tr>`,
      )
      .join('');

    this.innerHTML = `
      <div style="padding: 16px; border-radius: 12px; background: #0f172a; border: 1px solid #1e293b; font-family: system-ui, sans-serif;">
        <h3 style="margin: 0 0 12px 0; color: #e2e8f0; font-size: 14px; font-weight: 600;">
          ${d.name ?? 'Tour Details'}
        </h3>
        <table style="border-collapse: collapse; width: 100%;">
          <tbody>${fields}</tbody>
        </table>
      </div>
    `;
  }
}

class DepartureBadge extends HTMLElement {
  static viewName = 'badge';
  static description = 'Departure date badge';

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
    const d = this._data;
    this.innerHTML = `
      <div style="display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; border-radius: 8px; background: #1e293b; border: 1px solid #334155; font-family: system-ui, sans-serif;">
        <span style="font-size: 20px;">📅</span>
        <div>
          <div style="color: #e2e8f0; font-size: 14px; font-weight: 600;">${d.date ?? '—'}</div>
          <div style="color: #64748b; font-size: 11px;">Spots: ${d.maxSpots ?? '—'} &middot; Price: $${d.priceUsd ?? '—'}</div>
        </div>
      </div>
    `;
  }
}

// ═══════════════════════════════════════════════════════════════
// 2. Edge view components
// ═══════════════════════════════════════════════════════════════

/**
 * Edge views work identically to node views — they receive the edge's
 * `data` payload (not the firegraph fields like aUid/bUid/axbType).
 *
 * Edge views are keyed by `axbType` in defineViews().
 * Tag names follow the pattern: fg-edge-{axbType}-{viewName}
 */

class HasDepartureTimeline extends HTMLElement {
  static viewName = 'timeline';
  static description = 'Timeline entry for a departure edge';

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
    const d = this._data;
    const status = (d.status as string) ?? 'scheduled';
    const statusColors: Record<string, string> = {
      scheduled: '#3b82f6',
      confirmed: '#22c55e',
      cancelled: '#ef4444',
    };
    const color = statusColors[status] ?? '#94a3b8';

    this.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 8px; background: #1e293b; border: 1px solid #334155; font-family: system-ui, sans-serif;">
        <div style="width: 10px; height: 10px; border-radius: 50%; background: ${color}; flex-shrink: 0;"></div>
        <div style="flex: 1;">
          <div style="color: #e2e8f0; font-size: 13px; font-weight: 500;">${d.scheduledDate ?? '—'}</div>
          ${d.notes ? `<div style="color: #94a3b8; font-size: 11px; margin-top: 2px;">${d.notes}</div>` : ''}
        </div>
        <span style="padding: 2px 8px; border-radius: 9999px; font-size: 10px; font-weight: 600; background: ${color}20; color: ${color}; border: 1px solid ${color}40; text-transform: uppercase;">
          ${status}
        </span>
      </div>
    `;
  }
}

class HasRiderCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact rider assignment card';

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
    const d = this._data;
    const confirmed = d.confirmed === true;

    this.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 8px; background: #1e293b; border: 1px solid #334155; font-family: system-ui, sans-serif;">
        <span style="font-size: 14px;">${confirmed ? '✅' : '⏳'}</span>
        <div style="flex: 1;">
          <div style="color: #e2e8f0; font-size: 12px;">
            Seat <strong>${d.seatNumber ?? '—'}</strong>
          </div>
          ${d.dietaryNotes ? `<div style="color: #64748b; font-size: 10px;">${d.dietaryNotes}</div>` : ''}
        </div>
        <span style="color: ${confirmed ? '#4ade80' : '#fbbf24'}; font-size: 10px; font-weight: 600;">
          ${confirmed ? 'CONFIRMED' : 'PENDING'}
        </span>
      </div>
    `;
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. Register views with sample data
//
// sampleData is a single object per entity type — it matches the JSON
// Schema from the registry and is shared across all views. The View
// Gallery (/views) renders every view with this same data.
// ═══════════════════════════════════════════════════════════════

export default defineViews({
  nodes: {
    tour: {
      views: [TourCard, TourDetail],
      sampleData: {
        name: 'Dolomites Classic',
        difficulty: 'hard',
        maxRiders: 30,
        description: 'A challenging multi-day cycling tour through the Italian Dolomites.',
      },
    },
    departure: {
      views: [DepartureBadge],
      sampleData: {
        date: '2025-07-15',
        maxSpots: 20,
        priceUsd: 2499,
      },
    },
  },
  edges: {
    hasDeparture: {
      views: [HasDepartureTimeline],
      sampleData: {
        scheduledDate: '2025-07-15',
        status: 'confirmed',
        notes: 'Weather looks great, all guides confirmed.',
      },
    },
    hasRider: {
      views: [HasRiderCard],
      sampleData: {
        seatNumber: 7,
        confirmed: true,
        dietaryNotes: 'Vegetarian',
      },
    },
  },
});
