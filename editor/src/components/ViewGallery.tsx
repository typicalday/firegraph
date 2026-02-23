import { useState } from 'react';
import type { Schema, ViewRegistryData, EntityViewMeta } from '../types';
import CustomView from './CustomView';

interface Props {
  viewRegistry: ViewRegistryData | null;
  schema: Schema;
}

export default function ViewGallery({ viewRegistry, schema }: Props) {
  if (!viewRegistry || !viewRegistry.hasViews) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        <h1 className="text-xl font-bold mb-2">Views</h1>
        <p className="text-sm text-slate-400">
          No views configured. Use <code className="text-slate-300">--views &lt;path&gt;</code> to load a views file.
        </p>
      </div>
    );
  }

  const nodeEntries = Object.entries(viewRegistry.nodes).filter(
    ([, meta]) => meta.views.length > 0,
  );
  const edgeEntries = Object.entries(viewRegistry.edges).filter(
    ([, meta]) => meta.views.length > 0,
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold mb-1">View Gallery</h1>
        <p className="text-sm text-slate-400">
          Preview all registered views with sample data
        </p>
      </div>

      {/* Node Views */}
      {nodeEntries.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold mb-4 uppercase tracking-wider text-slate-500">
            Node Views
          </h2>
          <div className="space-y-6">
            {nodeEntries.map(([entityType, meta]) => (
              <EntityViewSection
                key={entityType}
                entityType={entityType}
                meta={meta}
                kind="node"
              />
            ))}
          </div>
        </section>
      )}

      {/* Edge Views */}
      {edgeEntries.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-4 uppercase tracking-wider text-slate-500">
            Edge Views
          </h2>
          <div className="space-y-6">
            {edgeEntries.map(([axbType, meta]) => (
              <EntityViewSection
                key={axbType}
                entityType={axbType}
                meta={meta}
                kind="edge"
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function EntityViewSection({
  entityType,
  meta,
  kind,
}: {
  entityType: string;
  meta: EntityViewMeta;
  kind: 'node' | 'edge';
}) {
  const defaultSample = (meta.sampleData ?? {}) as Record<string, unknown>;
  const [sampleJson, setSampleJson] = useState(JSON.stringify(defaultSample, null, 2));
  const [parsedData, setParsedData] = useState<Record<string, unknown>>(defaultSample);
  const [parseError, setParseError] = useState<string | null>(null);
  const [showEditor, setShowEditor] = useState(false);

  const handleJsonChange = (value: string) => {
    setSampleJson(value);
    try {
      const parsed = JSON.parse(value);
      setParsedData(parsed);
      setParseError(null);
    } catch {
      setParseError('Invalid JSON');
    }
  };

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 p-5">
      <div className="flex items-center gap-2 mb-4">
        <span className="px-2 py-0.5 rounded text-xs font-mono bg-indigo-500/15 text-indigo-400">
          {kind}
        </span>
        <h3 className="text-sm font-semibold">{entityType}</h3>
        <span className="text-slate-500 text-xs">
          ({meta.views.length} view{meta.views.length !== 1 ? 's' : ''})
        </span>
        <button
          onClick={() => setShowEditor(!showEditor)}
          className="ml-auto text-xs text-slate-400 hover:text-slate-200 transition-colors"
        >
          {showEditor ? 'Hide data editor' : 'Edit sample data'}
        </button>
      </div>

      {/* Sample data editor */}
      {showEditor && (
        <div className="mb-4">
          <label className="block text-xs text-slate-500 mb-1">Sample Data (JSON)</label>
          <textarea
            value={sampleJson}
            onChange={(e) => handleJsonChange(e.target.value)}
            rows={6}
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 resize-y"
          />
          {parseError && <p className="text-xs text-red-400 mt-1">{parseError}</p>}
        </div>
      )}

      {/* Views grid */}
      <div className={`grid gap-4 ${meta.views.length === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
        {meta.views.map((view) => (
            <div key={view.tagName} className="bg-slate-950 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-semibold text-slate-300">{view.viewName}</span>
                {view.description && (
                  <span className="text-[10px] text-slate-500">{view.description}</span>
                )}
                <span className="ml-auto text-[10px] text-slate-600 font-mono">
                  &lt;{view.tagName}&gt;
                </span>
              </div>
              <CustomView tagName={view.tagName} data={parsedData} />
            </div>
          ))}
      </div>
    </div>
  );
}
