import { useRef, useEffect, Component, type ReactNode } from 'react';

interface Props {
  tagName: string;
  data: Record<string, unknown>;
  className?: string;
  /** Called when the view fails to render — parent should switch back to 'json'. */
  onError?: () => void;
}

/**
 * React wrapper that renders a Web Component (custom element) and passes
 * the entity `data` via a property setter. The custom element is created
 * imperatively so React's VDOM doesn't interfere with the component's
 * internal rendering.
 */
function CustomViewInner({ tagName, data, className, onError }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);
  // Keep onError in a ref so the effect doesn't re-run when the parent
  // passes a new inline arrow (which is every render).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    try {
      // Check if the custom element is registered — if not, auto-fallback.
      if (!customElements.get(tagName)) {
        console.warn(`[CustomView] <${tagName}> is not registered, falling back to JSON.`);
        elementRef.current = null;
        onErrorRef.current?.();
        return;
      }

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
      container.innerHTML = '';
      elementRef.current = null;
      onErrorRef.current?.();
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
 * (e.g. connectedCallback throwing) and auto-falls back to JSON.
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
    (this.props as Props).onError?.();
  }

  render() {
    if (this.state.error) {
      // Don't render anything — onError will have switched parent to JSON
      return null;
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
