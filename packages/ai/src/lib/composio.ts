import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";

import { env } from "@repo/env/server";

let composioInstance: Composio<VercelProvider> | null = null;

// Only initialize Composio if API key is provided
if (env.COMPOSIO_API_KEY) {
  try {
    composioInstance = new Composio({
      apiKey: env.COMPOSIO_API_KEY,
      provider: new VercelProvider(),
    });
  } catch (error) {
    console.warn("[Composio] Failed to initialize Composio client:", error);
    composioInstance = null;
  }
} else {
  console.log("[Composio] COMPOSIO_API_KEY not provided, Composio features will be disabled");
}

// Export a getter function that returns the instance or null
export function getComposio(): Composio<VercelProvider> | null {
  return composioInstance;
}

// Export the instance directly for backward compatibility (will be null if not configured)
export const composio = composioInstance;
