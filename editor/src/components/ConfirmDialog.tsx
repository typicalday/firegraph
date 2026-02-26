import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  /** When set, the user must type this exact text before the confirm button is enabled. */
  requireConfirmText?: string;
}

export default function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onCancel, loading, requireConfirmText }: Props) {
  const [inputValue, setInputValue] = useState('');
  const confirmed = !requireConfirmText || inputValue === requireConfirmText;

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-2">{title}</h3>
        <p className="text-sm text-slate-400 mb-4">{message}</p>
        {requireConfirmText && (
          <div className="mb-4">
            <p className="text-xs text-slate-500 mb-2">
              Type <span className="font-mono text-slate-300">{requireConfirmText}</span> to confirm:
            </p>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-red-500/50 placeholder:text-slate-600"
              placeholder={requireConfirmText}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmed && !loading) onConfirm();
              }}
            />
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            disabled={loading}
            className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || !confirmed}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loading && <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
