import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import WarningBanner from './WarningBanner';
import ArtifactOverlay from './ArtifactOverlay';
import type { Schema, AppConfig, ViewRegistryData, SchemaViewWarning } from '../types';

interface Props {
  schema: Schema;
  config: AppConfig;
  viewRegistry?: ViewRegistryData | null;
  warnings?: SchemaViewWarning[];
  children: ReactNode;
}

export default function Layout({ schema, config, viewRegistry, warnings = [], children }: Props) {
  const vr = viewRegistry ?? { nodes: {}, edges: {}, hasViews: false };
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar schema={schema} config={config} viewRegistry={viewRegistry} />
      <main className="flex-1 overflow-auto relative">
        <WarningBanner warnings={warnings} />
        {children}
        <ArtifactOverlay viewRegistry={vr} config={config} />
      </main>
    </div>
  );
}
