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

interface ActiveProcess {
  proc: ChildProcess;
  sseConnections: Set<Response>;
  timeout: ReturnType<typeof setTimeout>;
  buffer: string;
  resultJson: string;
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

  const dir = join(tmpdir(), 'firegraph-chat');
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
7. Keep answers concise and relevant to the question.
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
  };

  activeProcesses.set(requestId, active);
  activeCount++;

  // Parse NDJSON from stdout
  //
  // Event sequence from `claude -p --output-format stream-json --verbose --include-partial-messages`:
  //   1. type:"system" subtype:"init"  → session_id, tools, model info
  //   2. type:"stream_event" event.type:"message_start"
  //   3. type:"stream_event" event.type:"content_block_start"
  //   4. type:"stream_event" event.type:"content_block_delta" → event.delta.text (incremental text)
  //   5. type:"assistant" → complete message (skip to avoid duplication)
  //   6. type:"stream_event" event.type:"content_block_stop"
  //   7. type:"stream_event" event.type:"message_stop"
  //   8. type:"result"  → session_id, cost, usage
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
          // Send session_id to browser so it can resume later
          broadcastSse(requestId, 'session', { sessionId: event.session_id });
        } else if (
          event.type === 'stream_event' &&
          event.event?.type === 'content_block_delta' &&
          event.event?.delta?.type === 'text_delta' &&
          event.event?.delta?.text
        ) {
          // Incremental text delta — stream to browser
          broadcastSse(requestId, 'chunk', { text: event.event.delta.text });
        }
        // type:"assistant" is the complete message — skip to avoid duplication
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
