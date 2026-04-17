import { useState } from 'react';

import type { FieldMeta } from '../types';

interface Props {
  fields: FieldMeta[];
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

export default function SchemaForm({ fields, values, onChange, errors }: Props) {
  return (
    <div className="space-y-4">
      {fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={values[field.name]}
          error={errors?.[field.name]}
          onChange={(val) => onChange({ ...values, [field.name]: val })}
        />
      ))}
    </div>
  );
}

function FieldInput({
  field,
  value,
  error,
  onChange,
}: {
  field: FieldMeta;
  value: unknown;
  error?: string;
  onChange: (val: unknown) => void;
}) {
  const labelText = `${field.name}${field.required ? '' : ' (optional)'}`;

  if (field.type === 'string') {
    return (
      <div>
        <label className="block text-xs text-slate-400 mb-1">{labelText}</label>
        <input
          type="text"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.pattern ? `Pattern: ${field.pattern}` : undefined}
          minLength={field.minLength}
          maxLength={field.maxLength}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
        />
        {field.minLength !== undefined && (
          <p className="text-[10px] text-slate-600 mt-0.5">Min length: {field.minLength}</p>
        )}
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div>
        <label className="block text-xs text-slate-400 mb-1">{labelText}</label>
        <input
          type="number"
          value={value !== undefined && value !== null ? String(value) : ''}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') return onChange(undefined);
            onChange(field.isInt ? parseInt(v, 10) : parseFloat(v));
          }}
          min={field.min}
          max={field.max}
          step={field.isInt ? 1 : 'any'}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
        />
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
    );
  }

  if (field.type === 'boolean') {
    return (
      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="w-4 h-4 bg-slate-800 border-slate-700 rounded text-indigo-600 focus:ring-indigo-500"
          />
          <span className="text-xs text-slate-400">{labelText}</span>
        </label>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
    );
  }

  if (field.type === 'enum' && field.enumValues) {
    return (
      <div>
        <label className="block text-xs text-slate-400 mb-1">{labelText}</label>
        <select
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 transition-colors"
        >
          <option value="">Select...</option>
          {field.enumValues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
    );
  }

  if (field.type === 'array' && field.itemMeta) {
    return <ArrayField field={field} value={value} onChange={onChange} error={error} />;
  }

  if (field.type === 'object' && field.fields) {
    return (
      <div>
        <label className="block text-xs text-slate-400 mb-1">{labelText}</label>
        <div className="pl-4 border-l-2 border-slate-700">
          <SchemaForm
            fields={field.fields}
            values={(value as Record<string, unknown>) ?? {}}
            onChange={(val) => onChange(val)}
          />
        </div>
        {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
      </div>
    );
  }

  // Fallback for unknown types: JSON text area
  return (
    <div>
      <label className="block text-xs text-slate-400 mb-1">{labelText}</label>
      <textarea
        value={value !== undefined ? JSON.stringify(value, null, 2) : ''}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value));
          } catch {
            // Let the user keep typing
          }
        }}
        rows={3}
        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition-colors"
        placeholder="JSON value"
      />
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
}

function ArrayField({
  field,
  value,
  onChange,
  error,
}: {
  field: FieldMeta;
  value: unknown;
  onChange: (val: unknown) => void;
  error?: string;
}) {
  const items = Array.isArray(value) ? value : [];
  const [collapsed, setCollapsed] = useState(false);

  const addItem = () => {
    const defaultVal =
      field.itemMeta?.type === 'object'
        ? {}
        : field.itemMeta?.type === 'string'
          ? ''
          : field.itemMeta?.type === 'number'
            ? 0
            : null;
    onChange([...items, defaultVal]);
  };

  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, val: unknown) => {
    onChange(items.map((item, i) => (i === index ? val : item)));
  };

  const labelText = `${field.name}${field.required ? '' : ' (optional)'}`;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <label className="text-xs text-slate-400">{labelText}</label>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="text-[10px] text-slate-600 hover:text-slate-400"
        >
          [{items.length} items] {collapsed ? '+' : '-'}
        </button>
      </div>
      {!collapsed && (
        <div className="pl-4 border-l-2 border-slate-700 space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="text-[10px] text-slate-600 mt-2 w-4 shrink-0">{i}</span>
              <div className="flex-1">
                {field.itemMeta && (
                  <FieldInput
                    field={{ ...field.itemMeta, name: `${field.name}[${i}]` }}
                    value={item}
                    onChange={(val) => updateItem(i, val)}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => removeItem(i)}
                className="text-slate-600 hover:text-red-400 transition-colors mt-2"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addItem}
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
            Add item
          </button>
        </div>
      )}
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
}
