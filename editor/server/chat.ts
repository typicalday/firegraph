/**
 * Chat module — spawns `claude -p` subprocesses to answer graph queries.
 *
 * Auto-detects the `claude` CLI on PATH at startup.
 * Each browser request spawns a short-lived process; multi-turn
 * conversations are maintained via `--resume <session_id>`.
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { Express, Request, Response } from 'express';
import type { SchemaMetadata } from './schema-introspect.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatDeps {
  schemaMetadata: SchemaMetadata;
  model: string;
  maxConcurrency: number;
}

interface ToolCallState {
  id: string;
  name: string;
  inputChunks: string[];
}

interface ActiveProcess {
  proc: ChildProcess;
  sseConnections: Set<Response>;
  timeout: ReturnType<typeof setTimeout>;
  buffer: string;
  resultJson: string;
  /** Tracks tool_use blocks being streamed (keyed by content_block index). */
  activeToolCalls: Map<number, ToolCallState>;
  /** Maps tool_use_id → parsed command string, waiting for tool_result. */
  pendingCommands: Map<string, string>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const activeProcesses = new Map<string, ActiveProcess>();
let activeCount = 0;

// ---------------------------------------------------------------------------
// Claude Detection
// ---------------------------------------------------------------------------

export function detectClaude(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

let systemPromptPath: string | null = null;

function ensureSystemPrompt(schemaMetadata: SchemaMetadata): string {
  if (systemPromptPath) return systemPromptPath;

  const dir = join(tmpdir(), 'firegraph-editor-chat');
  mkdirSync(dir, { recursive: true });
  systemPromptPath = join(dir, 'system-prompt.txt');

  const nodeTypes = schemaMetadata.nodeTypes.map((n) => n.aType).join(', ');
  const edgeTypes = schemaMetadata.edgeTypes
    .map((e) => `${e.aType} -[${e.axbType}]-> ${e.bType}`)
    .join('\n  ');

  const prompt = `You are a graph data assistant for a firegraph application. You can query the graph database to answer questions about nodes, edges, relationships, and data.

## Query Tool

Run queries using:
  npx firegraph query <command>

Available commands:

  schema                        — List all node and edge types
  get <uid>                     — Get a node with all its outgoing and incoming edges
  find-nodes <type> [--limit N] — Find nodes by type
  find-edges [--aUid x] [--axbType y] [--bUid z] [--aType x] [--bType y] [--limit N]
  search <text>                 — Search nodes by UID or field values
  traverse '<JSON>'             — Multi-hop graph traversal (most powerful query)

### Traverse API

  npx firegraph query traverse '{
    "startUid": "nodeUid",
    "hops": [
      {
        "axbType": "relationName",
        "direction": "forward|reverse",
        "limit": 10,
        "aType": "filterSourceType",
        "bType": "filterTargetType",
        "orderBy": { "field": "data.fieldName", "direction": "asc|desc" },
        "where": [{ "field": "data.status", "op": "==", "value": "active" }]
      }
    ],
    "maxReads": 100,
    "concurrency": 5
  }'

## Graph Schema

Node types: ${nodeTypes}

Edge types:
  ${edgeTypes}

## Instructions

1. Read the user's question and context carefully.
2. Use the query tool to look up data when needed.
3. Use \`traverse\` for relationship questions — it's the most powerful tool. Chain multiple hops to follow connections. Use \`direction: "reverse"\` for incoming edges.
4. Use \`get\` to inspect a specific node and see all its connections.
5. Use \`find-nodes\` and \`find-edges\` for simple lookups.
6. You may run multiple queries to build a complete answer.

## Response Style

Tool results are automatically displayed to the user as interactive, clickable artifact cards in the UI. The user can click on them to view the full data, expand nodes, navigate to detail pages, etc.

Because of this, **do NOT repeat or dump raw query results in your text response**. Instead:
- Give a brief, conversational summary of what you found (e.g. "Found 12 tasks, 8 are active" or "That node has 3 outgoing edges to departures").
- Highlight key insights, patterns, or anything noteworthy.
- If the user asked a yes/no or specific question, answer it directly.
- Only include specific data values in your text when they directly answer the question.

Keep your text responses concise — the artifacts handle the data display.
`;

  writeFileSync(systemPromptPath, prompt, 'utf-8');
  return systemPromptPath;
}

// ---------------------------------------------------------------------------
// ID Generation
// ---------------------------------------------------------------------------

function generateId(): string {
  return randomBytes(12).toString('hex');
}

// ---------------------------------------------------------------------------
// SSE Helpers
// ---------------------------------------------------------------------------

function writeSse(res: Response, event: string, data: unknown): boolean {
  if (res.destroyed || res.writableEnded) return false;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.write(`event: ${event}\ndata: ${payload}\n\n`);
  return true;
}

function broadcastSse(requestId: string, event: string, data: unknown) {
  const active = activeProcesses.get(requestId);
  if (!active) return;
  for (const res of active.sseConnections) {
    writeSse(res, event, data);
  }
}

// ---------------------------------------------------------------------------
// Subprocess Spawn
// ---------------------------------------------------------------------------

function spawnChat(
  requestId: string,
  prompt: string,
  deps: ChatDeps,
  claudeSessionId?: string,
): void {
  const systemPromptFile = ensureSystemPrompt(deps.schemaMetadata);

  const args = [
    '-p', prompt,
    '--model', deps.model,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--append-system-prompt-file', systemPromptFile,
    '--allowedTools', 'Bash(npx firegraph query *)',
    '--dangerously-skip-permissions',
    '--max-turns', '15',
  ];

  // Resume existing session for multi-turn
  if (claudeSessionId) {
    args.push('--resume', claudeSessionId);
  }

  const proc = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const active: ActiveProcess = {
    proc,
    sseConnections: new Set(),
    timeout: setTimeout(() => {
      proc.kill('SIGTERM');
      broadcastSse(requestId, 'error', { message: 'Request timed out (120s)' });
      cleanup(requestId);
    }, 120_000),
    buffer: '',
    resultJson: '',
    activeToolCalls: new Map(),
    pendingCommands: new Map(),
  };

  activeProcesses.set(requestId, active);
  activeCount++;

  // Parse NDJSON from stdout
  //
  // Event sequence from `claude -p --output-format stream-json --verbose --include-partial-messages`:
  //
  // Text response:
  //   1. type:"system" subtype:"init"  → session_id
  //   2. type:"stream_event" content_block_start  (type:"text")
  //   3. type:"stream_event" content_block_delta   → delta.type:"text_delta", delta.text
  //   4. type:"assistant" → complete message (skip text to avoid duplication)
  //   5. type:"stream_event" content_block_stop / message_stop
  //   6. type:"result"  → session_id, cost, usage
  //
  // Tool call:
  //   1. type:"stream_event" content_block_start  (type:"tool_use", name, id)
  //   2. type:"stream_event" content_block_delta   → delta.type:"input_json_delta"
  //   3. type:"assistant" → complete message with tool_use content blocks
  //   4. type:"user" → message.content[{type:"tool_result", tool_use_id, content}]
  //                     + tool_use_result.stdout (raw tool output)
  //   5. Then the next assistant turn with text response
  //
  proc.stdout!.on('data', (chunk: Buffer) => {
    active.buffer += chunk.toString();
    const lines = active.buffer.split('\n');
    active.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);

        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          broadcastSse(requestId, 'session', { sessionId: event.session_id });

        } else if (event.type === 'stream_event') {
          const se = event.event;
          if (!se) continue;

          if (se.type === 'content_block_start' && se.content_block?.type === 'tool_use') {
            // Tool call starting — track it by content block index
            const idx = se.index as number;
            active.activeToolCalls.set(idx, {
              id: se.content_block.id as string,
              name: se.content_block.name as string,
              inputChunks: [],
            });

          } else if (se.type === 'content_block_delta') {
            if (se.delta?.type === 'text_delta' && se.delta?.text) {
              // Incremental text — stream to browser
              broadcastSse(requestId, 'chunk', { text: se.delta.text });

            } else if (se.delta?.type === 'input_json_delta') {
              // Tool input streaming — accumulate
              const tc = active.activeToolCalls.get(se.index as number);
              if (tc) tc.inputChunks.push(se.delta.partial_json ?? '');
            }

          } else if (se.type === 'content_block_stop') {
            // If this was a tool call, finalize input and extract command
            const tc = active.activeToolCalls.get(se.index as number);
            if (tc) {
              try {
                const input = JSON.parse(tc.inputChunks.join(''));
                const command = (input as { command?: string }).command ?? '';
                if (isFiregraphQuery(command)) {
                  active.pendingCommands.set(tc.id, command);
                  broadcastSse(requestId, 'tool_start', { command });
                }
              } catch {
                // Input JSON parse failed — ignore
              }
              active.activeToolCalls.delete(se.index as number);
            }
          }
          // message_start, message_delta, message_stop — no action needed

        } else if (event.type === 'user') {
          // Tool result — contains the output of the tool execution
          const content = event.message?.content as { type: string; tool_use_id: string; content: string; is_error: boolean }[] | undefined;
          if (!content) continue;

          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const command = active.pendingCommands.get(block.tool_use_id);
            if (!command) continue;
            active.pendingCommands.delete(block.tool_use_id);

            // The raw stdout is in tool_use_result.stdout or block.content
            const rawOutput = (event.tool_use_result?.stdout as string) ?? block.content ?? '';
            const artifact = parseToolResult(command, rawOutput);
            if (artifact) {
              broadcastSse(requestId, 'artifact', artifact);
            }
          }

        }
        // type:"assistant" → skip (text already streamed via deltas, tool_use captured via stream events)
        // type:"result" → skip (we use process close event instead)
      } catch {
        // Not JSON or unknown format — skip
      }
    }
  });

  // Capture stderr for error reporting
  let stderrBuf = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  proc.on('close', (code) => {
    // Flush remaining buffer
    if (active.buffer.trim()) {
      try {
        const event = JSON.parse(active.buffer);
        if (
          event.type === 'stream_event' &&
          event.event?.type === 'content_block_delta' &&
          event.event?.delta?.text
        ) {
          broadcastSse(requestId, 'chunk', { text: event.event.delta.text });
        }
      } catch {
        // ignore
      }
    }

    if (code !== 0 && stderrBuf.trim()) {
      broadcastSse(requestId, 'error', { message: stderrBuf.trim().slice(0, 500) });
    }
    broadcastSse(requestId, 'done', {});

    // Close all SSE connections
    for (const res of active.sseConnections) {
      if (!res.destroyed && !res.writableEnded) res.end();
    }

    cleanup(requestId);
  });

  proc.on('error', (err) => {
    broadcastSse(requestId, 'error', { message: err.message });
    cleanup(requestId);
  });
}

function cleanup(requestId: string) {
  const active = activeProcesses.get(requestId);
  if (active) {
    clearTimeout(active.timeout);
    activeProcesses.delete(requestId);
    activeCount--;
  }
}

// ---------------------------------------------------------------------------
// Artifact Helpers
// ---------------------------------------------------------------------------

type ArtifactKind = 'node-detail' | 'nodes-list' | 'edges-list' | 'traverse' | 'search' | 'schema' | 'unknown';

function isFiregraphQuery(command: string): boolean {
  return /npx\s+firegraph\s+query\b/.test(command);
}

function classifyCommand(command: string): ArtifactKind {
  const match = command.match(/npx\s+firegraph\s+query\s+(\S+)/);
  if (!match) return 'unknown';
  switch (match[1]) {
    case 'get':        return 'node-detail';
    case 'find-nodes': return 'nodes-list';
    case 'find-edges': return 'edges-list';
    case 'traverse':   return 'traverse';
    case 'search':     return 'search';
    case 'schema':     return 'schema';
    default:           return 'unknown';
  }
}

function parseToolResult(
  command: string,
  rawOutput: string,
): { id: string; kind: ArtifactKind; command: string; timestamp: string; data: unknown } | null {
  try {
    const data = JSON.parse(rawOutput);
    return {
      id: generateId(),
      kind: classifyCommand(command),
      command,
      timestamp: new Date().toISOString(),
      data,
    };
  } catch {
    // Output wasn't valid JSON — no artifact
    return null;
  }
}

// ---------------------------------------------------------------------------
// Express Routes
// ---------------------------------------------------------------------------

export function registerChatRoutes(app: Express, deps: ChatDeps): void {

  // POST /api/chat — start a new chat request
  app.post('/api/chat', (req: Request, res: Response) => {
    const { prompt, context, sessionId } = req.body as {
      prompt?: string;
      context?: Record<string, unknown>;
      sessionId?: string;
    };

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    if (activeCount >= deps.maxConcurrency) {
      return res.status(429).json({ error: 'Too many concurrent requests. Try again shortly.' });
    }

    const requestId = generateId();

    // Build the full prompt with context
    let fullPrompt = prompt;
    if (context && Object.keys(context).length > 0) {
      fullPrompt += `\n\n---\nEditor context:\n${JSON.stringify(context, null, 2)}`;
    }

    // sessionId is the claude session_id from a previous turn (if any)
    spawnChat(requestId, fullPrompt, deps, sessionId);

    res.json({ requestId });
  });

  // GET /api/chat/stream?requestId=X — SSE stream
  app.get('/api/chat/stream', (req: Request, res: Response) => {
    const requestId = req.query.requestId as string;
    if (!requestId) {
      return res.status(400).json({ error: 'requestId is required' });
    }

    const active = activeProcesses.get(requestId);
    if (!active) {
      return res.status(404).json({ error: 'Request not found or already completed' });
    }

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    active.sseConnections.add(res);

    // Clean up on disconnect
    req.on('close', () => {
      active.sseConnections.delete(res);
      // If no more listeners and process still running, kill it
      if (active.sseConnections.size === 0 && !active.proc.killed) {
        active.proc.kill('SIGTERM');
        cleanup(requestId);
      }
    });
  });

  // GET /api/chat/status — chat feature status
  app.get('/api/chat/status', (_req: Request, res: Response) => {
    res.json({
      enabled: true,
      model: deps.model,
      active: activeCount,
      maxConcurrency: deps.maxConcurrency,
    });
  });

}
