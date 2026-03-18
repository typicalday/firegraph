import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import ScopeBreadcrumb from './ScopeBreadcrumb';
import WarningBanner from './WarningBanner';
import ChatBar from './ChatBar';
import type { Schema, AppConfig, ViewRegistryData, SchemaViewWarning } from '../types';

interface Props {
  schema: Schema;
  config: AppConfig;
  viewRegistry?: ViewRegistryData | null;
  warnings?: SchemaViewWarning[];
  children: ReactNode;
}

export default function Layout({ schema, config, viewRegistry, warnings = [], children }: Props) {
  const vr = viewRegistry ?? { nodes: {}, edges: {}, collections: {}, hasViews: false };
  return (
    <>
      <div className="flex h-screen overflow-hidden">
        <Sidebar schema={schema} config={config} viewRegistry={viewRegistry} />
        <main className="flex-1 overflow-auto relative">
          <ScopeBreadcrumb />
          <WarningBanner warnings={warnings} />
          {children}
        </main>
      </div>
      <ChatBar schema={schema} viewRegistry={vr} config={config} />
    </>
  );
}
