'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

/**
 * TanStack Query provider.
 *
 * The two settings that matter for how this dashboard feels:
 *
 * `staleTime` — scraped data changes when the user runs a scrape, not
 * continuously. Refetching on every window focus would spend a round trip to
 * learn nothing, so the default is a minute of trust.
 *
 * The client is created inside `useState` rather than at module scope: a
 * module-level client is shared across every request on the server, which leaks
 * one user's cached data into another's render.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
