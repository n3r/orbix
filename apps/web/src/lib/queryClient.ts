import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000, // back-nav renders instantly from cache
      retry: (count, err) => !(err instanceof ApiError) && count < 2, // never retry 4xx
      refetchOnWindowFocus: false,
    },
  },
});
