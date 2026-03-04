/**
 * Browser client for the editor's built-in chat API.
 * Replaces the abri client — calls the editor server directly.
 */

export interface ChatStatus {
  enabled: boolean;
  model: string;
  active: number;
  maxConcurrency: number;
}

export class ChatClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    // Default to same origin (editor server)
    this.baseUrl = baseUrl ?? '';
  }

  async request(params: {
    prompt: string;
    context?: Record<string, unknown>;
    sessionId?: string;
  }): Promise<ChatRequestHandle> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as Record<string, string>).error ?? `HTTP ${res.status}`);
    }
    const { requestId } = (await res.json()) as { requestId: string };
    return new ChatRequestHandle(this.baseUrl, requestId);
  }

  async status(): Promise<ChatStatus> {
    const res = await fetch(`${this.baseUrl}/api/chat/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<ChatStatus>;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/chat/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as ChatStatus;
      return data.enabled;
    } catch {
      return false;
    }
  }
}

export interface StreamResult {
  sessionId: string | null;
}

export class ChatRequestHandle {
  constructor(
    private baseUrl: string,
    public readonly requestId: string,
  ) {}

  /**
   * Stream response chunks. Yields text strings.
   * Returns the claude session_id (sent via SSE `session` event) for use with --resume.
   */
  async *stream(): AsyncGenerator<string, StreamResult, undefined> {
    const url = `${this.baseUrl}/api/chat/stream?requestId=${this.requestId}`;
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error('Failed to open SSE stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sessionId: string | null = null;

    try {
      while (true) {
        const { value, done: readerDone } = await reader.read();
        if (readerDone) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const lines = frame.split('\n');
          let event = '';
          let data = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data = line.slice(6);
          }

          if (event === 'chunk' && data) {
            yield (JSON.parse(data) as { text: string }).text;
          } else if (event === 'session' && data) {
            sessionId = (JSON.parse(data) as { sessionId: string }).sessionId;
          } else if (event === 'done') {
            return { sessionId };
          } else if (event === 'error' && data) {
            throw new Error((JSON.parse(data) as { message: string }).message);
          }
        }
      }
    } finally {
      reader.cancel();
    }

    return { sessionId };
  }
}
