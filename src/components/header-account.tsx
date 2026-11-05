"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { hardNavigate } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/client";
import { AppProviders } from "./app-providers";
import { HeaderPlaceholder, SignedOutLinks } from "./header-links";
import { Button } from "./ui/button";
import { useSession } from "./use-session";

const NotificationBell = dynamic(() => import("@/features/notifications/bell").then((m) => m.NotificationBell), {
  ssr: false,
  loading: () => <span className="inline-block h-8 w-8" aria-hidden="true" />,
});

/** Clears the session cookies and reloads, so no data from this user stays in memory (shared computers). */
async function signOut() {
  await createClient().auth.signOut();
  hardNavigate("/");
}

/** Account menu, loaded lazily by HeaderAuth only when the browser has a session cookie. */
export default function HeaderAccount() {
  const { user, loading } = useSession();
  if (loading) return <HeaderPlaceholder />;
  // Stale/expired cookie: behave like a visitor.
  if (!user) return <SignedOutLinks />;
  return (
    <AppProviders>
      <Link href="/painel" className="hover:underline">
        Painel
      </Link>
      <NotificationBell />
      <Button variant="ghost" size="sm" onClick={signOut}>
        Sair
      </Button>
    </AppProviders>
  );
}
