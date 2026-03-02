import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { AbriClient } from '../abri-client';

// --- Types ---

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: string;
  streaming?: boolean;
}

export type ConnectionStatus = 'disconnected' | 'connected' | 'checking';

interface ChatContextValue {
  messages: ChatMessage[];
  status: ConnectionStatus;
  isStreaming: boolean;
  sendMessage: (prompt: string, context?: Record<string, unknown>) => Promise<void>;
  clearHistory: () => void;
  abriUrl: string | null;
}

// --- Context ---

const ChatContext = createContext<ChatContextValue | null>(null);

const STORAGE_KEY = 'fg-chat-history';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadMessages(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ChatMessage[];
      // Clear any stale streaming flags from a previous session
      return parsed.map((m) => ({ ...m, streaming: false }));
    }
  } catch {
    // ignore
  }
  return [];
}

function saveMessages(messages: ChatMessage[]) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // ignore
  }
}

// --- Provider ---

export function ChatProvider({ abriUrl, children }: { abriUrl: string | null; children: ReactNode }) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [status, setStatus] = useState<ConnectionStatus>(abriUrl ? 'checking' : 'disconnected');
  const [isStreaming, setIsStreaming] = useState(false);
  const clientRef = useRef<AbriClient | null>(null);

  // Create/update client when URL changes
  useEffect(() => {
    if (abriUrl) {
      clientRef.current = new AbriClient(abriUrl);
      setStatus('checking');
    } else {
      clientRef.current = null;
      setStatus('disconnected');
    }
  }, [abriUrl]);

  // Persist messages to sessionStorage
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  // Poll /health every 30s
  useEffect(() => {
    if (!clientRef.current) return;

    let active = true;
    const client = clientRef.current;

    const check = async () => {
      const ok = await client.health();
      if (active) setStatus(ok ? 'connected' : 'disconnected');
    };

    check();
    const timer = setInterval(check, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [abriUrl]);

  const sendMessage = useCallback(
    async (prompt: string, context?: Record<string, unknown>) => {
      const client = clientRef.current;
      if (!client || isStreaming) return;

      const userMsg: ChatMessage = {
        id: generateId(),
        role: 'user',
        content: prompt,
        timestamp: new Date().toISOString(),
      };

      const assistantId = generateId();
      const assistantMsg: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        streaming: true,
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsStreaming(true);

      try {
        const handle = await client.request({ prompt, context });

        for await (const chunk of handle.stream()) {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + chunk } : m)),
          );
        }

        // Mark streaming done
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, role: 'error', content: errorMessage, streaming: false } : m,
          ),
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming],
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEY);
  }, []);

  return (
    <ChatContext.Provider value={{ messages, status, isStreaming, sendMessage, clearHistory, abriUrl }}>
      {children}
    </ChatContext.Provider>
  );
}

// --- Hook ---

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}

export function useChatMaybe(): ChatContextValue | null {
  return useContext(ChatContext);
}
