"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const makeQueryClient = () =>
  new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 }, mutations: { retry: 0 } } });

let browserQueryClient: QueryClient | undefined;

/** One cache per browser tab (shared by the header and the page), a fresh one per server render. */
function getQueryClient() {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * Data cache (TanStack Query) for signed-in areas: /painel and /admin layouts and the signed-in header.
 * Public pages do not mount it, so they do not ship this code. Toasts (ToastProvider) live in the root layout.
 */
export function AppProviders({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={getQueryClient()}>{children}</QueryClientProvider>;
}
