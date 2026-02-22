import { useRef, useEffect } from 'react';

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
export default function CustomView({ tagName, data, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const elementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

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
