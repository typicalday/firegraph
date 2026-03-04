# Editor Chat — Abri Integration Guide

The firegraph editor includes a chat panel that connects to a Claude Code agent session via [abri](https://github.com/typicalday/abri), a streaming HTTP bridge. This enables AI-assisted graph exploration directly from the editor UI.

## How It Works

```
Editor (browser)                Abri Server (port 3885)        Claude Code Agent
       │                                │                              │
       │ POST /request {prompt,context} │                              │
       ├───────────────────────────────→│ GET /next (blocks)           │
       │                                │←─────────────────────────────┤
       │ GET /events?requestId=X        │ ── request JSON ──→         │
       │ ◀══ SSE stream ═══════════════ │                              │
       │                                │ POST /respond/:id/chunk      │
       │ ◀═ response:chunk             ←│←─────────────────────────────│
       │ ◀═ response:done              ←│←─────────────────────────────│
```

The editor's chat panel is a browser-side abri client. It submits user questions (with graph context) and streams responses via SSE. The abri server and agent loop are managed externally — typically as part of whatever Claude Code skill your project already runs.

## Editor Configuration

Enable the chat panel by telling the editor where abri is running:

```typescript
// firegraph.config.ts
export default defineConfig({
  entities: './entities',
  abri: 'http://localhost:3885',    // enables the Chat tab in the sidebar
});
```

Or via CLI/env:

```bash
npx firegraph editor --abri http://localhost:3885
# or
ABRI_URL=http://localhost:3885 npx firegraph editor
```

When `abri` is configured, a **Chat** tab appears in the sidebar alongside Navigate and Nearby. The tab shows a connection status dot (green when the abri server is reachable, gray when offline).

## Installing the Firegraph Chat Skill

The easiest way to get graph-aware AI chat is to install the bundled Claude Code skill. If your project has firegraph as a dependency:

```bash
# Install globally (available in all projects)
npx firegraph install-skill

# Or install for this project only
npx firegraph install-skill --project
```

This creates a symlink from your Claude Code skills directory to the skill files inside the firegraph package. The skill auto-updates when you upgrade firegraph.

To remove:

```bash
npx firegraph install-skill --uninstall
# or for project-level:
npx firegraph install-skill --uninstall --project
```

Once installed, the skill appears in Claude Code as `firegraph-chat`. It starts an abri server, runs an infinite listen-dispatch loop, and spawns subagents to answer graph queries from the editor chat panel.

### Prerequisites

- `abri` must be installed: `pnpm add abri` (or as a global/peer dependency)
- The editor must be configured with an `abri` URL (see [Editor Configuration](#editor-configuration) above)
- The `firegraph query` CLI must work (the editor server must be running)

## Adding Abri to a Custom Skill

If you prefer to integrate the abri bridge into your own skill instead of using the bundled one, here's what to add:

### Startup

Add these steps to your skill's startup sequence:

```bash
# 1. Clean up any leftover server
ABRI_PORT=3885
echo "$ABRI_PORT" > /tmp/abri-firegraph-chat.port
lsof -ti :$ABRI_PORT | xargs kill 2>/dev/null; sleep 0.5

# 2. Start abri
npx abri serve --port $ABRI_PORT &

# 3. Verify
sleep 1 && curl -s http://localhost:$ABRI_PORT/health
```

### Listen Loop

Add an infinite listen loop to your skill. This is the dispatcher — it receives messages from the editor and hands them off to subagents:

```
Step: Listen for editor chat requests

  REQUEST=$(npx abri listen --server http://localhost:$ABRI_PORT)

  - If empty (timeout after 5 min), silently retry.
  - If valid JSON, extract `id`, `prompt`, and `context`, then dispatch a subagent.
  - Go back to listening immediately (don't wait for the subagent).
```

### Subagent Dispatch

Each request gets its own background subagent. The subagent receives:

- **Request ID** — needed to stream the response back
- **Prompt** — the user's question
- **Context** — graph data from the editor (see below)

The subagent streams its answer back:

```bash
# Stream a chunk
echo 'your text here' | npx abri respond "<REQUEST_ID>" --server http://localhost:$ABRI_PORT

# Mark done (required)
npx abri respond "<REQUEST_ID>" --done --server http://localhost:$ABRI_PORT

# Report error
echo 'error description' | npx abri respond "<REQUEST_ID>" --error --server http://localhost:$ABRI_PORT
```

### Cleanup

Add a stop hook to kill the abri server when the skill exits:

```bash
#!/bin/bash
PORT_FILE="/tmp/abri-firegraph-chat.port"
if [ -f "$PORT_FILE" ]; then
  PORT=$(cat "$PORT_FILE")
  lsof -ti :"$PORT" | xargs kill 2>/dev/null
  rm -f "$PORT_FILE"
fi
```

## Context Payload

The editor sends a `context` object with each request containing the user's current view state:

```typescript
{
  // The node the user is currently viewing (if any)
  focusedNode?: { uid: string; nodeType: string };

  // Schema fields for the focused node type
  nodeSchema?: {
    type: string;
    description?: string;
    fields: Array<{ name: string; type: string; required: boolean; description?: string; enumValues?: string[] }>;
  };

  // Outgoing edges from the focused node, summarized by type
  outgoingEdges?: Array<{ axbType: string; targetType: string; count: number; hasMore: boolean }>;

  // Incoming edges to the focused node, summarized by type
  incomingEdges?: Array<{ axbType: string; sourceType: string; count: number; hasMore: boolean }>;

  // All registered edge types in the graph
  graphTopology: Array<{ aType: string; axbType: string; bType: string; inverseLabel?: string }>;
}
```

This context gives the subagent enough information to answer questions about the user's data without needing direct Firestore access.

## Key Rules for the Dispatcher

1. **Never stop the listen loop.** It runs forever until the user explicitly stops the skill.
2. **Never process requests yourself.** Always dispatch via a background subagent.
3. **Timeouts are normal.** The listen command returns empty after 5 minutes. Silently retry.
4. **Keep it fast.** Parse JSON, dispatch, loop. No analysis or delay in the dispatcher.

## Architecture Notes

- The editor embeds a minimal abri client (~100 lines) — no `abri` npm dependency needed in the editor
- The abri server runs on a separate port (3885) with `corsOrigin: '*'` — no proxy needed
- Chat history persists in `sessionStorage` (survives navigation within a tab, clears on tab close)
- Requests are serialized (input disabled while streaming)
- Connection status polls `/health` every 30 seconds
