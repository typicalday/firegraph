import { Routes, Route } from 'react-router-dom';
import { useState, useEffect, useCallback } from 'react';
import Layout from './components/Layout';
import Dashboard from './components/Dashboard';
import NodeBrowser from './components/NodeBrowser';
import NodeDetail from './components/NodeDetail';
import TraversalBuilder from './components/TraversalBuilder';
import ViewGallery from './components/ViewGallery';
import type { Schema, AppConfig, ViewRegistryData } from './types';
import { getSchema, getConfig, getViews } from './api';

export default function App() {
  const [schema, setSchema] = useState<Schema | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [viewRegistry, setViewRegistry] = useState<ViewRegistryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [schemaData, configData, viewsData] = await Promise.all([
        getSchema(),
        getConfig(),
        getViews(),
      ]);
      setSchema(schemaData);
      setConfig(configData);
      setViewRegistry(viewsData);

      // Load the views bundle if views are available
      if (viewsData.hasViews) {
        await new Promise<void>((resolve) => {
          const script = document.createElement('script');
          script.type = 'module';
          script.src = '/api/views/bundle';
          script.onload = () => resolve();
          script.onerror = () => resolve(); // graceful degradation
          document.head.appendChild(script);
        });
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
          <p className="text-slate-300 text-sm mb-4">{error}</p>
          <p className="text-slate-500 text-xs mb-4">
            Make sure you have ADC configured (run <code className="text-slate-300">gcloud auth application-default login</code>)
            and the server is running with the correct --project, --collection, and --registry flags.
          </p>
          <button onClick={loadData} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-500 transition-colors">
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <Layout schema={schema!} config={config!} viewRegistry={viewRegistry}>
      <Routes>
        <Route path="/" element={<Dashboard schema={schema!} config={config!} />} />
        <Route path="/browse/:type" element={<NodeBrowser schema={schema!} />} />
        <Route path="/node/:uid" element={<NodeDetail schema={schema!} viewRegistry={viewRegistry} config={config!} />} />
        <Route path="/traverse" element={<TraversalBuilder schema={schema!} />} />
        <Route path="/views" element={<ViewGallery viewRegistry={viewRegistry} schema={schema!} />} />
      </Routes>
    </Layout>
  );
}
