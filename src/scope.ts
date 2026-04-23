/**
 * Scope path matching for subgraph-level registry constraints.
 *
 * Scope paths are slash-separated names derived from the chain of
 * `subgraph()` calls (e.g., `'agents'`, `'agents/memories'`).
 * The root graph has an empty scope path (`''`).
 *
 * Patterns:
 *   - `'root'`              — matches only the root graph (empty scope path)
 *   - `'agents'`            — matches exactly `'agents'`
 *   - `'agents/memories'`   — matches exactly `'agents/memories'`
 *   - `'*​/agents'`          — `*` matches one segment: `'foo/agents'` but not `'a/b/agents'`
 *   - `'**​/memories'`       — `**` matches zero or more segments
 *   - `'**'`                — matches everything including root
 */

/**
 * Test whether a scope path matches a single pattern.
 *
 * @param scopePath - The current scope path (empty string for root)
 * @param pattern - The pattern to match against
 */
export function matchScope(scopePath: string, pattern: string): boolean {
  // Special case: 'root' matches only the root graph
  if (pattern === 'root') return scopePath === '';

  // Special case: '**' matches everything
  if (pattern === '**') return true;

  const pathSegments = scopePath === '' ? [] : scopePath.split('/');
  const patternSegments = pattern.split('/');

  return matchSegments(pathSegments, 0, patternSegments, 0);
}

/**
 * Test whether a scope path matches any pattern in a list.
 * Returns `true` if the list is empty or undefined (allowed everywhere).
 *
 * @param scopePath - The current scope path (empty string for root)
 * @param patterns - Array of patterns to match against
 */
export function matchScopeAny(scopePath: string, patterns: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => matchScope(scopePath, p));
}

/**
 * Recursive segment matcher with support for `*` (one segment) and
 * `**` (zero or more segments).
 */
function matchSegments(path: string[], pi: number, pattern: string[], qi: number): boolean {
  // Both exhausted — match
  if (pi === path.length && qi === pattern.length) return true;

  // Pattern exhausted but path remains — no match
  if (qi === pattern.length) return false;

  const seg = pattern[qi];

  if (seg === '**') {
    // '**' at the end of pattern — matches everything remaining
    if (qi === pattern.length - 1) return true;

    // Try consuming 0, 1, 2, ... path segments
    for (let skip = 0; skip <= path.length - pi; skip++) {
      if (matchSegments(path, pi + skip, pattern, qi + 1)) return true;
    }
    return false;
  }

  // Path exhausted but pattern has non-** segments remaining — no match
  if (pi === path.length) return false;

  if (seg === '*') {
    // '*' matches exactly one segment
    return matchSegments(path, pi + 1, pattern, qi + 1);
  }

  // Literal match
  if (path[pi] === seg) {
    return matchSegments(path, pi + 1, pattern, qi + 1);
  }

  return false;
}
