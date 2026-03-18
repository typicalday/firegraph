class AuditLogRow extends HTMLElement {
  static viewName = 'row';
  static description = 'Single-line audit log entry';
  private _data: Record<string, unknown> = {};
  set data(v: Record<string, unknown>) { this._data = v; }
  get data() { return this._data; }
}

export default [AuditLogRow];
