import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { ChatArtifact } from '../artifact-types';

interface ArtifactContextValue {
  activeArtifact: ChatArtifact | null;
  showArtifact: (artifact: ChatArtifact) => void;
  dismissArtifact: () => void;
}

const ArtifactContext = createContext<ArtifactContextValue | null>(null);

export function ArtifactProvider({ children }: { children: ReactNode }) {
  const [activeArtifact, setActiveArtifact] = useState<ChatArtifact | null>(null);

  const showArtifact = useCallback((artifact: ChatArtifact) => {
    setActiveArtifact(artifact);
  }, []);

  const dismissArtifact = useCallback(() => {
    setActiveArtifact(null);
  }, []);

  return (
    <ArtifactContext.Provider value={{ activeArtifact, showArtifact, dismissArtifact }}>
      {children}
    </ArtifactContext.Provider>
  );
}

export function useArtifact(): ArtifactContextValue {
  const ctx = useContext(ArtifactContext);
  if (!ctx) throw new Error('useArtifact must be used within ArtifactProvider');
  return ctx;
}

export function useArtifactMaybe(): ArtifactContextValue | null {
  return useContext(ArtifactContext);
}
