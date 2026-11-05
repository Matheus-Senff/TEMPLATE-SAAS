import type { Metadata } from "next";
import { ResetRequestForm } from "@/features/auth/forms";

export const metadata: Metadata = { title: "Recuperar senha", robots: { index: false } };

export default function ResetPage() {
  return (
    <>
      <h1 className="text-2xl font-bold">Recuperar senha</h1>
      <ResetRequestForm />
    </>
  );
}
