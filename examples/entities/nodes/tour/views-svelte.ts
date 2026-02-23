// @ts-nocheck — Svelte types not installed in firegraph; this is a reference example.
/**
 * Example: Svelte 5 adapter for firegraph views.
 *
 * This file shows how to wrap Svelte components as firegraph views using
 * `wrapSvelte()` from `firegraph/svelte`. To use this in a real project,
 * rename it to `views.ts` (replacing the plain HTMLElement version) and
 * create `.svelte` component files alongside it.
 *
 * Requirements:
 * - `svelte` (v5+) in your project's dependencies
 * - `esbuild-svelte` in your project's dependencies (for the editor bundler)
 *
 * Each Svelte component receives a `data` prop:
 *
 * ```svelte
 * <!-- TourCard.svelte -->
 * <script>
 *   let { data } = $props();
 * </script>
 *
 * <div class="card">
 *   <strong>{data.name ?? 'Unnamed Tour'}</strong>
 *   <span>{data.difficulty ?? '—'}</span>
 * </div>
 *
 * <style>
 *   .card { padding: 14px 16px; border-radius: 10px; background: #1e293b; }
 * </style>
 * ```
 */

import { wrapSvelte } from 'firegraph/svelte';

// In a real project, these would be actual .svelte file imports:
// import TourCardComponent from './TourCard.svelte';
// import TourRowComponent from './TourRow.svelte';

// Placeholder — replace with actual Svelte component imports
const TourCardComponent = null as any;
const TourRowComponent = null as any;

const TourCard = wrapSvelte(TourCardComponent, {
  viewName: 'card',
  description: 'Compact tour overview card',
});

const TourRow = wrapSvelte(TourRowComponent, {
  viewName: 'row',
  description: 'Compact listing row',
});

// The default export MUST be an array of view classes.
export default [TourCard, TourRow];
