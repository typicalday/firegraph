import { Routes, Route } from 'react-router-dom';
import { useCallback } from 'react';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import NodeBrowser from './components/NodeBrowser';
import NodeDetail from './components/NodeDetail';
import TraversalBuilder from './components/TraversalBuilder';
import ViewGallery from './components/ViewGallery';
import { FocusProvider } from './components/focus-context';
import type { ViewRegistryData } from './types';
import { trpc } from './trpc';

export default function App() {
  const { data: schema, error: schemaError, isLoading: schemaLoading } = trpc.getSchema.useQuery();
  const { data: config, error: configError, isLoading: configLoading } = trpc.getConfig.useQuery();
  const { data: viewsData, error: viewsError, isLoading: viewsLoading } = trpc.getViews.useQuery();
  const { data: warningsData } = trpc.getWarnings.useQuery();

  const loading = schemaLoading || configLoading || viewsLoading;
  const error = schemaError || configError || viewsError;

  // Load views bundle when view data is available
  const loadViewsBundle = useCallback(() => {
    if (viewsData?.hasViews) {
      // Only inject script once
      if (!document.querySelector('script[src="/api/views/bundle"]')) {
        const script = document.createElement('script');
        script.type = 'module';
        script.src = '/api/views/bundle';
        document.head.appendChild(script);
      }
    }
  }, [viewsData]);

  // Trigger bundle load when views data arrives
  if (viewsData && !loading) {
    loadViewsBundle();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400">Connecting to Firestore...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="bg-slate-900 border border-red-500/30 rounded-xl p-8 max-w-lg">
          <h2 className="text-red-400 text-lg font-semibold mb-2">Connection Error</h2>
          <p className="text-slate-300 text-sm mb-4">{error.message}</p>
          <p className="text-slate-500 text-xs mb-4">
            Make sure you have ADC configured (run <code className="text-slate-300">gcloud auth application-default login</code>)
            and the server is running with the correct --project, --collection, and --registry flags.
          </p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-500 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const viewRegistry: ViewRegistryData = viewsData ?? { nodes: {}, edges: {}, hasViews: false };

  return (
    <FocusProvider>
      <Layout schema={schema!} config={config!} viewRegistry={viewRegistry} warnings={warningsData?.warnings ?? []}>
        <Routes>
          <Route path="/" element={<Dashboard schema={schema!} config={config!} />} />
          <Route path="/browse/:type" element={<NodeBrowser schema={schema!} viewRegistry={viewRegistry} config={config!} />} />
          <Route path="/node/:uid" element={<NodeDetail schema={schema!} viewRegistry={viewRegistry} config={config!} />} />
          <Route path="/traverse" element={<TraversalBuilder schema={schema!} />} />
          <Route path="/views" element={<ViewGallery viewRegistry={viewRegistry} schema={schema!} />} />
        </Routes>
      </Layout>
    </FocusProvider>
  );
}
