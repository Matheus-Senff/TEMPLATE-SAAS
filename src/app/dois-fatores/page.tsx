import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MfaChallenge } from "@/features/auth/mfa-challenge";
import { isMfaSatisfied, requireUser } from "@/lib/auth";
import { safePath } from "@/lib/redirect";

export const metadata: Metadata = { title: "Verificação em duas etapas", robots: { index: false, follow: false } };

/**
 * Reached right after the password (signIn) and whenever requireUser() finds an aal1 session of a user with a
 * verified factor. Nothing else is reachable until the code is confirmed (pages, actions and RLS all check).
 */
export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const target = safePath(next);
  const user = await requireUser(`/dois-fatores?next=${encodeURIComponent(target)}`, { allowPendingMfa: true });
  if (await isMfaSatisfied(user.aal)) redirect(target);

  return (
    <section className="mx-auto max-w-sm space-y-6 py-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Verificação em duas etapas</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Digite o código do app autenticador para terminar de entrar.
        </p>
      </div>
      <MfaChallenge next={target} />
    </section>
  );
}
