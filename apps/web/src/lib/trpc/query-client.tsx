import {
  QueryCache,
  QueryClient,
  defaultShouldDehydrateQuery,
} from "@tanstack/react-query";

import { authClient } from "@repo/auth/client";

import { superjson as SuperJSON } from "./superjson";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, we usually want to set some default staleTime
        // above 0 to avoid refetching immediately on the client
        staleTime: 60 * 1000,
        refetchOnReconnect: "always",
        refetchOnWindowFocus: "always",
        refetchOnMount: "always",
      },
      dehydrate: {
        serializeData: SuperJSON.serialize,
        shouldDehydrateQuery: (query) => {
          // Only dehydrate queries that have succeeded
          // Don't dehydrate pending queries as they may fail on hydration
          // (e.g., if they require authentication that isn't available on the client)
          return defaultShouldDehydrateQuery(query);
        },
      },
      hydrate: {
        deserializeData: SuperJSON.deserialize,
      },
    },
    queryCache: new QueryCache({
      onError: (error) => {
        if (error.message.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
          authClient.signOut({
            fetchOptions: {
              onSuccess: () => {
                if (window.location.href.includes("/login")) {
                  return;
                }

                window.location.href = "/login?error=required_scopes_missing";
              },
            },
          });

          return;
        }

        // Handle permission denied errors from APIs (e.g., Zoom API requiring authentication)
        if (
          error.message.includes("PERMISSION_DENIED") ||
          error.message.includes("unregistered callers") ||
          error.message.includes("API Key")
        ) {
          // Log but don't show error toast for these as they may be expected
          // during hydration of queries that require authentication
          console.warn(
            "[QueryCache] Permission denied error (likely during hydration):",
            error.message,
          );
          return;
        }

        console.error(error.message || "Something went wrong");
      },
    }),
  });
}

let browserQueryClient: QueryClient | undefined = undefined;

export function getQueryClient() {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return makeQueryClient();
  } else {
    // Browser: make a new query client if we don't already have one
    // This is very important, so we don't re-make a new client if React
    // suspends during the initial render. This may not be needed if we
    // have a suspense boundary BELOW the creation of the query client
    if (!browserQueryClient) browserQueryClient = makeQueryClient();
    return browserQueryClient;
  }
}
