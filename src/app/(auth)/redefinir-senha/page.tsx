import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NewPasswordForm } from "@/features/auth/forms";
import { isRecoverySession, requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Nova senha", robots: { index: false } };

/**
 * Reached through the recovery/invite link (session created by /auth/confirm or /auth/callback): only then the
 * new password is enough. Any other session changes the password in /painel/seguranca, with the current one.
 */
export default async function NewPasswordPage() {
  const user = await requireUser("/redefinir-senha");
  if (!isRecoverySession(user)) redirect("/painel/seguranca");
  return (
    <>
      <h1 className="text-2xl font-bold">Nova senha</h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Depois de salvar, os outros aparelhos conectados saem da conta.
      </p>
      <NewPasswordForm />
    </>
  );
}
