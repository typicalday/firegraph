import type { ReactNode } from 'react';
import Sidebar from './Sidebar';
import type { Schema, AppConfig } from '../types';

interface Props {
  schema: Schema;
  config: AppConfig;
  children: ReactNode;
}

export default function Layout({ schema, config, children }: Props) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar schema={schema} config={config} />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
