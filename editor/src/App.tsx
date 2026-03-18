import { Routes, Route, useParams, Navigate } from 'react-router-dom';
import { useCallback, useEffect, useRef } from 'react';
import Layout from './components/Layout';
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
import { ScopeProvider, parseScopeSplat } from './components/scope-context';
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

  const viewRegistry: ViewRegistryData = viewsData ?? { nodes: {}, edges: {}, collections: {}, hasViews: false };

  return (
    <FocusProvider>
      <ChatProvider chatEnabled={config?.chatEnabled ?? false}>
        <ArtifactProvider>
          <ChatBarProvider>
            <ScopeProvider>
              <Layout schema={schema!} config={config!} viewRegistry={viewRegistry} warnings={warningsData?.warnings ?? []}>
                <Routes>
                  <Route path="/" element={<Navigate to="/g" replace />} />
                  <Route
                    path="/g/*"
                    element={
                      <ScopedShell
                        schema={schema!}
                        viewRegistry={viewRegistry}
                        config={config!}
                      />
                    }
                  />
                </Routes>
              </Layout>
            </ScopeProvider>
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

function ScopedShell({ schema, viewRegistry, config }: ShellProps) {
  const { '*': splat = '' } = useParams();
  const { pageRoute } = parseScopeSplat(splat);

  // Match page route: /browse/type, /node/uid, /traverse, /views, or / (browse all)
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

  // Collection routes: /col/{name}[/{paramVal1}[/{paramVal2}...]]/[doc/{docId}]
  if (pageRoute.startsWith('/col/')) {
    const colPath = pageRoute.slice('/col/'.length);
    const docSepIdx = colPath.indexOf('/doc/');

    let colName: string;
    let paramVals: string[];
    let docId: string | undefined;

    if (docSepIdx >= 0) {
      const beforeDoc = colPath.slice(0, docSepIdx);
      docId = decodeURIComponent(colPath.slice(docSepIdx + '/doc/'.length));
      const beforeParts = beforeDoc.split('/');
      colName = decodeURIComponent(beforeParts[0]);
      paramVals = beforeParts.slice(1).filter(Boolean).map(decodeURIComponent);
    } else {
      const parts = colPath.split('/');
      colName = decodeURIComponent(parts[0]);
      paramVals = parts.slice(1).filter(Boolean).map(decodeURIComponent);
    }

    const colDef = (schema.collections ?? []).find((c) => c.name === colName);
    if (colDef) {
      const colParams: Record<string, string> = {};
      for (let i = 0; i < Math.min(paramVals.length, colDef.pathParams.length); i++) {
        colParams[colDef.pathParams[i]] = paramVals[i];
      }

      if (docId !== undefined) {
        return (
          <CollectionDocDetail
            collectionDef={colDef}
            docId={docId}
            params={colParams}
            readonly={config.readonly}
            viewRegistry={viewRegistry}
          />
        );
      }
      return (
        <CollectionBrowser
          collectionDef={colDef}
          params={colParams}
          readonly={config.readonly}
        />
      );
    }
  }

  // Default: browse all nodes in current scope (root /g or scoped /g/uid:name)
  return (
    <NodeBrowser
      schema={schema}
      viewRegistry={viewRegistry}
      config={config}
      typeParam=""
    />
  );
}
