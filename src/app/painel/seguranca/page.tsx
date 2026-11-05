import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/misc";
import { ChangePasswordForm } from "@/features/auth/forms";
import { MfaCard } from "@/features/auth/mfa-card";
import { requireUser } from "@/lib/auth";
import { safePath } from "@/lib/redirect";

export const metadata: Metadata = { title: "Segurança", robots: { index: false, follow: false } };

/** Password change (with the current password) and two-step verification (TOTP). */
export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ mfa?: string; next?: string }>;
}) {
  const user = await requireUser("/painel/seguranca");
  const { mfa, next } = await searchParams;
  const target = next ? safePath(next) : undefined;

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <Link href="/painel" className="text-sm text-neutral-500 hover:underline">
          ← Painel
        </Link>
        <h1 className="text-2xl font-bold">Segurança</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{user.email}</p>
      </div>
      {mfa === "admin-sem-fator" && (
        <p
          role="alert"
          className="rounded-lg border border-red-500 bg-red-50 p-3 text-sm dark:bg-red-950 dark:text-red-100"
        >
          A área administrativa exige verificação em duas etapas configurada antes de a conta virar administradora. Por
          segurança ela não pode ser ativada a partir de uma conta de administrador: peça ao responsável técnico para
          remover o papel de admin, ative a verificação aqui e peça a promoção de novo.
        </p>
      )}
      {mfa === "obrigatorio" && (
        <p
          role="status"
          className="rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm dark:bg-amber-950 dark:text-amber-100"
        >
          A área administrativa exige verificação em duas etapas. Ative ou confirme o código abaixo para continuar.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <MfaCard next={target} />
        <Card title="Senha">
          <ChangePasswordForm />
        </Card>
      </div>
    </section>
  );
}
