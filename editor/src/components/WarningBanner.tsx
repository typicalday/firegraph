import { useState } from 'react';
import type { SchemaViewWarning } from '../types';

interface Props {
  warnings: SchemaViewWarning[];
}

export default function WarningBanner({ warnings }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (warnings.length === 0 || dismissed) return null;

  return (
    <div className="mx-6 mt-4">
      <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-left"
          >
            <svg className="w-4 h-4 text-amber-400 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <span className="text-amber-400 text-sm font-medium">
              {warnings.length} schema/views warning{warnings.length !== 1 ? 's' : ''}
            </span>
            <svg
              className={`w-3.5 h-3.5 text-amber-400/60 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
            </svg>
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="text-amber-400/40 hover:text-amber-400/70 transition-colors p-1"
            title="Dismiss"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {expanded && (
          <ul className="mt-3 space-y-1.5">
            {warnings.map((w, i) => (
              <li key={i} className="text-xs text-amber-300/80 flex items-start gap-2">
                <span className="shrink-0 mt-1 w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span>
                  <span className="text-amber-400/50 font-mono mr-1">[{w.code}]</span>
                  {w.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
