import { describe, expect, it } from 'vitest';

import { substitutePathTemplate } from '../../editor/server/trpc.js';

describe('substitutePathTemplate', () => {
  it('substitutes a single parameter', () => {
    expect(substitutePathTemplate('graph/{nodeUid}/logs', { nodeUid: 'abc123' })).toBe(
      'graph/abc123/logs',
    );
  });

  it('substitutes multiple parameters', () => {
    expect(
      substitutePathTemplate('{tenantId}/graph/{nodeUid}/logs', {
        tenantId: 'acme',
        nodeUid: 'abc123',
      }),
    ).toBe('acme/graph/abc123/logs');
  });

  it('returns the template unchanged when there are no params', () => {
    expect(substitutePathTemplate('events', {})).toBe('events');
  });

  it('throws when a required parameter is missing', () => {
    expect(() => substitutePathTemplate('graph/{nodeUid}/logs', {})).toThrow(
      'Missing required path parameter: "nodeUid"',
    );
  });

  it('throws when a parameter value contains a slash', () => {
    expect(() => substitutePathTemplate('graph/{nodeUid}/logs', { nodeUid: 'a/b' })).toThrow(
      'Path parameter "nodeUid" must not contain "/"',
    );
  });

  it('throws when a parameter value is an empty string', () => {
    expect(() => substitutePathTemplate('graph/{nodeUid}/logs', { nodeUid: '' })).toThrow(
      'Path parameter "nodeUid" must not be empty',
    );
  });
});
