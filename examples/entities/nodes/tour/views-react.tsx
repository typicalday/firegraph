// @ts-nocheck — React types not installed in firegraph; this is a reference example.
/**
 * Example: React adapter for firegraph views.
 *
 * This file shows how to wrap React function components as firegraph views
 * using `wrapReact()` from `firegraph/react`. To use this in a real project,
 * rename it to `views.tsx` (replacing the plain HTMLElement version).
 *
 * Requirements:
 * - `react` and `react-dom` in your project's dependencies
 * - tsconfig with `"jsx": "react-jsx"` or similar
 */

import { wrapReact } from 'firegraph/react';

// --- React components (standard function components) ---

const difficultyColors: Record<string, string> = {
  easy: '#22c55e',
  medium: '#eab308',
  hard: '#ef4444',
};

function TourCardView({ data }: { data: Record<string, unknown> }) {
  const color = difficultyColors[data.difficulty as string] ?? '#94a3b8';
  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 10,
      background: '#1e293b',
      border: '1px solid #334155',
      fontFamily: 'system-ui, sans-serif',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <strong style={{ color: '#e2e8f0', fontSize: 14 }}>
          {String(data.name ?? 'Unnamed Tour')}
        </strong>
        <span style={{
          padding: '2px 8px',
          borderRadius: 9999,
          fontSize: 11,
          fontWeight: 600,
          background: `${color}20`,
          color,
          border: `1px solid ${color}40`,
        }}>
          {String(data.difficulty ?? '—')}
        </span>
      </div>
      <div style={{ color: '#94a3b8', fontSize: 12 }}>
        Max riders: <span style={{ color: '#e2e8f0' }}>{String(data.maxRiders ?? '—')}</span>
      </div>
    </div>
  );
}

function TourRowView({ data }: { data: Record<string, unknown> }) {
  const color = difficultyColors[data.difficulty as string] ?? '#94a3b8';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      fontFamily: 'system-ui, sans-serif',
      padding: '2px 0',
    }}>
      <span style={{
        padding: '2px 8px',
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        background: `${color}20`,
        color,
        border: `1px solid ${color}40`,
      }}>
        {String(data.difficulty ?? '—')}
      </span>
      <span style={{ color: '#e2e8f0', fontSize: 13, fontWeight: 500 }}>
        {String(data.name ?? 'Unnamed Tour')}
      </span>
      <span style={{ color: '#64748b', fontSize: 12, marginLeft: 'auto' }}>
        {String(data.maxRiders ?? '?')} riders
      </span>
    </div>
  );
}

// --- Wrap with firegraph adapter ---

const TourCard = wrapReact(TourCardView, {
  viewName: 'card',
  description: 'Compact tour overview card',
});

const TourRow = wrapReact(TourRowView, {
  viewName: 'row',
  description: 'Compact listing row',
});

// The default export MUST be an array of view classes.
export default [TourCard, TourRow];
