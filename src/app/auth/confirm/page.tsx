import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/ui/submit-button";
import { confirmEmailLink } from "@/features/auth/actions";
import { isConfirmType, type ConfirmType } from "@/features/auth/schemas";

export const metadata: Metadata = { title: "Confirmar", robots: { index: false, follow: false } };

const copy: Record<ConfirmType, { title: string; text: string; button: string }> = {
  signup: { title: "Confirme seu e-mail", text: "Falta um clique para ativar sua conta.", button: "Confirmar e-mail" },
  email: { title: "Confirme seu e-mail", text: "Falta um clique para continuar.", button: "Confirmar e-mail" },
  magiclink: { title: "Entrar", text: "Clique no botão para entrar na sua conta.", button: "Entrar" },
  recovery: { title: "Redefinir senha", text: "Clique no botão para criar uma nova senha.", button: "Continuar" },
  invite: { title: "Aceitar convite", text: "Clique no botão e depois crie sua senha.", button: "Aceitar convite" },
  email_change: {
    title: "Confirmar novo e-mail",
    text: "Clique no botão para confirmar a troca.",
    button: "Confirmar",
  },
};

type Params = { token_hash?: string; type?: string; next?: string };

/**
 * Landing page of every e-mail link (supabase/templates point to /auth/confirm?token_hash=...&type=...).
 * Opening it does nothing: the one-time token is only spent when the user presses the button (POST through
 * `confirmEmailLink`), so link scanners such as Outlook Safe Links cannot consume it first.
 */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<Params> }) {
  const { token_hash: tokenHash, type, next } = await searchParams;

  if (!tokenHash || !isConfirmType(type)) {
    return (
      <section className="mx-auto max-w-sm space-y-4 py-6">
        <h1 className="text-2xl font-bold">Link inválido</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          O link está incompleto ou expirou. Peça um novo e-mail e use o link mais recente.
        </p>
        <Link href="/entrar" className="text-sm underline">
          Voltar para o login
        </Link>
      </section>
    );
  }

  const text = copy[type];
  return (
    <section className="mx-auto max-w-sm space-y-6 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">{text.title}</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{text.text}</p>
      </div>
      <form action={confirmEmailLink}>
        <input type="hidden" name="token_hash" value={tokenHash} />
        <input type="hidden" name="type" value={type} />
        {next && <input type="hidden" name="next" value={next} />}
        <SubmitButton className="w-full">{text.button}</SubmitButton>
      </form>
    </section>
  );
}
