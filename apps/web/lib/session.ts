import { cache } from "react";
import { headers } from "next/headers";
import { isSignedIn } from "@gigpilot/auth";

/**
 * Per-request session lookup, resolved on the server so the first HTML byte
 * already carries the right navigation state (no client-side auth flash).
 * `cache` dedupes the lookup between the header, hero and final CTA.
 */
export const getViewer = cache(async (): Promise<{ signedIn: boolean }> => {
  const session = await isSignedIn(await headers());
  return { signedIn: session.signedIn };
});
