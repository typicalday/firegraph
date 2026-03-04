import type { FocusContextValue } from './focus-context';
import type { Schema } from '../types';

/**
 * Build a context payload for a chat request.
 * Gathers the current focused node, schema metadata, and edge summaries.
 */
export function buildChatContext(
  focus: FocusContextValue | null,
  schema: Schema,
): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};

  // Focused node
  if (focus?.focused) {
    ctx.focusedNode = {
      uid: focus.focused.uid,
      nodeType: focus.focused.nodeType,
    };

    // Schema for the focused node type
    const nodeSchema = schema.nodeSchemas?.find(
      (s) => s.aType === focus.focused!.nodeType && s.isNodeEntry,
    );
    if (nodeSchema) {
      ctx.nodeSchema = {
        type: nodeSchema.aType,
        description: nodeSchema.description,
        fields: nodeSchema.fields.map((f) => ({
          name: f.name,
          type: f.type,
          required: f.required,
          description: f.description,
          enumValues: f.enumValues,
        })),
      };
    }

    // Summarize outgoing edges
    if (focus.edgeResults.out.edges.length > 0) {
      const groups: Record<string, { targetType: string; count: number }> = {};
      for (const edge of focus.edgeResults.out.edges) {
        const key = edge.axbType;
        if (!groups[key]) {
          groups[key] = { targetType: edge.bType, count: 0 };
        }
        groups[key].count++;
      }
      ctx.outgoingEdges = Object.entries(groups).map(([axbType, g]) => ({
        axbType,
        targetType: g.targetType,
        count: g.count,
        hasMore: focus.edgeResults.out.hasMore,
      }));
    }

    // Summarize incoming edges
    if (focus.edgeResults.in.edges.length > 0) {
      const groups: Record<string, { sourceType: string; count: number }> = {};
      for (const edge of focus.edgeResults.in.edges) {
        const key = edge.axbType;
        if (!groups[key]) {
          groups[key] = { sourceType: edge.aType, count: 0 };
        }
        groups[key].count++;
      }
      ctx.incomingEdges = Object.entries(groups).map(([axbType, g]) => ({
        axbType,
        sourceType: g.sourceType,
        count: g.count,
        hasMore: focus.edgeResults.in.hasMore,
      }));
    }
  }

  // Graph topology (always included — lightweight)
  ctx.graphTopology = schema.edgeTypes.map((et) => ({
    aType: et.aType,
    axbType: et.axbType,
    bType: et.bType,
    inverseLabel: et.inverseLabel,
  }));

  return ctx;
}
