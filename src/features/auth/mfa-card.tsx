"use client";

import { useQuery } from "@tanstack/react-query";
import { useState, useTransition } from "react";
import { useToast } from "@/components/toast";
import { Turnstile, turnstileEnabled } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge, Card, Skeleton } from "@/components/ui/misc";
import { hardNavigate } from "@/lib/navigation";
import { queryKeys } from "@/lib/query-keys";
import { createClient } from "@/lib/supabase/client";
import { startMfaEnrollment } from "./actions";

type Status = { step: "off" } | { step: "verify"; factorId: string } | { step: "on"; factorId: string };
type Enrollment = { factorId: string; qr: string; secret: string };
type State = { step: "loading" } | { step: "error" } | Status | ({ step: "enrolling" } & Enrollment);

/** Verified TOTP factor and the assurance level of this session. */
async function loadStatus(): Promise<Status> {
  const supabase = createClient();
  const [factors, level] = await Promise.all([
    supabase.auth.mfa.listFactors(),
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
  ]);
  if (factors.error) throw factors.error;
  if (level.error) throw level.error;
  const verified = factors.data.totp[0];
  if (!verified) return { step: "off" };
  return level.data.currentLevel === "aal2"
    ? { step: "on", factorId: verified.id }
    : { step: "verify", factorId: verified.id };
}

const toDataUrl = (qr: string) => (qr.startsWith("data:") ? qr : `data:image/svg+xml;utf-8,${encodeURIComponent(qr)}`);

/**
 * Two-step verification with an authenticator app (TOTP, Supabase Auth MFA). Enroll (QR code + first code),
 * verify on a new session (aal1 -> aal2) and disable. /admin requires aal2 when ADMIN_REQUIRE_MFA is on;
 * `next` is where to go after a successful verification.
 */
export function MfaCard({ next }: { next?: string }) {
  const toast = useToast();
  const status = useQuery({ queryKey: queryKeys.mfa, queryFn: loadStatus, staleTime: 0, retry: 1 });
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [password, setPassword] = useState("");
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);
  const [pending, startTransition] = useTransition();
  const state: State = enrollment
    ? { step: "enrolling", ...enrollment }
    : status.isPending
      ? { step: "loading" }
      : status.isError
        ? { step: "error" }
        : status.data;

  /** The server re-checks the password before creating the factor (startMfaEnrollment). */
  const enroll = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return toast({ type: "warning", title: "Informe sua senha" });
    if (turnstileEnabled && !captcha) return toast({ type: "warning", title: "Confirme que você não é um robô" });
    startTransition(async () => {
      try {
        const result = await startMfaEnrollment({ password }, captcha ?? undefined);
        setCaptchaKey((k) => k + 1);
        if (!result.ok) return toast({ type: "error", title: result.error });
        setPassword("");
        setCode("");
        setEnrollment({ ...result.data, qr: toDataUrl(result.data.qr) });
      } catch {
        toast({ type: "error", title: "Sem conexão com o servidor", body: "Confira sua internet e tente de novo." });
      }
    });
  };

  const verify = (factorId: string) =>
    startTransition(async () => {
      const { error } = await createClient().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
      if (error)
        return toast({ type: "error", title: "Código inválido ou expirado", body: "Use o código atual do app." });
      toast({ type: "success", title: "Verificação em duas etapas confirmada" });
      // Full reload: the server must see the upgraded (aal2) session cookie.
      hardNavigate(next ?? "/painel/seguranca");
    });

  const disable = (factorId: string) =>
    startTransition(async () => {
      const { error } = await createClient().auth.mfa.unenroll({ factorId });
      setConfirmOff(false);
      if (error) return toast({ type: "error", title: "Não foi possível desativar", body: error.message });
      toast({ type: "success", title: "Verificação em duas etapas desativada" });
      hardNavigate("/painel/seguranca");
    });

  const codeField = (
    <Field label="Código de 6 dígitos" hint="Do app autenticador (Google Authenticator, 1Password, Authy...)">
      <Input
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        className="w-40"
      />
    </Field>
  );

  return (
    <Card title="Verificação em duas etapas">
      {state.step === "loading" && <Skeleton className="h-16 w-full" />}
      {state.step === "error" && (
        <div className="space-y-2 text-sm">
          <p>Não foi possível carregar a configuração.</p>
          <Button size="sm" variant="secondary" onClick={() => void status.refetch()}>
            Tentar de novo
          </Button>
        </div>
      )}
      {state.step === "off" && (
        <form noValidate className="space-y-3 text-sm" onSubmit={enroll}>
          <p>
            Proteja a conta com um código do app autenticador além da senha. <Badge tone="warning">Desativada</Badge>
          </p>
          <Field label="Confirme sua senha para ativar">
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Turnstile onToken={setCaptcha} resetKey={captchaKey} />
          <Button type="submit" size="sm" loading={pending}>
            Ativar
          </Button>
        </form>
      )}
      {state.step === "enrolling" && (
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            verify(state.factorId);
          }}
        >
          <p>1. Escaneie o QR code com o app autenticador.</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated by Supabase Auth */}
          <img src={state.qr} alt="QR code para o app autenticador" width={180} height={180} className="bg-white p-2" />
          <p className="break-all text-neutral-500">
            Sem câmera? Digite a chave: <code>{state.secret}</code>
          </p>
          <p>2. Digite o código que aparece no app.</p>
          {codeField}
          <Button type="submit" size="sm" loading={pending} disabled={code.length !== 6}>
            Confirmar e ativar
          </Button>
        </form>
      )}
      {state.step === "verify" && (
        <form
          className="space-y-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            verify(state.factorId);
          }}
        >
          <p>Esta sessão ainda não confirmou o segundo fator. Digite o código do app para continuar.</p>
          {codeField}
          <Button type="submit" size="sm" loading={pending} disabled={code.length !== 6}>
            Verificar
          </Button>
        </form>
      )}
      {state.step === "on" && (
        <div className="space-y-3 text-sm">
          <p>
            Ativa nesta conta. <Badge tone="success">Protegida</Badge>
          </p>
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirmOff(true)}>
            Desativar
          </Button>
          <Dialog
            open={confirmOff}
            onClose={() => setConfirmOff(false)}
            title="Desativar a verificação em duas etapas?"
          >
            <p className="text-sm">A conta volta a depender só da senha. Administradores perdem o acesso a /admin.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setConfirmOff(false)}>
                Cancelar
              </Button>
              <Button variant="danger" size="sm" loading={pending} onClick={() => disable(state.factorId)}>
                Desativar
              </Button>
            </div>
          </Dialog>
        </div>
      )}
    </Card>
  );
}
