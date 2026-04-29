import { QueryClient } from "@tanstack/react-query";

export function createRelayQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        gcTime: 5 * 60 * 1000,
        retry: false,
        staleTime: 0,
      },
    },
  });
}
