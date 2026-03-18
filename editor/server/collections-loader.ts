/**
 * Discovery loader for plain Firestore collections registered via
 * entities/collections/{name}/ folder convention.
 *
 * Each collection folder contains:
 *   collection.json  (required) — path template, type discriminator, orderBy
 *   schema.json      (optional) — JSON Schema for document data → FieldMeta[]
 */

import path from 'path';
import fs from 'fs';
import { jsonSchemaToFieldMeta } from '../../src/json-schema.js';
import type { FieldMeta } from '../../src/json-schema.js';
import type { EntityViewMeta, ViewMeta } from '../../src/views.js';
import { loadViewClasses, sanitizeTagPart } from './entities-loader.js';

export type { FieldMeta };

export interface DiscoveredCollection {
  name: string;
  /** Raw path template, e.g. "graph/{nodeUid}/logs" */
  path: string;
  description?: string;
  /** Field name used for type discrimination (e.g. "kind") */
  typeField?: string;
  /** Value for typeField to filter/set (e.g. "audit") */
  typeValue?: string | number | boolean;
  /** When set, show this collection in NodeDetail for matching node type */
  parentNodeType?: string;
  fields: FieldMeta[];
  hasSchema: boolean;
  /** Extracted {paramName} tokens from the path template */
  pathParams: string[];
  defaultOrderBy?: { field: string; direction: 'asc' | 'desc' };
  /** Absolute path to views.ts if present */
  viewsPath?: string;
  /** Sample document data from sample.json for View Gallery */
  sampleData?: Record<string, unknown>;
}

interface CollectionJson {
  path: string;
  description?: string;
  typeField?: string;
  typeValue?: string | number | boolean;
  parentNodeType?: string;
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
}

function extractPathParams(pathTemplate: string): string[] {
  const params: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pathTemplate)) !== null) {
    params.push(m[1]);
  }
  return params;
}

export function discoverCollections(entitiesDir: string): DiscoveredCollection[] {
  const collectionsDir = path.join(entitiesDir, 'collections');
  if (!fs.existsSync(collectionsDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(collectionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: DiscoveredCollection[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const name = entry.name;
    const dir = path.join(collectionsDir, name);

    // collection.json is required
    const collectionJsonPath = path.join(dir, 'collection.json');
    if (!fs.existsSync(collectionJsonPath)) continue;

    let collectionJson: CollectionJson;
    try {
      const raw = fs.readFileSync(collectionJsonPath, 'utf-8');
      collectionJson = JSON.parse(raw) as CollectionJson;
    } catch (err) {
      console.warn(`[firegraph] Skipping collection "${name}": invalid collection.json — ${(err as Error).message}`);
      continue;
    }

    if (!collectionJson.path || typeof collectionJson.path !== 'string') continue;

    // schema.json is optional
    let fields: FieldMeta[] = [];
    let hasSchema = false;
    const schemaJsonPath = path.join(dir, 'schema.json');
    if (fs.existsSync(schemaJsonPath)) {
      try {
        const raw = fs.readFileSync(schemaJsonPath, 'utf-8');
        const schema = JSON.parse(raw);
        fields = jsonSchemaToFieldMeta(schema);
        hasSchema = true;
      } catch {
        // ignore schema parse errors — fall back to raw JSON display
      }
    }

    const pathParams = extractPathParams(collectionJson.path);

    const defaultOrderBy = collectionJson.orderBy
      ? {
          field: collectionJson.orderBy.field,
          direction: (collectionJson.orderBy.direction ?? 'asc') as 'asc' | 'desc',
        }
      : undefined;

    // views.ts is optional (sync detection only — classes loaded by buildCollectionViewRegistry)
    let viewsPath: string | undefined;
    for (const ext of ['ts', 'js', 'mts', 'mjs']) {
      const candidate = path.join(dir, `views.${ext}`);
      if (fs.existsSync(candidate)) { viewsPath = candidate; break; }
    }

    // sample.json is optional
    let sampleData: Record<string, unknown> | undefined;
    const sampleJsonPath = path.join(dir, 'sample.json');
    if (fs.existsSync(sampleJsonPath)) {
      try {
        sampleData = JSON.parse(fs.readFileSync(sampleJsonPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        // ignore parse errors
      }
    }

    results.push({
      name,
      path: collectionJson.path,
      description: collectionJson.description,
      typeField: collectionJson.typeField,
      typeValue: collectionJson.typeValue,
      parentNodeType: collectionJson.parentNodeType,
      fields,
      hasSchema,
      pathParams,
      defaultOrderBy,
      viewsPath,
      sampleData,
    });
  }

  return results;
}

/**
 * Async phase: load view classes from each collection's views.ts and build
 * the view registry used by the editor's ViewSwitcher.
 */
export async function buildCollectionViewRegistry(
  collections: DiscoveredCollection[],
): Promise<Record<string, EntityViewMeta>> {
  const result: Record<string, EntityViewMeta> = {};
  for (const col of collections) {
    if (!col.viewsPath) continue;
    try {
      const viewClasses = await loadViewClasses(col.viewsPath);
      if (viewClasses.length === 0) continue;
      const views: ViewMeta[] = viewClasses.map((vc) => ({
        tagName: `fg-col-${sanitizeTagPart(col.name)}-${sanitizeTagPart(vc.viewName)}`,
        viewName: vc.viewName,
        description: vc.description,
      }));
      result[col.name] = { views, sampleData: col.sampleData };
    } catch (err) {
      console.warn(`[firegraph] Failed to load views for collection "${col.name}": ${(err as Error).message}`);
    }
  }
  return result;
}
