'use client';

import { useLayoutEffect } from 'react';

const UI_BASE = process.env.NEXT_PUBLIC_UI_BASE_PATH || '/ui';

function withUiBase(input: string): string {
  if (!input.startsWith('/api/')) return input;
  return `${UI_BASE}${input}`;
}

export function UiRouteBridge() {
  useLayoutEffect(() => {
    const originalFetch = window.fetch.bind(window);
    const NativeEventSource = window.EventSource;

    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof input === 'string') {
        return originalFetch(withUiBase(input), init);
      }

      if (input instanceof URL) {
        const url = new URL(input.toString());
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
          url.pathname = `${UI_BASE}${url.pathname}`;
        }
        return originalFetch(url, init);
      }

      if (input instanceof Request) {
        const url = new URL(input.url);
        if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
          url.pathname = `${UI_BASE}${url.pathname}`;
          return originalFetch(new Request(url, input), init);
        }
      }

      return originalFetch(input, init);
    }) as typeof window.fetch;

    class UiEventSource extends NativeEventSource {
      constructor(url: string | URL, eventSourceInitDict?: EventSourceInit) {
        super(typeof url === 'string' ? withUiBase(url) : url, eventSourceInitDict);
      }
    }

    window.EventSource = UiEventSource as typeof EventSource;

    return () => {
      window.fetch = originalFetch;
      window.EventSource = NativeEventSource;
    };
  }, []);

  return null;
}
