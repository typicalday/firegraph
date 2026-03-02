/**
 * Inline abri browser client — minimal fetch + SSE implementation.
 * No dependency on the `abri` npm package.
 */

export interface AbriRequest {
  id: string;
  prompt: string;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AbriStatus {
  pending: number;
  active: number;
  completed: number;
  errors: number;
  connections: number;
}

export class AbriClient {
  constructor(private baseUrl: string) {}

  async request(params: {
    prompt: string;
    context?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<AbriRequestHandle> {
    const res = await fetch(`${this.baseUrl}/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as Record<string, string>).error ?? `HTTP ${res.status}`);
    }
    const request = (await res.json()) as AbriRequest;
    return new AbriRequestHandle(this.baseUrl, request);
  }

  async status(): Promise<AbriStatus> {
    const res = await fetch(`${this.baseUrl}/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<AbriStatus>;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export class AbriRequestHandle {
  constructor(
    private baseUrl: string,
    public readonly request: AbriRequest,
  ) {}

  async *stream(): AsyncGenerator<string, void, undefined> {
    const url = `${this.baseUrl}/events?requestId=${this.request.id}`;
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) throw new Error('Failed to open SSE stream');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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

          if (event === 'response:chunk' && data) {
            yield (JSON.parse(data) as { text: string }).text;
          } else if (event === 'response:done') {
            return;
          } else if (event === 'response:error' && data) {
            throw new Error((JSON.parse(data) as { message: string }).message);
          } else if (event === 'request:timeout') {
            throw new Error('Request timed out — no agent is listening');
          }
        }
      }
    } finally {
      reader.cancel();
    }
  }
}
