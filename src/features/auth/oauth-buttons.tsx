"use client";

import { useState } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";

const GOOGLE = process.env.NEXT_PUBLIC_AUTH_GOOGLE === "true";

/**
 * Social login (OAuth/PKCE through /auth/callback). Enable the provider in Supabase > Authentication > Providers
 * and set NEXT_PUBLIC_AUTH_GOOGLE=true. Renders nothing while no provider is enabled. The Supabase client is
 * loaded only on click, so the login and sign-up pages do not ship it.
 */
export function OAuthButtons({ next = "/painel" }: { next?: string }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  if (!GOOGLE) return null;

  async function google() {
    setPending(true);
    const { createClient } = await import("@/lib/supabase/client");
    const { error } = await createClient().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (error) {
      setPending(false);
      toast({ type: "error", title: "Não foi possível entrar com o Google" });
    }
  }

  return (
    <div className="space-y-4">
      <Button variant="secondary" className="w-full" loading={pending} onClick={google}>
        Continuar com Google
      </Button>
      <p className="text-center text-xs text-neutral-500 uppercase">ou</p>
    </div>
  );
}
