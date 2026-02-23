/**
 * Per-entity views for the `tour` node type.
 *
 * Each per-entity views.ts must `export default` an array of view classes.
 * Each class extends HTMLElement and has a static `viewName`.
 */

const difficultyColors: Record<string, string> = {
  easy: '#22c55e',
  medium: '#eab308',
  hard: '#ef4444',
};

class TourCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Compact tour overview card';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; this.render(); }
  get data() { return this._data; }
  connectedCallback() { this.render(); }
  private render() {
    const d = this._data;
    const color = difficultyColors[d.difficulty as string] ?? '#94a3b8';
    this.innerHTML = `
      <div style="padding:14px 16px;border-radius:10px;background:#1e293b;border:1px solid #334155;font-family:system-ui,sans-serif;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <strong style="color:#e2e8f0;font-size:14px;">${d.name ?? 'Unnamed Tour'}</strong>
          <span style="padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:${color}20;color:${color};border:1px solid ${color}40;">${d.difficulty ?? '—'}</span>
        </div>
        <div style="color:#94a3b8;font-size:12px;">Max riders: <span style="color:#e2e8f0;">${d.maxRiders ?? '—'}</span></div>
      </div>
    `;
  }
}

class TourRow extends HTMLElement {
  static viewName = 'row';
  static description = 'Compact listing row';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; this.render(); }
  get data() { return this._data; }
  connectedCallback() { this.render(); }
  private render() {
    const d = this._data;
    const color = difficultyColors[d.difficulty as string] ?? '#94a3b8';
    this.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;font-family:system-ui,sans-serif;padding:2px 0;">
        <span style="padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600;background:${color}20;color:${color};border:1px solid ${color}40;">${d.difficulty ?? '—'}</span>
        <span style="color:#e2e8f0;font-size:13px;font-weight:500;">${d.name ?? 'Unnamed Tour'}</span>
        <span style="color:#64748b;font-size:12px;margin-left:auto;">${d.maxRiders ?? '?'} riders</span>
      </div>
    `;
  }
}

// The default export MUST be an array of view classes.
// This is how the editor discovers and registers views.
export default [TourCard, TourRow];
