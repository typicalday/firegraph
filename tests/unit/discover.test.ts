import path from 'path';
import { describe, expect, it } from 'vitest';

import { discoverEntities, DiscoveryError } from '../../src/discover.js';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');

describe('discoverEntities', () => {
  it('discovers nodes from the fixture directory', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    expect(result.nodes.size).toBe(2);
    expect(result.nodes.has('tour')).toBe(true);
    expect(result.nodes.has('departure')).toBe(true);
  });

  it('discovers edges from the fixture directory', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    expect(result.edges.size).toBe(1);
    expect(result.edges.has('hasDeparture')).toBe(true);
  });

  it('parses node schemas correctly', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    const tour = result.nodes.get('tour')!;
    expect(tour.kind).toBe('node');
    expect(tour.name).toBe('tour');
    expect(tour.schema).toHaveProperty('properties');
  });

  it('parses edge topology correctly', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    const edge = result.edges.get('hasDeparture')!;
    expect(edge.topology).toEqual({
      from: 'tour',
      to: 'departure',
      inverseLabel: 'departureOf',
    });
  });

  it('reads meta.json description and viewDefaults', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    const tour = result.nodes.get('tour')!;
    expect(tour.description).toBe('A cycling tour');
    expect(tour.viewDefaults).toEqual({ default: 'card', detail: 'detail' });
  });

  it('reads sample.json', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    const tour = result.nodes.get('tour')!;
    expect(tour.sampleData).toEqual({
      name: 'Dolomites Classic',
      difficulty: 'hard',
      maxRiders: 30,
    });
  });

  it('returns null for optional files not present', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities'));
    const departure = result.nodes.get('departure')!;
    expect(departure.description).toBeUndefined();
    expect(departure.viewDefaults).toBeUndefined();
    expect(departure.sampleData).toBeUndefined();
    expect(departure.viewsPath).toBeUndefined();
  });

  it('throws DiscoveryError for missing entities directory', () => {
    expect(() => discoverEntities('/nonexistent/path')).toThrow(DiscoveryError);
  });

  it('throws DiscoveryError when edge is missing edge.json', () => {
    expect(() => discoverEntities(path.join(FIXTURES, 'entities-bad-edge'))).toThrow(
      /Missing edge\.json/,
    );
  });

  it('warns about dangling topology references', () => {
    // The good fixture has matching nodes — no warnings expected
    const { warnings: goodWarnings } = discoverEntities(path.join(FIXTURES, 'entities'));
    expect(goodWarnings).toHaveLength(0);

    // The entities-bad-edge fixture has an edge but no nodes dir,
    // so all topology references are dangling. But it fails on missing edge.json.
    // Instead, test with the entities-dangling fixture.
    const { warnings } = discoverEntities(path.join(FIXTURES, 'entities-dangling'));
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0].code).toBe('DANGLING_TOPOLOGY_REF');
  });

  it('handles empty directories gracefully', () => {
    // An entities dir with no nodes/ or edges/ subdirs should return empty maps
    const { result } = discoverEntities(FIXTURES);
    expect(result.nodes.size).toBe(0);
    expect(result.edges.size).toBe(0);
  });

  it('loads schema.ts files via jiti', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities-ts-schema'));
    expect(result.nodes.has('event')).toBe(true);
    const event = result.nodes.get('event')!;
    expect(event.schema).toHaveProperty('properties');
    expect((event.schema as any).properties.title).toEqual({
      type: 'string',
      minLength: 1,
    });
  });

  it('resolves shared imports across schema.ts files', () => {
    const { result } = discoverEntities(path.join(FIXTURES, 'entities-ts-schema'));
    const event = result.nodes.get('event')!;
    const workshop = result.nodes.get('workshop')!;

    // Both schemas should reference the same shared address shape
    const eventLocation = (event.schema as any).properties.location;
    const workshopVenue = (workshop.schema as any).properties.venue;
    expect(eventLocation).toEqual(workshopVenue);
    expect(eventLocation.properties.country).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 2,
    });
  });
});
