import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import type { ChatArtifact } from '../artifact-types';
import { ChatClient } from '../chat-client';

// --- Types ---

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: string;
  streaming?: boolean;
  artifacts?: ChatArtifact[];
  activeToolCall?: string | null;
}

export type ConnectionStatus = 'disconnected' | 'connected' | 'checking';

interface ChatContextValue {
  messages: ChatMessage[];
  status: ConnectionStatus;
  isStreaming: boolean;
  sendMessage: (prompt: string, context?: Record<string, unknown>) => Promise<void>;
  clearHistory: () => void;
  chatEnabled: boolean;
}

// --- Context ---

const ChatContext = createContext<ChatContextValue | null>(null);

const STORAGE_KEY = 'fg-chat-history';
const SESSION_KEY = 'fg-chat-session';

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadMessages(): ChatMessage[] {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ChatMessage[];
      // Clear any stale streaming/tool flags from a previous session
      return parsed.map((m) => ({ ...m, streaming: false, activeToolCall: null }));
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

export function ChatProvider({
  chatEnabled,
  children,
}: {
  chatEnabled: boolean;
  children: ReactNode;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [status, setStatus] = useState<ConnectionStatus>(chatEnabled ? 'checking' : 'disconnected');
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });
  const clientRef = useRef<ChatClient | null>(null);

  // Create/update client when chatEnabled changes
  useEffect(() => {
    if (chatEnabled) {
      clientRef.current = new ChatClient();
      setStatus('checking');
    } else {
      clientRef.current = null;
      setStatus('disconnected');
    }
  }, [chatEnabled]);

  // Persist messages to sessionStorage
  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  // Persist sessionId
  useEffect(() => {
    try {
      if (sessionId) {
        sessionStorage.setItem(SESSION_KEY, sessionId);
      } else {
        sessionStorage.removeItem(SESSION_KEY);
      }
    } catch {
      // ignore
    }
  }, [sessionId]);

  // Poll /api/chat/status every 30s
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
  }, [chatEnabled]);

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
        const handle = await client.request({
          prompt,
          context,
          sessionId: sessionId ?? undefined,
        });

        const gen = handle.stream();
        let result = await gen.next();
        while (!result.done) {
          const event = result.value;
          if (event.kind === 'text') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: m.content + event.text } : m,
              ),
            );
          } else if (event.kind === 'artifact') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? {
                      ...m,
                      artifacts: [...(m.artifacts ?? []), event.artifact],
                      activeToolCall: null,
                    }
                  : m,
              ),
            );
          } else if (event.kind === 'tool_start') {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, activeToolCall: event.command } : m)),
            );
          }
          result = await gen.next();
        }

        // Stream done — capture claude session_id for multi-turn resume
        if (result.value?.sessionId) {
          setSessionId(result.value.sessionId);
        }

        // Mark streaming done
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, streaming: false, activeToolCall: null } : m,
          ),
        );
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, role: 'error', content: errorMessage, streaming: false }
              : m,
          ),
        );
      } finally {
        setIsStreaming(false);
      }
    },
    [isStreaming, sessionId],
  );

  const clearHistory = useCallback(() => {
    setMessages([]);
    sessionStorage.removeItem(STORAGE_KEY);
    setSessionId(null);
  }, []);

  return (
    <ChatContext.Provider
      value={{ messages, status, isStreaming, sendMessage, clearHistory, chatEnabled }}
    >
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
