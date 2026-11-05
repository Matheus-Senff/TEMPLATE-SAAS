"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useToast } from "@/components/toast";
import { Turnstile, turnstileEnabled } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/misc";
import { hardNavigate } from "@/lib/navigation";
import { deleteMyAccount, exportMyData } from "./actions";

const offline = {
  type: "error",
  title: "Sem conexão com o servidor",
  body: "Confira sua internet e tente de novo.",
} as const;

/** LGPD: download everything stored about the user or delete the account (confirmed with the current password). */
export function PrivacyCard() {
  const toast = useToast();
  const [exporting, startExport] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaKey, setCaptchaKey] = useState(0);

  const exportData = () =>
    startExport(async () => {
      try {
        const result = await exportMyData();
        if (!result.ok) return toast({ type: "error", title: result.error });
        const url = URL.createObjectURL(new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" }));
        Object.assign(document.createElement("a"), { href: url, download: "meus-dados.json" }).click();
        URL.revokeObjectURL(url);
        toast({ type: "success", title: "Seus dados foram baixados" });
      } catch {
        toast(offline);
      }
    });

  const close = () => {
    setOpen(false);
    setPassword("");
    setPasswordError(undefined);
  };

  const remove = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password) return setPasswordError("Informe sua senha");
    if (turnstileEnabled && !captcha) return toast({ type: "warning", title: "Confirme que você não é um robô" });
    startDelete(async () => {
      try {
        const result = await deleteMyAccount({ password }, captcha ?? undefined);
        if (result.ok) return hardNavigate("/?conta=excluida");
        setPasswordError(result.fieldErrors?.password?.[0]);
        toast({ type: "error", title: result.error });
      } catch {
        toast(offline);
      }
      setCaptchaKey((k) => k + 1);
    });
  };

  return (
    <Card title="Meus dados">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" loading={exporting} onClick={exportData}>
          Baixar meus dados
        </Button>
        <Button variant="danger" size="sm" disabled={exporting} onClick={() => setOpen(true)}>
          Excluir conta
        </Button>
        <Link href="/painel/seguranca" className="self-center text-sm underline">
          Segurança da conta
        </Link>
      </div>
      <Dialog open={open} onClose={close} title="Excluir sua conta?">
        <form noValidate className="space-y-4" onSubmit={remove}>
          <p className="text-sm">
            Apagamos seu perfil, arquivos, notificações e assinaturas (a cobrança no cartão é cancelada). Esta ação não
            pode ser desfeita.
          </p>
          <Field label="Confirme com sua senha" error={passwordError}>
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <p className="text-xs text-neutral-500">
            Entrou com o Google e não tem senha? Crie uma em{" "}
            <Link href="/recuperar-senha" className="underline">
              Esqueci a senha
            </Link>{" "}
            e volte aqui.
          </p>
          {open && <Turnstile onToken={setCaptcha} resetKey={captchaKey} />}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={close} disabled={deleting}>
              Cancelar
            </Button>
            <Button type="submit" variant="danger" size="sm" loading={deleting}>
              Excluir definitivamente
            </Button>
          </div>
        </form>
      </Dialog>
    </Card>
  );
}
