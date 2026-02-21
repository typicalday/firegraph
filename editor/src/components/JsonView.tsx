import { useState } from 'react';

interface Props {
  data: unknown;
  defaultExpanded?: boolean;
  depth?: number;
}

export default function JsonView({ data, defaultExpanded = true, depth = 0 }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded && depth < 2);

  if (data === null) return <span className="text-slate-500">null</span>;
  if (data === undefined) return <span className="text-slate-500">undefined</span>;
  if (typeof data === 'string') return <span className="text-emerald-400">"{data}"</span>;
  if (typeof data === 'number') return <span className="text-amber-400">{data}</span>;
  if (typeof data === 'boolean') return <span className="text-violet-400">{String(data)}</span>;

  if (Array.isArray(data)) {
    if (data.length === 0) return <span className="text-slate-500">[]</span>;

    return (
      <span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-slate-500 hover:text-slate-300 transition-colors"
        >
          {expanded ? '[\u25BE' : `[\u25B8 ${data.length} items]`}
        </button>
        {expanded && (
          <div className="ml-4 border-l border-slate-800 pl-3">
            {data.map((item, i) => (
              <div key={i} className="py-0.5">
                <span className="text-slate-600 text-xs mr-2">{i}</span>
                <JsonView data={item} depth={depth + 1} />
                {i < data.length - 1 && <span className="text-slate-600">,</span>}
              </div>
            ))}
          </div>
        )}
        {expanded && <span className="text-slate-500">]</span>}
      </span>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>);
    if (entries.length === 0) return <span className="text-slate-500">{'{}'}</span>;

    return (
      <span>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-slate-500 hover:text-slate-300 transition-colors"
        >
          {expanded ? '{\u25BE' : `{\u25B8 ${entries.length} keys}`}
        </button>
        {expanded && (
          <div className="ml-4 border-l border-slate-800 pl-3">
            {entries.map(([key, value], i) => (
              <div key={key} className="py-0.5">
                <span className="text-cyan-400">{key}</span>
                <span className="text-slate-600">: </span>
                <JsonView data={value} depth={depth + 1} />
                {i < entries.length - 1 && <span className="text-slate-600">,</span>}
              </div>
            ))}
          </div>
        )}
        {expanded && <span className="text-slate-500">{'}'}</span>}
      </span>
    );
  }

  return <span className="text-slate-400">{String(data)}</span>;
}
