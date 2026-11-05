import type { Metadata } from "next";
import { SignUpForm } from "@/features/auth/forms";

export const metadata: Metadata = { title: "Criar conta", robots: { index: false } };

export default function SignUpPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">Criar conta</h1>
      <SignUpForm />
    </>
  );
}
