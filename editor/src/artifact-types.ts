/**
 * Artifact type definitions for chat tool results.
 * Shared between server (chat.ts) and client (chat-client.ts, ChatPanel, ChatBar, artifact-views).
 */

export type ArtifactKind =
  | 'node-detail'
  | 'nodes-list'
  | 'edges-list'
  | 'traverse'
  | 'search'
  | 'schema'
  | 'unknown';

export interface ChatArtifact {
  id: string;
  kind: ArtifactKind;
  command: string;
  timestamp: string;
  data: unknown;
}
