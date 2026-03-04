# Editor Chat — Built-in AI Chat

The firegraph editor includes a built-in chat panel that spawns `claude -p` processes on demand. When the `claude` CLI is detected on PATH, the Chat tab appears in the sidebar — no external dependencies, no separate servers, no skill installation required.

## How It Works

```
Browser                    Editor Server (Express)              Claude CLI
   |                              |                                  |
   | POST /api/chat               |                                  |
   |----------------------------->| spawn: claude -p "..." --model   |
   |                              |   sonnet --output-format         |
   | GET /api/chat/stream?id=X    |   stream-json --resume $SID     |
   |<===== SSE ==================>|<---- stdout (NDJSON) ------------|
   |  event: chunk {text}         |  parse text blocks               |
   |  event: done                 |  on exit -> done                 |
   |  event: error                |  on stderr -> error              |
```

The editor server detects `claude` on PATH at startup. When a user sends a message from the chat panel, the server spawns a `claude -p` subprocess with graph-aware system prompts and tool access restricted to `npx firegraph query`. Responses stream back to the browser via Server-Sent Events.

## Configuration

Chat is **auto-enabled** when `claude` is on PATH. No configuration is required.

### Disabling Chat

Set `chat: false` in your config to disable chat even if `claude` is available:

```typescript
// firegraph.config.ts
export default defineConfig({
  entities: './entities',
  chat: false,  // disables the Chat tab
});
```

### Custom Model and Concurrency

```typescript
export default defineConfig({
  entities: './entities',
  chat: {
    model: 'haiku',       // default: 'sonnet'
    maxConcurrency: 4,     // default: 2
  },
});
```

## Multi-Turn Conversations

The chat supports multi-turn conversations using Claude's `--resume` flag. Each browser session maintains a conversation thread:

1. First message: server spawns `claude -p` (no `--resume`)
2. Claude responds. Server extracts `session_id` from the result JSON
3. Server maps the browser session to the Claude session
4. Subsequent messages: server spawns with `--resume <claude_session_id>`
5. Claude has full conversation context from previous turns
6. Clicking "Clear" resets the session — next message starts fresh

Session state persists in `sessionStorage` (survives navigation within a tab, clears on tab close).

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

## API Endpoints

The chat module registers these Express routes (alongside the existing tRPC routes):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | Start a chat request. Body: `{ prompt, context?, sessionId? }`. Returns `{ requestId, sessionId }` |
| `GET` | `/api/chat/stream?requestId=X` | SSE stream. Events: `chunk` (data: `{text}`), `done`, `error` (data: `{message}`) |
| `GET` | `/api/chat/status` | Returns `{ enabled, model, active, maxConcurrency }` |
| `DELETE` | `/api/chat/session/:sessionId` | Clear session memory (called on "Clear") |

## Prerequisites

- **Claude CLI**: Install from [claude.ai](https://claude.ai). The editor checks for `claude` on PATH at startup.
- **Editor server running**: The chat uses `npx firegraph query` under the hood, which talks to the running editor server's API.

## Firegraph Chat Skill (Alternative)

For users who prefer a skill-based approach, the bundled `firegraph-chat` Claude Code skill is still available. It uses [abri](https://github.com/typicalday/abri) as a streaming HTTP bridge between the editor and a Claude Code agent session.

```bash
# Install the skill
npx firegraph install-skill

# Or install for this project only
npx firegraph install-skill --project
```

See the skill's `SKILL.md` for configuration details.
