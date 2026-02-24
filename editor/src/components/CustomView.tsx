import { useRef, useEffect, Component, type ReactNode } from 'react';

interface Props {
  tagName: string;
  data: Record<string, unknown>;
  className?: string;
}

/**
 * React wrapper that renders a Web Component (custom element) and passes
 * the entity `data` via a property setter. The custom element is created
 * imperatively so React's VDOM doesn't interfere with the component's
 * internal rendering.
 */
function CustomViewInner({ tagName, data, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    try {
      // Create or replace the custom element when the tagName changes
      if (!elementRef.current || elementRef.current.tagName.toLowerCase() !== tagName) {
        container.innerHTML = '';
        const el = document.createElement(tagName);
        // Custom elements default to display:inline which can collapse
        // inside overflow containers. Force block so views always render.
        el.style.display = 'block';
        container.appendChild(el);
        elementRef.current = el;
      }

      // Pass data to the element
      (elementRef.current as any).data = data;
    } catch (err) {
      console.error(`[CustomView] Error rendering <${tagName}>:`, err);
      container.innerHTML = `<div style="padding:8px;color:#f87171;font-size:11px;">View error: ${err instanceof Error ? err.message : String(err)}</div>`;
      elementRef.current = null;
    }
  }, [tagName, data]);

  useEffect(() => {
    return () => {
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
      elementRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className={className} />;
}

/**
 * Error boundary that catches render-time errors from custom elements
 * (e.g. connectedCallback throwing) and shows an inline error instead
 * of blanking the entire page.
 */
class CustomViewBoundary extends Component<
  Props & { children?: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[CustomView] Boundary caught error:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 8, color: '#f87171', fontSize: 11 }}>
          View error: {this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export default function CustomView(props: Props) {
  return (
    <CustomViewBoundary {...props}>
      <CustomViewInner {...props} />
    </CustomViewBoundary>
  );
}
