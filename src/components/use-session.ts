"use client";

import type { User } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";

type SessionState = { user: User | null; loading: boolean };

const LOADING: SessionState = { user: null, loading: true };
let current: SessionState = LOADING;
const listeners = new Set<() => void>();
let started = false;

/** One auth listener for the whole tab, started by the first component that asks for the session. */
function subscribe(listener: () => void) {
  if (!started) {
    started = true;
    createClient().auth.onAuthStateChange((_event, session) => {
      current = { user: session?.user ?? null, loading: false };
      listeners.forEach((notify) => notify());
    });
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Signed-in user in the browser (from the session cookie, kept in sync with sign-in/out). No provider needed:
 * only components that call it load supabase-js, so public pages stay light.
 * Use for UI only; authorization happens on the server (requireUser) and in RLS.
 */
export function useSession(): SessionState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => LOADING,
  );
}
