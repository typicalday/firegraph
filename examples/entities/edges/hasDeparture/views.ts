/**
 * Per-entity views for the `hasDeparture` edge type.
 *
 * Edge views work the same as node views — export default an array of classes.
 */

class HasDepartureCard extends HTMLElement {
  static viewName = 'card';
  static description = 'Departure ordering badge';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) {
    this._data = v;
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
    const order = typeof d.order === 'number' ? String(d.order) : '?';
    this.innerHTML = `
      <div style="padding:14px 16px;border-radius:10px;background:#1e293b;border:1px solid #334155;font-family:system-ui,sans-serif;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;background:#334155;color:#e2e8f0;font-size:13px;font-weight:700;">${order}</span>
          <div>
            <div style="color:#e2e8f0;font-size:13px;font-weight:500;">Departure #${order}</div>
            <div style="color:#64748b;font-size:11px;">Departure order within the tour</div>
          </div>
        </div>
      </div>
    `;
  }
}

export default [HasDepartureCard];
