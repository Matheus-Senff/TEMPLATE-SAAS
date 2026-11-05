import Link from "next/link";
import { Reveal } from "@/components/motion/reveal";
import { buttonVariants } from "@/components/ui/button";

const stack = [
  ["Next.js", "Site e sistema num app só"],
  ["Supabase", "Banco, login, arquivos e tempo real com RLS"],
  ["Vercel", "Hospedagem e cron"],
  ["Resend", "E-mails"],
  ["Cloudflare", "DNS e anti-bot (Turnstile)"],
  ["Sentry", "Erros em produção"],
  ["Stripe", "Pagamentos (opcional)"],
] as const;

export default function HomePage() {
  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <h1 className="text-3xl font-bold tracking-tight">Seu próximo projeto começa aqui</h1>
        <p className="max-w-2xl text-neutral-600 dark:text-neutral-400">
          Login, banco com RLS, arquivos, notificações e pagamentos já ligados. Troque este texto pela proposta do seu
          produto.
        </p>
        <Link href="/painel" className={buttonVariants()}>
          Abrir o painel
        </Link>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {stack.map(([name, role], index) => (
          <Reveal
            as="li"
            key={name}
            delay={index * 80}
            className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <p className="font-medium">{name}</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{role}</p>
          </Reveal>
        ))}
      </ul>
    </section>
  );
}
