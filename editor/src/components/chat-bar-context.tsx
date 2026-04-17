import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';

export type ChatBarMode = 'collapsed' | 'expanded';

interface ChatBarContextValue {
  mode: ChatBarMode;
  expand: () => void;
  collapse: () => void;
}

const ChatBarContext = createContext<ChatBarContextValue | null>(null);

export function ChatBarProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ChatBarMode>('collapsed');

  const expand = useCallback(() => setMode('expanded'), []);
  const collapse = useCallback(() => setMode('collapsed'), []);

  return (
    <ChatBarContext.Provider value={{ mode, expand, collapse }}>{children}</ChatBarContext.Provider>
  );
}

export function useChatBar(): ChatBarContextValue {
  const ctx = useContext(ChatBarContext);
  if (!ctx) throw new Error('useChatBar must be used within ChatBarProvider');
  return ctx;
}

export function useChatBarMaybe(): ChatBarContextValue | null {
  return useContext(ChatBarContext);
}
