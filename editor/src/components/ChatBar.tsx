import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ChatArtifact } from '../artifact-types';
import type { AppConfig, Schema, ViewRegistryData } from '../types';
import { useArtifact } from './artifact-context';
import { ArtifactContent, getArtifactTitle } from './artifact-views';
import { useChatBar } from './chat-bar-context';
import { type ChatMessage, useChat } from './chat-context';
import { buildChatContext } from './chat-context-builder';
import { getArtifactSummary } from './ChatPanel';
import { useFocusMaybe } from './focus-context';

interface Props {
  schema: Schema;
  viewRegistry: ViewRegistryData;
  config: AppConfig;
}

export default function ChatBar({ schema, viewRegistry, config }: Props) {
  const { messages, status, isStreaming, sendMessage, clearHistory, chatEnabled } = useChat();
  const { mode, expand, collapse } = useChatBar();
  const { activeArtifact, showArtifact, dismissArtifact } = useArtifact();
  const focus = useFocusMaybe();
  const navigate = useNavigate();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const isTouchDevice = useRef(
    typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0),
  );

  const hasArtifact = activeArtifact !== null;

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // Focus textarea when expanding
  useEffect(() => {
    if (mode === 'expanded') {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [mode]);

  // Keyboard shortcut: Cmd+K to toggle, Escape to close
  useEffect(() => {
    if (!chatEnabled) return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      const isOurTextarea = e.target === textareaRef.current;

      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (mode === 'collapsed') expand();
        else collapse();
        return;
      }

      if (e.key === 'Escape' && mode === 'expanded') {
        if (isOurTextarea || (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT')) {
          // If artifact is open, close artifact first; second Escape closes dimension
          if (hasArtifact) {
            dismissArtifact();
          } else {
            collapse();
          }
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [chatEnabled, mode, expand, collapse, hasArtifact, dismissArtifact]);

  // --- Hover logic ---

  const scheduleExpand = useCallback(() => {
    if (isTouchDevice.current || mode !== 'collapsed') return;
    expandTimerRef.current = window.setTimeout(() => {
      expand();
    }, 200);
  }, [mode, expand]);

  const cancelExpand = useCallback(() => {
    if (expandTimerRef.current !== null) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }, []);

  const scheduleCollapse = useCallback(() => {
    if (isStreaming || isTouchDevice.current) return;
    collapseTimerRef.current = window.setTimeout(() => {
      collapse();
    }, 300);
  }, [isStreaming, collapse]);

  const cancelCollapse = useCallback(() => {
    if (collapseTimerRef.current !== null) {
      clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  }, []);

  // --- Send ---

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming || status !== 'connected') return;
    const context = buildChatContext(focus, schema);
    sendMessage(trimmed, context);
    setInput('');
  }, [input, isStreaming, status, focus, schema, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // --- Artifact click handler ---

  const handleArtifactClick = useCallback(
    (artifact: ChatArtifact) => {
      showArtifact(artifact);
    },
    [showArtifact],
  );

  // --- Navigation handler ("phase out" of chat dimension) ---

  const handleNavigate = useCallback(
    (uid: string) => {
      dismissArtifact();
      collapse();
      navigate(`/node/${encodeURIComponent(uid)}`);
    },
    [dismissArtifact, collapse, navigate],
  );

  if (!chatEnabled) return null;

  // =========================================================================
  // Collapsed: Breathing line
  // =========================================================================
  if (mode === 'collapsed') {
    return (
      <div
        className="fixed bottom-0 left-0 right-0 z-50 flex justify-center pointer-events-none"
        style={{ height: 40 }}
      >
        <div
          className="pointer-events-auto cursor-pointer flex items-end pb-3"
          style={{ width: 160 }}
          onMouseEnter={scheduleExpand}
          onMouseLeave={cancelExpand}
          onClick={() => {
            cancelExpand();
            expand();
          }}
        >
          <div
            className="chat-breathe-line w-full h-[2px] bg-emerald-400 rounded-full"
            style={{ animation: 'chat-breathe 3s ease-in-out infinite' }}
          />
        </div>
      </div>
    );
  }

  // =========================================================================
  // Expanded: Chat dimension overlay
  // =========================================================================
  return (
    <div
      className="fixed inset-0 z-50 flex"
      style={{ animation: 'chat-overlay-in 0.2s ease-out' }}
      onMouseEnter={cancelCollapse}
      onMouseLeave={scheduleCollapse}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/90 backdrop-blur-md"
        onClick={() => {
          if (hasArtifact) dismissArtifact();
          else collapse();
        }}
      />

      {/* Content area */}
      <div className="relative flex w-full h-full">
        {/* Chat column */}
        <div
          className={`flex flex-col h-full transition-all duration-300 ease-out ${
            hasArtifact
              ? 'w-[420px] shrink-0 border-r border-slate-800'
              : 'w-full max-w-[700px] mx-auto'
          }`}
        >
          {/* Header */}
          <div className="shrink-0 border-b border-slate-800 px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span
                className={`w-2 h-2 rounded-full ${
                  status === 'connected'
                    ? 'bg-emerald-500'
                    : status === 'checking'
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-slate-600'
                }`}
              />
              <span className="text-xs text-slate-400 font-medium">
                {status === 'connected'
                  ? 'Connected'
                  : status === 'checking'
                    ? 'Checking...'
                    : 'Offline'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {messages.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="text-[11px] text-slate-600 hover:text-slate-400 transition-colors px-2 py-1"
                >
                  Clear
                </button>
              )}
              <button
                onClick={collapse}
                className="p-1.5 text-slate-500 hover:text-slate-200 transition-colors"
                title="Close (Esc)"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-auto px-5 py-6 space-y-4">
            {messages.length === 0 && (
              <div className="text-center text-slate-600 text-sm mt-12">
                {status === 'connected' ? (
                  <p>Ask a question about your graph data.</p>
                ) : (
                  <p>Waiting for chat service to connect...</p>
                )}
              </div>
            )}

            {messages.map((msg) => (
              <ChatBarMessageBubble
                key={msg.id}
                message={msg}
                activeArtifactId={activeArtifact?.id ?? null}
                onArtifactClick={handleArtifactClick}
              />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Context chip */}
          <div className="px-5 py-1 shrink-0">
            <span className="text-[10px] text-slate-600">
              {focus?.focused
                ? `Context: ${focus.focused.nodeType}:${focus.focused.uid.slice(0, 16)}${focus.focused.uid.length > 16 ? '...' : ''}`
                : 'Context: schema only'}
            </span>
          </div>

          {/* Input */}
          <div className="px-5 pb-5 shrink-0">
            <div className="flex gap-3 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={status === 'connected' ? 'Ask about your graph...' : 'Agent offline'}
                disabled={status !== 'connected' || isStreaming}
                rows={1}
                className="flex-1 bg-slate-800/60 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/20 transition-all resize-none disabled:opacity-50 disabled:cursor-not-allowed"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || status !== 'connected' || isStreaming}
                className="px-4 py-3 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
              >
                {isStreaming ? (
                  <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Artifact panel (right side, only when artifact is active) */}
        {hasArtifact && (
          <div className="flex-1 flex flex-col h-full overflow-hidden animate-[slide-in-right_0.2s_ease-out]">
            {/* Artifact header */}
            <div className="shrink-0 border-b border-slate-800 px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-semibold text-slate-200 shrink-0">
                  {getArtifactTitle(activeArtifact)}
                </span>
                <span className="text-[10px] text-slate-500 font-mono truncate">
                  {activeArtifact.command.replace(/^npx\s+firegraph\s+/, '')}
                </span>
              </div>
              <button
                onClick={dismissArtifact}
                className="p-1.5 text-slate-400 hover:text-slate-200 transition-colors shrink-0 ml-3"
                title="Close artifact"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M1 1l12 12M13 1L1 13" />
                </svg>
              </button>
            </div>

            {/* Artifact content */}
            <div className="flex-1 overflow-auto p-5">
              <ArtifactContent
                key={activeArtifact.id}
                artifact={activeArtifact}
                viewRegistry={viewRegistry}
                config={config}
                onNavigate={handleNavigate}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat Bar Message Bubble
// ---------------------------------------------------------------------------

function ChatBarMessageBubble({
  message,
  activeArtifactId,
  onArtifactClick,
}: {
  message: ChatMessage;
  activeArtifactId: string | null;
  onArtifactClick: (artifact: ChatArtifact) => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-indigo-600/20 border border-indigo-500/20 rounded-xl px-4 py-3 max-w-[80%]">
          <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">
            {message.content}
          </p>
        </div>
      </div>
    );
  }

  if (message.role === 'error') {
    return (
      <div className="flex justify-start">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 max-w-[80%]">
          <p className="text-sm text-red-400 whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant
  return (
    <div className="flex flex-col gap-2 items-start">
      {(message.content || message.streaming) && (
        <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl px-4 py-3 max-w-[85%]">
          <pre className="text-sm text-slate-300 whitespace-pre-wrap break-words font-sans leading-relaxed">
            {message.content}
            {message.streaming && !message.activeToolCall && (
              <span className="inline-block w-1.5 h-4 bg-emerald-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
            )}
          </pre>
        </div>
      )}

      {/* Tool-call indicator */}
      {message.activeToolCall && (
        <div className="bg-slate-800/40 border border-amber-500/20 rounded-xl px-4 py-3 max-w-[85%]">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 border-2 border-amber-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="text-xs text-amber-400 font-mono truncate">
              {message.activeToolCall.replace(/^npx\s+firegraph\s+/, '')}
            </span>
          </div>
        </div>
      )}

      {/* Artifact cards */}
      {message.artifacts?.map((artifact) => {
        const { icon, label, detail } = getArtifactSummary(artifact);
        const isActive = activeArtifactId === artifact.id;
        return (
          <button
            key={artifact.id}
            onClick={() => onArtifactClick(artifact)}
            className={`w-full max-w-[85%] text-left bg-slate-800/60 border rounded-xl px-4 py-3
              transition-all hover:bg-slate-700/60 hover:border-indigo-500/50 group
              ${isActive ? 'border-indigo-500/60 ring-1 ring-indigo-500/30' : 'border-slate-700/50'}`}
          >
            <div className="flex items-center gap-2">
              <span className="text-indigo-400 text-sm shrink-0">{icon}</span>
              <span className="text-sm font-medium text-slate-200 truncate">{label}</span>
              <span className="text-xs text-slate-500 ml-auto shrink-0">{detail}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
