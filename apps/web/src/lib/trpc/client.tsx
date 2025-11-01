"use client";

import { useState, type ReactNode } from "react";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  PersistQueryClientProvider,
  removeOldestQuery,
} from "@tanstack/react-query-persist-client";
import {
  createTRPCClient,
  httpBatchStreamLink,
  loggerLink,
} from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";

import type { AppRouter } from "@repo/api";
import { env } from "@repo/env/client";

import { getQueryClient } from "./query-client";
import { superjson } from "./superjson";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

function getUrl() {
  const base = (() => {
    if (typeof window !== "undefined") return "";
    if (env.NEXT_PUBLIC_VERCEL_URL)
      return `https://${env.NEXT_PUBLIC_VERCEL_URL}`;
    return "http://localhost:3000";
  })();

  return `${base}/api/trpc`;
}

const persister = createAsyncStoragePersister({
  storage: typeof window !== "undefined" ? window.localStorage : null,
  throttleTime: 1000,
  retry: removeOldestQuery,
  serialize: (data) => superjson.stringify(data),
  deserialize: (data) => superjson.parse(data),
});

interface TRPCReactProviderProps {
  children: ReactNode;
}

export const trpc = createTRPCClient<AppRouter>({
  links: [
    loggerLink({
      enabled: (op) =>
        process.env.NEXT_PUBLIC_ENV === "development" ||
        (op.direction === "down" && op.result instanceof Error),
      logger: (op) => {
        if (op.direction === "down" && op.result instanceof Error) {
          const isNetworkError =
            op.result.message.includes("fetch") ||
            op.result.message.includes("network") ||
            op.result.message.includes("NetworkError") ||
            op.result.message.includes("Failed to fetch") ||
            op.result.name === "NetworkError" ||
            op.result.name === "TypeError";

          if (isNetworkError) {
            console.error("[tRPC Client] Network error", {
              type: op.type,
              path: op.path,
              id: op.id,
              errorMessage: op.result.message,
              errorName: op.result.name,
              errorStack: op.result.stack,
              errorType: "network",
            });
          }
        }
      },
    }),
    httpBatchStreamLink({
      transformer: superjson,
      url: getUrl(),
      methodOverride: "POST",
      headers: () => {
        const headers = new Headers();
        headers.set("x-trpc-source", "nextjs-react");

        return headers;
      },
    }),
  ],
});

export function TRPCReactProvider(props: Readonly<TRPCReactProviderProps>) {
  // NOTE: Avoid useState when initializing the query client if you don't
  //       have a suspense boundary between this and the code that may
  //       suspend because React will throw away the client on the initial
  //       render if it suspends and there is no boundary
  const queryClient = getQueryClient();

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NEXT_PUBLIC_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
          logger: (op) => {
            if (op.direction === "down" && op.result instanceof Error) {
              const isNetworkError =
                op.result.message.includes("fetch") ||
                op.result.message.includes("network") ||
                op.result.message.includes("NetworkError") ||
                op.result.message.includes("Failed to fetch") ||
                op.result.name === "NetworkError" ||
                op.result.name === "TypeError";

              if (isNetworkError) {
                console.error("[tRPC Client] Network error", {
                  type: op.type,
                  path: op.path,
                  id: op.id,
                  errorMessage: op.result.message,
                  errorName: op.result.name,
                  errorStack: op.result.stack,
                  errorType: "network",
                });
              }
            }
          },
        }),
        httpBatchStreamLink({
          transformer: superjson,
          url: getUrl(),
          methodOverride: "POST",
          headers: () => {
            const headers = new Headers();
            headers.set("x-trpc-source", "nextjs-react");

            return headers;
          },
        }),
      ],
    }),
  );

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister }}
    >
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {props.children}
      </TRPCProvider>
    </PersistQueryClientProvider>
  );
}
