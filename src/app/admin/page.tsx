import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, EmptyState } from "@/components/ui/misc";
import { TBody, TD, TH, THead, TR, Table } from "@/components/ui/table";
import { RetryJobButton } from "@/features/admin/retry-job-button";
import { RoleSelect } from "@/features/admin/role-select";
import { ADMIN_PAGE_SIZE, listDeadJobs, listUsers } from "@/features/admin/service";
import { requireAdmin } from "@/lib/auth";

export const metadata: Metadata = { title: "Administração", robots: { index: false, follow: false } };

const dateFormat = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

/** Platform admin (profiles.role = 'admin'). First admin: set the role in Supabase > Table Editor > profiles. */
export default async function AdminPage({ searchParams }: { searchParams: Promise<{ p?: string; q?: string }> }) {
  const admin = await requireAdmin();
  const { p, q } = await searchParams;
  const page = Math.max(0, Number(p) || 0);
  const [{ users, total }, deadJobs] = await Promise.all([listUsers(page, q), listDeadJobs()]);
  const pages = Math.ceil(total / ADMIN_PAGE_SIZE);
  const href = (n: number) => `/admin?p=${n}${q ? `&q=${encodeURIComponent(q)}` : ""}`;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Usuários</h1>
        <form className="flex gap-2" role="search">
          <Input
            name="q"
            defaultValue={q}
            placeholder="Buscar por nome ou e-mail"
            aria-label="Buscar usuários"
            className="w-64"
          />
        </form>
      </div>
      {users.length === 0 ? (
        <EmptyState title="Nenhum usuário encontrado" />
      ) : (
        <Table>
          <THead>
            <TR>
              <TH>Nome</TH>
              <TH>E-mail</TH>
              <TH>Criado em</TH>
              <TH>Papel</TH>
            </TR>
          </THead>
          <TBody>
            {users.map((user) => (
              <TR key={user.id}>
                <TD>
                  {user.full_name ?? "-"} {user.id === admin.id && <Badge>você</Badge>}
                </TD>
                <TD>{user.email}</TD>
                <TD>{dateFormat.format(new Date(user.created_at))}</TD>
                <TD>
                  <RoleSelect
                    userId={user.id}
                    role={user.role}
                    name={user.full_name ?? user.email}
                    disabled={user.id === admin.id}
                  />
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-2 text-sm" aria-label="Paginação">
          {page > 0 && (
            <Link href={href(page - 1)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              Anterior
            </Link>
          )}
          <span>
            Página {page + 1} de {pages}
          </span>
          {page + 1 < pages && (
            <Link href={href(page + 1)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
              Próxima
            </Link>
          )}
        </nav>
      )}
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">Jobs com falha</h2>
        {deadJobs.length === 0 ? (
          <EmptyState title="Nenhum job com falha" description="E-mails e integrações em segundo plano estão em dia." />
        ) : (
          <Table>
            <THead>
              <TR>
                <TH>Tipo</TH>
                <TH>Tentativas</TH>
                <TH>Último erro</TH>
                <TH>Quando</TH>
                <TH />
              </TR>
            </THead>
            <TBody>
              {deadJobs.map((job) => (
                <TR key={job.id}>
                  <TD>{job.type}</TD>
                  <TD>{job.attempts}</TD>
                  <TD className="max-w-64 truncate" title={job.last_error ?? ""}>
                    {job.last_error ?? "-"}
                  </TD>
                  <TD>{dateFormat.format(new Date(job.updated_at))}</TD>
                  <TD>
                    <RetryJobButton jobId={job.id} />
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </section>
  );
}
