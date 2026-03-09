/**
 * Generates a self-contained JS module that registers template-based
 * custom elements for dynamic types with viewTemplate defined.
 *
 * The generated code:
 * 1. Includes an inline mini-Mustache renderer (no eval, pure string ops)
 * 2. For each type with a viewTemplate, defines a Web Component using Shadow DOM
 * 3. Compiles the template with entity data on each .data set
 */
import type { DynamicTypeMetadata } from './dynamic-loader.js';

// ---------------------------------------------------------------------------
// Mini-Mustache renderer (inlined into the generated bundle)
// ---------------------------------------------------------------------------

/**
 * A minimal Mustache-compatible renderer that supports:
 * - {{variable}} — HTML-escaped value
 * - {{&variable}} — unescaped value
 * - {{#section}}...{{/section}} — render if truthy / iterate arrays
 * - {{^section}}...{{/section}} — render if falsy
 *
 * No eval(), no Function constructor, pure string operations.
 */
const MINI_MUSTACHE = `
function _esc(s){
  if(s==null)return'';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function _resolve(ctx,key){
  if(key==='.')return ctx;
  var parts=key.split('.'),v=ctx;
  for(var i=0;i<parts.length;i++){if(v==null)return'';v=v[parts[i]];}
  return v;
}
function _render(tmpl,ctx){
  // Sections: {{#key}}...{{/key}} and {{^key}}...{{/key}}
  tmpl=tmpl.replace(/\\{\\{([#^])\\s*([\\w.]+)\\s*\\}\\}([\\s\\S]*?)\\{\\{\\/\\s*\\2\\s*\\}\\}/g,
    function(_,type,key,inner){
      var val=_resolve(ctx,key);
      if(type==='^')return(!val||(Array.isArray(val)&&val.length===0))?_render(inner,ctx):'';
      if(!val)return'';
      if(Array.isArray(val))return val.map(function(item){return _render(inner,item);}).join('');
      return _render(inner,ctx);
    });
  // Unescaped: {{&key}}
  tmpl=tmpl.replace(/\\{\\{&\\s*([\\w.]+)\\s*\\}\\}/g,function(_,key){var v=_resolve(ctx,key);return v==null?'':String(v);});
  // Escaped: {{key}}
  tmpl=tmpl.replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g,function(_,key){return _esc(_resolve(ctx,key));});
  return tmpl;
}
`;

// ---------------------------------------------------------------------------
// Tag name sanitization
// ---------------------------------------------------------------------------

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').toLowerCase();
}

// ---------------------------------------------------------------------------
// Element code generation
// ---------------------------------------------------------------------------

function generateElementCode(
  tagName: string,
  template: string,
  css?: string,
): string {
  const templateJson = JSON.stringify(template);
  const cssBlock = css
    ? `const _s=new CSSStyleSheet();_s.replaceSync(${JSON.stringify(css)});this._shadow.adoptedStyleSheets=[_s];`
    : '';

  return `
if(!customElements.get('${tagName}')){
  customElements.define('${tagName}',class extends HTMLElement{
    _data={};_shadow;_err=null;
    constructor(){super();try{this._shadow=this.attachShadow({mode:'open'});${cssBlock}}catch(e){this._err=e;}}
    set data(v){this._data=v||{};this._r();}
    get data(){return this._data;}
    connectedCallback(){this._r();}
    _r(){
      if(this._err){this._shadow.innerHTML='<div style="padding:8px;color:#f87171;font-size:11px;">Template init error: '+_esc(this._err.message)+'</div>';return;}
      try{this._shadow.innerHTML=_render(${templateJson},this._data);}
      catch(e){this._shadow.innerHTML='<div style="padding:8px;color:#f87171;font-size:11px;">Template render error: '+_esc(e.message||e)+'</div>';}
    }
  });
}`;
}

// ---------------------------------------------------------------------------
// Template validation
// ---------------------------------------------------------------------------

/**
 * Extract field references from a Mustache template and validate them
 * against JSON Schema properties. Returns warning strings for unknown fields.
 */
export function validateTemplate(
  template: string,
  jsonSchema: object | undefined,
): string[] {
  if (!jsonSchema) return [];

  const schemaProps = (jsonSchema as Record<string, unknown>).properties;
  if (!schemaProps || typeof schemaProps !== 'object') return [];

  const propNames = new Set(Object.keys(schemaProps as Record<string, unknown>));
  const warnings: string[] = [];

  // Match {{var}}, {{&var}}, {{#var}}, {{^var}} — extract the field name
  const tagRegex = /\{\{[#^&]?\s*([\w.]+)\s*\}\}/g;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((match = tagRegex.exec(template)) !== null) {
    const field = match[1].split('.')[0]; // top-level field for nested refs
    if (field === '.' || field === '' || seen.has(field)) continue;
    seen.add(field);

    if (!propNames.has(field)) {
      warnings.push(`Template references "{{${field}}}" but it is not defined in the JSON Schema properties.`);
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Bundle generation
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained JS module string that registers custom elements
 * for dynamic types with viewTemplate defined.
 *
 * Returns null if no types have templates.
 */
export function generateDynamicViewsBundle(
  dynamicTypeMeta: DynamicTypeMetadata,
): string | null {
  const elements: string[] = [];

  for (const [name, meta] of Object.entries(dynamicTypeMeta.nodes)) {
    if (!meta.viewTemplate) continue;
    const tagName = `fg-${sanitize(name)}-template`;
    elements.push(generateElementCode(tagName, meta.viewTemplate, meta.viewCss));
  }

  for (const [name, meta] of Object.entries(dynamicTypeMeta.edges)) {
    if (!meta.viewTemplate) continue;
    const tagName = `fg-edge-${sanitize(name)}-template`;
    elements.push(generateElementCode(tagName, meta.viewTemplate, meta.viewCss));
  }

  if (elements.length === 0) return null;

  return `// Auto-generated dynamic views bundle\n${MINI_MUSTACHE}\n${elements.join('\n')}`;
}

/**
 * Build a map of tag names for dynamic types that have templates.
 * Used to merge into the ViewRegistry response.
 */
export function getDynamicViewTags(
  dynamicTypeMeta: DynamicTypeMetadata,
): { nodes: Record<string, string>; edges: Record<string, string> } {
  const nodes: Record<string, string> = {};
  const edges: Record<string, string> = {};

  for (const [name, meta] of Object.entries(dynamicTypeMeta.nodes)) {
    if (meta.viewTemplate) {
      nodes[name] = `fg-${sanitize(name)}-template`;
    }
  }

  for (const [name, meta] of Object.entries(dynamicTypeMeta.edges)) {
    if (meta.viewTemplate) {
      edges[name] = `fg-edge-${sanitize(name)}-template`;
    }
  }

  return { nodes, edges };
}
