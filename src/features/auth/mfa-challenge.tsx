"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { hardNavigate } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/client";

/** Second step of the sign-in for users with an authenticator app: aal1 -> aal2, then a full reload to `next`. */
export function MfaChallenge({ next }: { next: string }) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();

  const verify = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const supabase = createClient();
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      const factor = factors?.totp[0];
      if (listError || !factor) {
        toast({ type: "error", title: "Não foi possível carregar o autenticador. Entre de novo." });
        return;
      }
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
      if (error) {
        setCode("");
        return toast({ type: "error", title: "Código inválido ou expirado", body: "Use o código atual do app." });
      }
      hardNavigate(next);
    });
  };

  const signOut = () =>
    startTransition(async () => {
      await createClient().auth.signOut();
      hardNavigate("/entrar");
    });

  return (
    <form noValidate className="space-y-4" onSubmit={verify}>
      <Field label="Código de 6 dígitos" hint="Do seu app autenticador (Google Authenticator, 1Password, Authy...)">
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
      </Field>
      <Button type="submit" className="w-full" loading={pending} disabled={code.length !== 6}>
        Verificar
      </Button>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Perdeu o acesso ao app?{" "}
        <button type="button" className="underline" onClick={signOut}>
          Sair
        </button>{" "}
        e fale com o suporte.
      </p>
    </form>
  );
}
