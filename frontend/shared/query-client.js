import { QueryClient } from "@tanstack/query-core";

export function createRelayQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: Infinity,
        retry: false,
        staleTime: 0,
      },
    },
  });
}
