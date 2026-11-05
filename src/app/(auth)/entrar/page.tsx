import type { Metadata } from "next";
import { SignInForm } from "@/features/auth/forms";

export const metadata: Metadata = { title: "Entrar", robots: { index: false } };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; erro?: string }>;
}) {
  const { next, erro } = await searchParams;
  return (
    <>
      <h1 className="text-2xl font-bold">Entrar</h1>
      {erro === "link" && <p className="text-sm text-red-600">Link inválido ou expirado. Tente novamente.</p>}
      <SignInForm next={next} />
    </>
  );
}
