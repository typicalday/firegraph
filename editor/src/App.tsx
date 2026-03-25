import { Routes, Route, useParams } from 'react-router-dom';
import { useCallback, useEffect, useRef } from 'react';
import Layout from './components/Layout';
import RootPage from './components/RootPage';
import NodeBrowser from './components/NodeBrowser';
import NodeDetail from './components/NodeDetail';
import TraversalBuilder from './components/TraversalBuilder';
import ViewGallery from './components/ViewGallery';
import CollectionBrowser from './components/CollectionBrowser';
import CollectionDocDetail from './components/CollectionDocDetail';
import { FocusProvider } from './components/focus-context';
import { ChatProvider } from './components/chat-context';
import { ArtifactProvider } from './components/artifact-context';
import { ChatBarProvider } from './components/chat-bar-context';
import { PathProvider, usePath } from './components/path-context';
import { RecentsProvider } from './components/recents-context';
import type { Schema, ViewRegistryData, AppConfig } from './types';
import { trpc } from './trpc';

export default function App() {
  const { data: schema, error: schemaError, isLoading: schemaLoading } = trpc.getSchema.useQuery();
  const { data: config, error: configError, isLoading: configLoading } = trpc.getConfig.useQuery();
  const { data: viewsData, error: viewsError, isLoading: viewsLoading } = trpc.getViews.useQuery();
  const { data: warningsData } = trpc.getWarnings.useQuery();

  const loading = schemaLoading || configLoading || viewsLoading;
  const error = schemaError || configError || viewsError;

  // Track dynamic bundle version for cache-busting on reload
  const dynamicBundleVersion = useRef(0);

  // Load views bundle when view data is available
  const loadViewsBundle = useCallback(() => {
    if (viewsData?.hasViews) {
      // Only inject static bundle once
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

  // Load/reload dynamic views bundle when schema changes
  useEffect(() => {
    if (!schema?.dynamicMode || !viewsData?.hasViews) return;

    // Remove any existing dynamic bundle script
    const existing = document.querySelector('script[data-dynamic-views]');
    if (existing) existing.remove();

    // Inject new script with cache-bust
    dynamicBundleVersion.current++;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = `/api/views/dynamic-bundle?v=${dynamicBundleVersion.current}`;
    script.setAttribute('data-dynamic-views', 'true');
    document.head.appendChild(script);

    return () => {
      script.remove();
    };
  }, [schema, viewsData]);

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

  const viewRegistry = (viewsData as ViewRegistryData | undefined) ?? { nodes: {}, edges: {}, collections: {}, hasViews: false } as ViewRegistryData;

  return (
    <FocusProvider>
      <ChatProvider chatEnabled={config?.chatEnabled ?? false}>
        <ArtifactProvider>
          <ChatBarProvider>
            <RecentsProvider>
              <Layout schema={schema!} config={config!} viewRegistry={viewRegistry} warnings={warningsData?.warnings ?? []}>
                <Routes>
                  <Route
                    path="/"
                    element={<RootPage schema={schema!} config={config!} />}
                  />
                  <Route
                    path="/:encodedPath/*"
                    element={
                      <PathProvider
                        graphCollection={config?.collection}
                        collections={schema?.collections}
                      >
                        <PathShell
                          schema={schema!}
                          viewRegistry={viewRegistry}
                          config={config!}
                        />
                      </PathProvider>
                    }
                  />
                </Routes>
              </Layout>
            </RecentsProvider>
          </ChatBarProvider>
        </ArtifactProvider>
      </ChatProvider>
    </FocusProvider>
  );
}

interface ShellProps {
  schema: Schema;
  viewRegistry: ViewRegistryData;
  config: AppConfig;
}

function PathShell({ schema, viewRegistry, config }: ShellProps) {
  const { '*': splat = '' } = useParams();
  const { pathType, collectionMatch } = usePath();

  // Parse page action from the splat (everything after the encoded path)
  const pageRoute = splat ? `/${splat}` : '';

  // --- Graph context ---
  if (pathType === 'graph') {
    const browseMatch = pageRoute.match(/^\/browse\/(.+)$/);
    const nodeMatch = pageRoute.match(/^\/node\/(.+)$/);

    if (browseMatch) {
      return (
        <NodeBrowser
          schema={schema}
          viewRegistry={viewRegistry}
          config={config}
          typeParam={decodeURIComponent(browseMatch[1])}
        />
      );
    }
    if (nodeMatch) {
      return (
        <NodeDetail
          schema={schema}
          viewRegistry={viewRegistry}
          config={config}
          uidParam={decodeURIComponent(nodeMatch[1])}
        />
      );
    }
    if (pageRoute === '/traverse') {
      return <TraversalBuilder schema={schema} />;
    }
    if (pageRoute === '/views') {
      return <ViewGallery viewRegistry={viewRegistry} schema={schema} />;
    }

    // Default: graph landing (browse all node types)
    return (
      <NodeBrowser
        schema={schema}
        viewRegistry={viewRegistry}
        config={config}
        typeParam=""
      />
    );
  }

  // --- Collection context ---
  if (pathType === 'collection' && collectionMatch) {
    const docMatch = pageRoute.match(/^\/doc\/(.+)$/);

    if (docMatch) {
      return (
        <CollectionDocDetail
          collectionDef={collectionMatch.collection}
          docId={decodeURIComponent(docMatch[1])}
          params={collectionMatch.params}
          readonly={config.readonly}
          viewRegistry={viewRegistry}
        />
      );
    }

    return (
      <CollectionBrowser
        collectionDef={collectionMatch.collection}
        params={collectionMatch.params}
        readonly={config.readonly}
      />
    );
  }

  // --- Unknown path ---
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 text-center">
        <h2 className="text-lg font-semibold mb-2 text-slate-300">Unknown Path</h2>
        <p className="text-sm text-slate-400">
          This Firestore path doesn't match any configured graph or collection.
        </p>
      </div>
    </div>
  );
}
