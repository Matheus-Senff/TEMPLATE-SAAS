"use client";

import { hardNavigate } from "@/lib/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useForm, type FieldValues, type Path, type UseFormReturn } from "react-hook-form";
import type { z } from "zod";
import { useToast } from "@/components/toast";
import { Turnstile, turnstileEnabled } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ActionResult } from "@/lib/action";
import { changePassword, requestPasswordReset, signIn, signUp } from "./actions";
import { OAuthButtons } from "./oauth-buttons";
import { changePasswordSchema, newPasswordSchema, resetRequestSchema, signInSchema, signUpSchema } from "./schemas";

/**
 * Shared wiring: validation, captcha, pending state, server errors on fields and toasts. The captcha token is
 * passed to the action, which hands it to Supabase Auth (it verifies the token; never verify it twice).
 */
function useAuthForm<S extends z.ZodObject>(schema: S, defaults: z.input<S>, { captcha: useCaptcha = true } = {}) {
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    resolver: zodResolver(schema as never) as never,
    defaultValues: defaults as never,
  });
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  const submit = (
    run: (values: z.output<S>, token?: string) => Promise<ActionResult<{ redirectTo: string }> | ActionResult>,
    onOk?: () => void,
  ) =>
    form.handleSubmit((values) =>
      startTransition(async () => {
        if (useCaptcha && turnstileEnabled && !captcha) {
          toast({ type: "warning", title: "Confirme que você não é um robô" });
          return;
        }
        let result: Awaited<ReturnType<typeof run>>;
        try {
          result = await run(values, captcha ?? undefined);
        } catch {
          toast({ type: "error", title: "Sem conexão com o servidor", body: "Confira sua internet e tente de novo." });
          setResetKey((k) => k + 1);
          return;
        }
        if (result.ok) {
          const redirectTo = (result.data as { redirectTo?: string } | undefined)?.redirectTo;
          // Full page load after login: session, header and data cache start fresh for the new user.
          if (redirectTo) hardNavigate(redirectTo);
          return onOk?.();
        }
        Object.entries(result.fieldErrors ?? {}).forEach(([name, messages]) =>
          form.setError(name as Path<z.input<S>>, { message: messages?.[0] }),
        );
        toast({ type: "error", title: result.error });
        // Tokens are single use: a new one is needed for the next attempt.
        setResetKey((k) => k + 1);
      }),
    );

  return {
    form,
    pending,
    submit,
    captcha: useCaptcha ? <Turnstile onToken={setCaptcha} resetKey={resetKey} /> : null,
  };
}

const err = <T extends FieldValues>(form: UseFormReturn<T>, name: Path<T>) =>
  form.formState.errors[name]?.message as string | undefined;

export function SignInForm({ next }: { next?: string }) {
  const { form, pending, submit, captcha } = useAuthForm(signInSchema, { email: "", password: "" });
  return (
    <form noValidate className="space-y-4" onSubmit={submit((values, token) => signIn(values, token, next))}>
      <OAuthButtons next={next} />
      <Field label="E-mail" error={err(form, "email")}>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field label="Senha" error={err(form, "password")}>
        <Input type="password" autoComplete="current-password" {...form.register("password")} />
      </Field>
      {captcha}
      <Button type="submit" className="w-full" loading={pending}>
        Entrar
      </Button>
      <p className="flex justify-between text-sm">
        <Link href="/recuperar-senha" className="underline">
          Esqueci a senha
        </Link>
        <Link href="/cadastro" className="underline">
          Criar conta
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm() {
  const [done, setDone] = useState(false);
  const { form, pending, submit, captcha } = useAuthForm(signUpSchema, { fullName: "", email: "", password: "" });
  if (done) return <p className="rounded-lg border p-4 text-sm">Enviamos um link de confirmação para o seu e-mail.</p>;
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={submit(
        (values, token) => signUp(values, token),
        () => setDone(true),
      )}
    >
      <OAuthButtons />
      <Field label="Nome" error={err(form, "fullName")}>
        <Input autoComplete="name" {...form.register("fullName")} />
      </Field>
      <Field label="E-mail" error={err(form, "email")}>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      <Field label="Senha" hint="Mínimo de 8 caracteres" error={err(form, "password")}>
        <Input type="password" autoComplete="new-password" {...form.register("password")} />
      </Field>
      {captcha}
      <Button type="submit" className="w-full" loading={pending}>
        Criar conta
      </Button>
      <p className="text-sm">
        Já tem conta?{" "}
        <Link href="/entrar" className="underline">
          Entrar
        </Link>
      </p>
    </form>
  );
}

export function ResetRequestForm() {
  const [done, setDone] = useState(false);
  const { form, pending, submit, captcha } = useAuthForm(resetRequestSchema, { email: "" });
  if (done)
    return (
      <p className="rounded-lg border p-4 text-sm">
        Se o e-mail existir, você receberá um link para redefinir a senha.
      </p>
    );
  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={submit(
        (values, token) => requestPasswordReset(values, token),
        () => setDone(true),
      )}
    >
      <Field label="E-mail" error={err(form, "email")}>
        <Input type="email" autoComplete="email" {...form.register("email")} />
      </Field>
      {captcha}
      <Button type="submit" className="w-full" loading={pending}>
        Enviar link
      </Button>
    </form>
  );
}

/** Recovery/invite link: the session itself proves access to the e-mail, so only the new password is asked. */
export function NewPasswordForm() {
  const { form, pending, submit } = useAuthForm(newPasswordSchema, { password: "" }, { captcha: false });
  return (
    <form noValidate className="space-y-4" onSubmit={submit((values) => changePassword(values))}>
      <Field label="Nova senha" hint="Mínimo de 8 caracteres" error={err(form, "password")}>
        <Input type="password" autoComplete="new-password" {...form.register("password")} />
      </Field>
      <Button type="submit" className="w-full" loading={pending}>
        Salvar senha
      </Button>
    </form>
  );
}

/** Signed in normally: the current password is re-checked on the server; other devices are signed out. */
export function ChangePasswordForm() {
  const { form, pending, submit, captcha } = useAuthForm(changePasswordSchema, { currentPassword: "", password: "" });
  return (
    <form noValidate className="space-y-4" onSubmit={submit((values, token) => changePassword(values, token))}>
      <Field label="Senha atual" error={err(form, "currentPassword")}>
        <Input type="password" autoComplete="current-password" {...form.register("currentPassword")} />
      </Field>
      <Field label="Nova senha" hint="Mínimo de 8 caracteres" error={err(form, "password")}>
        <Input type="password" autoComplete="new-password" {...form.register("password")} />
      </Field>
      {captcha}
      <p className="text-xs text-neutral-500">Ao trocar a senha, os outros aparelhos conectados saem da conta.</p>
      <Button type="submit" loading={pending}>
        Alterar senha
      </Button>
    </form>
  );
}
