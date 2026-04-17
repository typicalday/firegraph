import path from 'path';
import { describe, expect, it } from 'vitest';

import {
  buildCollectionViewRegistry,
  discoverCollections,
} from '../../editor/server/collections-loader.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const ENTITIES_DIR = path.join(FIXTURES, 'entities');

describe('discoverCollections', () => {
  it('discovers collections from the fixture directory', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const names = cols.map((c) => c.name);
    expect(names).toContain('auditLogs');
    expect(names).toContain('events');
  });

  it('skips directories without collection.json', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const names = cols.map((c) => c.name);
    // 'noJson' has only schema.json — should be absent
    expect(names).not.toContain('noJson');
  });

  it('silently skips directories with invalid collection.json', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const names = cols.map((c) => c.name);
    // 'badJson' has malformed JSON — should be skipped, not throw
    expect(names).not.toContain('badJson');
  });

  it('parses all fields from collection.json', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const auditLogs = cols.find((c) => c.name === 'auditLogs')!;
    expect(auditLogs.path).toBe('graph/{nodeUid}/auditLogs');
    expect(auditLogs.description).toBe('Audit log entries for a node');
    expect(auditLogs.typeField).toBe('kind');
    expect(auditLogs.typeValue).toBe('audit');
    expect(auditLogs.parentNodeType).toBe('tour');
  });

  it('extracts path params from the path template', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const auditLogs = cols.find((c) => c.name === 'auditLogs')!;
    expect(auditLogs.pathParams).toEqual(['nodeUid']);
  });

  it('extracts no path params when path has no placeholders', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const events = cols.find((c) => c.name === 'events')!;
    expect(events.pathParams).toEqual([]);
  });

  it('parses defaultOrderBy with explicit direction', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const auditLogs = cols.find((c) => c.name === 'auditLogs')!;
    expect(auditLogs.defaultOrderBy).toEqual({ field: 'createdAt', direction: 'desc' });
  });

  it('defaults orderBy direction to asc when omitted', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const col = cols.find((c) => c.name === 'orderByDefault')!;
    expect(col.defaultOrderBy).toEqual({ field: 'ts', direction: 'asc' });
  });

  it('parses schema.json into FieldMeta when present', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const auditLogs = cols.find((c) => c.name === 'auditLogs')!;
    expect(auditLogs.hasSchema).toBe(true);
    const actionField = auditLogs.fields.find((f) => f.name === 'action');
    expect(actionField).toBeDefined();
    expect(actionField!.type).toBe('string');
    expect(actionField!.required).toBe(true);
  });

  it('reads sample.json when present', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const auditLogs = cols.find((c) => c.name === 'auditLogs')!;
    expect(auditLogs.sampleData).toEqual({
      action: 'update',
      createdAt: '2024-01-01T00:00:00Z',
      userId: 'user-123',
    });
  });

  it('sets viewsPath when views.ts is present', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const auditLogs = cols.find((c) => c.name === 'auditLogs')!;
    expect(auditLogs.viewsPath).toBeDefined();
    expect(auditLogs.viewsPath).toMatch(/views\.ts$/);
  });

  it('handles minimal collection with no optional files', () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const events = cols.find((c) => c.name === 'events')!;
    expect(events.path).toBe('events');
    expect(events.hasSchema).toBe(false);
    expect(events.fields).toEqual([]);
    expect(events.sampleData).toBeUndefined();
    expect(events.description).toBeUndefined();
    expect(events.typeField).toBeUndefined();
    expect(events.typeValue).toBeUndefined();
    expect(events.parentNodeType).toBeUndefined();
    expect(events.defaultOrderBy).toBeUndefined();
    expect(events.viewsPath).toBeUndefined();
  });

  it('returns empty array when no collections directory exists', () => {
    // entities-ts-schema has no collections/ subdirectory
    const cols = discoverCollections(path.join(FIXTURES, 'entities-ts-schema'));
    expect(cols).toEqual([]);
  });
});

describe('buildCollectionViewRegistry', () => {
  it('skips collections without viewsPath', async () => {
    const cols = discoverCollections(ENTITIES_DIR).filter((c) => !c.viewsPath);
    const result = await buildCollectionViewRegistry(cols);
    expect(result).toEqual({});
  });

  it('loads view classes and builds registry for collections with viewsPath', async () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const result = await buildCollectionViewRegistry(cols);
    expect(result).toHaveProperty('auditLogs');
    const meta = result['auditLogs'];
    expect(meta.views).toHaveLength(1);
    expect(meta.views[0].viewName).toBe('row');
    expect(meta.views[0].tagName).toBe('fg-col-auditlogs-row');
    expect(meta.views[0].description).toBe('Single-line audit log entry');
  });

  it('includes sampleData in the registry entry', async () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const result = await buildCollectionViewRegistry(cols);
    expect(result['auditLogs'].sampleData).toEqual({
      action: 'update',
      createdAt: '2024-01-01T00:00:00Z',
      userId: 'user-123',
    });
  });

  it('does not include collections without views in the result', async () => {
    const cols = discoverCollections(ENTITIES_DIR);
    const result = await buildCollectionViewRegistry(cols);
    // 'events' has no views.ts
    expect(result).not.toHaveProperty('events');
  });
});
