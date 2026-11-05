"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import { HeaderPlaceholder, SignedOutLinks } from "./header-links";

/** Supabase auth cookie (`sb-<project>-auth-token`, possibly split into `.0`, `.1`...). Readable by JS by design. */
const AUTH_COOKIE = /(?:^|;\s*)sb-[^=;]+-auth-token(?:\.\d+)?=/;
const noop = () => () => {};

/** null while rendering on the server (static HTML), then whether this browser has a Supabase session cookie. */
function useHasAuthCookie(): boolean | null {
  return useSyncExternalStore(
    noop,
    () => AUTH_COOKIE.test(document.cookie),
    () => null,
  );
}

// Signed-in part (supabase-js, TanStack Query, bell + Realtime): downloaded only by visitors with a session.
const HeaderAccount = dynamic(() => import("./header-account"), { ssr: false, loading: HeaderPlaceholder });

/**
 * Client-side so public pages stay static. A visitor without the auth cookie gets plain links and never
 * downloads the Supabase client; with the cookie, the account menu is loaded on demand.
 */
export function HeaderAuth() {
  const signedIn = useHasAuthCookie();
  if (signedIn === null) return <HeaderPlaceholder />;
  return signedIn ? <HeaderAccount /> : <SignedOutLinks />;
}
