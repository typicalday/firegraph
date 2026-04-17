/**
 * Dynamic registry loader — reads meta-nodes from Firestore
 * and extracts RegistryEntry[] + view template metadata.
 */
import type { Firestore } from '@google-cloud/firestore';

import { META_EDGE_TYPE, META_NODE_TYPE } from '../../src/dynamic-registry.js';
import { createGraphClient } from '../../src/index.js';
import { NODE_RELATION } from '../../src/internal/constants.js';
import type { EdgeTypeData, NodeTypeData, QueryMode, RegistryEntry } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DynamicTypeViewMeta {
  viewTemplate?: string;
  viewCss?: string;
}

export interface DynamicTypeMetadata {
  nodes: Record<string, DynamicTypeViewMeta>;
  edges: Record<string, DynamicTypeViewMeta>;
}

export interface DynamicLoadResult {
  /** Registry entries to merge with static entries. */
  entries: RegistryEntry[];
  /** View template metadata keyed by type name. */
  dynamicTypeMeta: DynamicTypeMetadata;
  /** Node type names from dynamic registry. */
  dynamicNodeNames: string[];
  /** Edge type names from dynamic registry. */
  dynamicEdgeNames: string[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Read all nodeType and edgeType meta-nodes from Firestore and
 * convert them to RegistryEntry[] + view template metadata.
 */
export async function loadDynamicTypes(
  db: Firestore,
  metaCollection: string,
  queryMode?: QueryMode,
): Promise<DynamicLoadResult> {
  // Create a lightweight reader for the meta-collection
  const metaReader = createGraphClient(db, metaCollection, { queryMode });

  const [nodeTypeDocs, edgeTypeDocs] = await Promise.all([
    metaReader.findNodes({ aType: META_NODE_TYPE }),
    metaReader.findNodes({ aType: META_EDGE_TYPE }),
  ]);

  const entries: RegistryEntry[] = [];
  const dynamicTypeMeta: DynamicTypeMetadata = { nodes: {}, edges: {} };
  const dynamicNodeNames: string[] = [];
  const dynamicEdgeNames: string[] = [];

  // Process nodeType meta-nodes
  for (const record of nodeTypeDocs) {
    const data = record.data as unknown as NodeTypeData;

    dynamicNodeNames.push(data.name);

    entries.push({
      aType: data.name,
      axbType: NODE_RELATION,
      bType: data.name,
      jsonSchema: data.jsonSchema,
      description: data.description,
      titleField: data.titleField,
      subtitleField: data.subtitleField,
    });

    if (data.viewTemplate || data.viewCss) {
      dynamicTypeMeta.nodes[data.name] = {
        viewTemplate: data.viewTemplate,
        viewCss: data.viewCss,
      };
    }
  }

  // Process edgeType meta-nodes
  for (const record of edgeTypeDocs) {
    const data = record.data as unknown as EdgeTypeData;
    const fromTypes = Array.isArray(data.from) ? data.from : [data.from];
    const toTypes = Array.isArray(data.to) ? data.to : [data.to];

    dynamicEdgeNames.push(data.name);

    for (const aType of fromTypes) {
      for (const bType of toTypes) {
        entries.push({
          aType,
          axbType: data.name,
          bType,
          jsonSchema: data.jsonSchema,
          description: data.description,
          inverseLabel: data.inverseLabel,
          titleField: data.titleField,
          subtitleField: data.subtitleField,
        });
      }
    }

    if (data.viewTemplate || data.viewCss) {
      dynamicTypeMeta.edges[data.name] = {
        viewTemplate: data.viewTemplate,
        viewCss: data.viewCss,
      };
    }
  }

  return { entries, dynamicTypeMeta, dynamicNodeNames, dynamicEdgeNames };
}
