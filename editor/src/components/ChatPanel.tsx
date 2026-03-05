import { useState, useRef, useEffect, useCallback } from 'react';
import { useChat, type ChatMessage } from './chat-context';
import { useFocusMaybe } from './focus-context';
import { useArtifactMaybe } from './artifact-context';
import { buildChatContext } from './chat-context-builder';
import type { ChatArtifact } from '../artifact-types';
import type { Schema } from '../types';

interface Props {
  schema: Schema;
}

export default function ChatPanel({ schema }: Props) {
  const { messages, status, isStreaming, sendMessage, clearHistory, chatEnabled } = useChat();
  const focus = useFocusMaybe();
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll on new messages / streaming chunks
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 96) + 'px';
    }
  }, [input]);

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

  if (!chatEnabled) {
    return (
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="text-center">
          <p className="text-slate-500 text-xs mb-2">AI chat not available</p>
          <p className="text-slate-600 text-[10px]">
            Install the <code className="text-slate-400">claude</code> CLI to enable chat, or set <code className="text-slate-400">chat: false</code> in config to hide this tab.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              status === 'connected'
                ? 'bg-emerald-500'
                : status === 'checking'
                  ? 'bg-amber-500 animate-pulse'
                  : 'bg-slate-600'
            }`}
          />
          <span className="text-[10px] text-slate-500">
            {status === 'connected' ? 'Connected' : status === 'checking' ? 'Checking...' : 'Offline'}
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={clearHistory}
            className="text-[10px] text-slate-600 hover:text-slate-400 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-slate-600 text-[11px] mt-8">
            {status === 'connected' ? (
              <p>Ask a question about your graph data.</p>
            ) : (
              <p>
                Waiting for chat service to connect...
              </p>
            )}
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Context chip */}
      <div className="px-3 py-1 shrink-0">
        <span className="text-[9px] text-slate-600">
          {focus?.focused
            ? `Context: ${focus.focused.nodeType}:${focus.focused.uid.slice(0, 12)}${focus.focused.uid.length > 12 ? '...' : ''}`
            : 'Context: schema only'}
        </span>
      </div>

      {/* Input */}
      <div className="px-3 pb-3 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={status === 'connected' ? 'Ask about your graph...' : 'Agent offline'}
            disabled={status !== 'connected' || isStreaming}
            rows={1}
            className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors resize-none disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || status !== 'connected' || isStreaming}
            className="px-3 py-2 bg-indigo-600 text-white rounded-lg text-xs hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {isStreaming ? (
              <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin inline-block" />
            ) : (
              'Send'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Message Bubble ---

function MessageBubble({ message }: { message: ChatMessage }) {
  const artifactCtx = useArtifactMaybe();

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-indigo-600/30 border border-indigo-500/20 rounded-lg px-3 py-2 max-w-[90%]">
          <p className="text-xs text-slate-200 whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  if (message.role === 'error') {
    return (
      <div className="flex justify-start">
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2 max-w-[90%]">
          <p className="text-xs text-red-400 whitespace-pre-wrap break-words">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant
  return (
    <div className="flex flex-col gap-1.5 items-start">
      {/* Text content */}
      {(message.content || message.streaming) && (
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-2 max-w-[90%]">
          <pre className="text-xs text-slate-300 whitespace-pre-wrap break-words font-sans leading-relaxed">
            {message.content}
            {message.streaming && !message.activeToolCall && (
              <span className="inline-block w-1.5 h-3.5 bg-indigo-400 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
            )}
          </pre>
        </div>
      )}

      {/* Tool-call indicator */}
      {message.activeToolCall && (
        <div className="bg-slate-800/50 border border-amber-500/20 rounded-lg px-3 py-2 max-w-[90%]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin shrink-0" />
            <span className="text-[10px] text-amber-400 font-mono truncate">
              {formatToolCommand(message.activeToolCall)}
            </span>
          </div>
        </div>
      )}

      {/* Artifact cards */}
      {message.artifacts?.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          artifact={artifact}
          isActive={artifactCtx?.activeArtifact?.id === artifact.id}
          onClick={() => artifactCtx?.showArtifact(artifact)}
        />
      ))}
    </div>
  );
}

// --- Tool Command Formatter ---

function formatToolCommand(command: string): string {
  // Shorten "npx firegraph query get uid123" → "query get uid123"
  return command.replace(/^npx\s+firegraph\s+/, '');
}

// --- Artifact Card ---

function ArtifactCard({
  artifact,
  isActive,
  onClick,
}: {
  artifact: ChatArtifact;
  isActive: boolean;
  onClick: () => void;
}) {
  const { icon, label, detail } = getArtifactSummary(artifact);

  return (
    <button
      onClick={onClick}
      className={`w-full max-w-[90%] text-left bg-slate-800/80 border rounded-lg px-3 py-2
        transition-all hover:bg-slate-700/80 hover:border-indigo-500/50 group
        ${isActive ? 'border-indigo-500/60 ring-1 ring-indigo-500/30' : 'border-slate-700/50'}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-indigo-400 text-xs shrink-0">{icon}</span>
        <span className="text-[11px] font-medium text-slate-200 truncate">{label}</span>
        <span className="text-[10px] text-slate-500 ml-auto shrink-0">{detail}</span>
      </div>
    </button>
  );
}

function getArtifactSummary(artifact: ChatArtifact): { icon: string; label: string; detail: string } {
  const d = artifact.data as Record<string, unknown>;
  switch (artifact.kind) {
    case 'node-detail': {
      const node = d.node as { type: string; uid: string } | null;
      const outLen = Array.isArray(d.outEdges) ? d.outEdges.length : 0;
      const inLen = Array.isArray(d.inEdges) ? d.inEdges.length : 0;
      return {
        icon: '\u25cf',
        label: node ? `${node.type}:${node.uid}` : 'Node not found',
        detail: `${outLen + inLen} edges`,
      };
    }
    case 'nodes-list': {
      const nodes = Array.isArray(d.nodes) ? d.nodes : [];
      return { icon: '\u2261', label: `${nodes.length} nodes`, detail: d.hasMore ? 'has more' : '' };
    }
    case 'edges-list': {
      const edges = Array.isArray(d.edges) ? d.edges : [];
      return { icon: '\u2192', label: `${edges.length} edges`, detail: d.hasMore ? 'has more' : '' };
    }
    case 'traverse': {
      const hops = Array.isArray(d.hops) ? d.hops : [];
      return { icon: '\u26a1', label: `Traversal: ${hops.length} hops`, detail: `${d.totalReads ?? 0} reads` };
    }
    case 'search': {
      const results = Array.isArray(d.results) ? d.results : [];
      return { icon: '\u2315', label: `${results.length} results`, detail: 'search' };
    }
    case 'schema': {
      const nodeTypes = Array.isArray(d.nodeTypes) ? d.nodeTypes : [];
      const edgeTypes = Array.isArray(d.edgeTypes) ? d.edgeTypes : [];
      return { icon: '\u229e', label: `${nodeTypes.length} node types`, detail: `${edgeTypes.length} edge types` };
    }
    default:
      return { icon: '?', label: 'Query result', detail: '' };
  }
}
