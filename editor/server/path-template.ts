/**
 * Substitute {paramName} tokens in a collection path template.
 * e.g. "graph/{nodeUid}/logs" + {nodeUid: "abc"} → "graph/abc/logs"
 */
export function substitutePathTemplate(
  template: string,
  params: Record<string, string> = {},
): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    if (!(key in params)) {
      throw new Error(`Missing required path parameter: "${key}"`);
    }
    const val = params[key];
    if (!val) {
      throw new Error(`Path parameter "${key}" must not be empty`);
    }
    if (val.includes('/')) {
      throw new Error(`Path parameter "${key}" must not contain "/"`);
    }
    return val;
  });
}
