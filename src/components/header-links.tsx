import Link from "next/link";
import { buttonVariants } from "./ui/button";

export const HeaderPlaceholder = () => <div className="h-8 w-40" aria-hidden="true" />;

export function SignedOutLinks() {
  return (
    <>
      <Link href="/entrar" className={buttonVariants({ variant: "ghost", size: "sm" })}>
        Entrar
      </Link>
      <Link href="/cadastro" className={buttonVariants({ size: "sm" })}>
        Criar conta
      </Link>
    </>
  );
}
