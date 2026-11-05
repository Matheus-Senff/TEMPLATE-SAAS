import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "@/components/ui/submit-button";
import { acceptInvitation } from "@/features/organizations/actions";
import { describeInvitation } from "@/features/organizations/service";
import { requireUser } from "@/lib/auth";

export const metadata: Metadata = { title: "Convite", robots: { index: false, follow: false } };

/**
 * Invitation link (e-mail from inviteMember). Opening it changes nothing; the button accepts (POST).
 */
export default async function InvitationPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const user = await requireUser(`/convite?token=${encodeURIComponent(token)}`);
  const invitation = await describeInvitation(token, user.email);

  return (
    <section className="mx-auto max-w-sm space-y-6 py-6">
      {invitation ? (
        <>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">Aceitar convite</h1>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Você foi convidado(a) para {invitation.orgName}.
            </p>
          </div>
          <form action={acceptInvitation}>
            <input type="hidden" name="token" value={token} />
            <SubmitButton className="w-full">Aceitar</SubmitButton>
          </form>
        </>
      ) : (
        <>
          <h1 className="text-2xl font-bold">Convite inválido</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            O link expirou, já foi usado ou foi enviado para outro e-mail (você entrou como {user.email}).
          </p>
          <Link href="/painel" className="text-sm underline">
            Ir para o painel
          </Link>
        </>
      )}
    </section>
  );
}
