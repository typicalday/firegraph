import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import type { Schema, AppConfig, ViewRegistryData } from '../types';

interface Props {
  schema: Schema;
  config: AppConfig;
  viewRegistry?: ViewRegistryData | null;
  children: ReactNode;
}

export default function Layout({ schema, config, viewRegistry, children }: Props) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar schema={schema} config={config} viewRegistry={viewRegistry} />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
