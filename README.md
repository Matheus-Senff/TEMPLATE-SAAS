# Template SaaS

Template para criar sites e sistemas SaaS menores em português: **um app Next.js** com banco Postgres protegido por RLS, login com MFA, organizações (multi-tenant), cobrança, fila de jobs, notificações em tempo real, LGPD, CI e rotina de backup já prontos, além de agentes e comandos do Claude Code para construir o produto em cima dele.

## Stack

Next.js 16 (App Router, React 19, Tailwind 4) · Supabase (Postgres com RLS, Auth, Storage, Realtime) · Vercel · Resend · Cloudflare (DNS e Turnstile) · Sentry · Stripe (opcional) · TanStack Query · zod · Vitest + PGlite · Playwright

## O que vem pronto

| Área | Onde |
|---|---|
| Login (e-mail e senha, Google opcional, confirmação com botão, recuperação, captcha Turnstile, e-mails em PT-BR) | `src/features/auth`, `src/app/(auth)`, `src/app/auth`, `supabase/templates` |
| Segurança da conta (trocar senha com a atual, MFA TOTP, encerrar outras sessões) | `/painel/seguranca` |
| Organizações (pessoal automática, membros, papéis, convites) e cobrança por organização | `src/features/organizations`, `/convite` |
| Painel administrativo (usuários, papéis, jobs com falha; exige MFA) | `/admin`, `src/features/admin` |
| Banco com RLS em todas as tabelas + testes de RLS (PGlite e Postgres real) | `supabase/migrations`, `tests/rls.test.ts` |
| Notificações em tempo real (Broadcast privado, sininho, toasts, e-mail opcional) | `src/lib/notifications.ts`, `src/features/notifications` |
| Fila de jobs durável (e-mails e integrações com retentativa) | `src/lib/jobs`, `/api/cron/jobs` |
| Arquivos privados por usuário (cota em bytes e em quantidade) | bucket `user-files`, `src/features/files` |
| Pagamentos Stripe (checkout sem duplicidade, portal, webhook idempotente, planos) | `src/features/billing`, `src/app/api/stripe/webhook` |
| Formulário de contato (Turnstile, rate limit, e-mail pela fila) | `src/features/contact`, `/contato` |
| LGPD (exportar e excluir dados, retenção, páginas legais) | `src/features/account`, `/privacidade`, `/termos` |
| Rate limit no Postgres, auditoria, retenção diária, feature flags | `src/lib/rate-limit.ts`, `src/lib/audit.ts`, `/api/cron/cleanup`, `src/lib/flags.ts` |
| Componentes, formulários com zod, movimento (Reveal, reduced motion, receitas GSAP/Lenis/R3F) | `src/components`, `.claude/skills/motion-kit` |
| SEO, headers de segurança + CSP, Sentry, Vercel Analytics | `src/app/layout.tsx`, `next.config.ts`, `src/lib/csp.ts` |
| CI (lint, testes, build, E2E, Supabase real), migração no build, backup diário + teste de restauração, Dependabot | `.github/`, `scripts/` |

## Como usar

### 1. Criar o projeto

No GitHub: **Use this template > Create a new repository**. Abra o repositório novo no Claude Code e rode `/configurar-projeto <nome>`; depois `/planejar` com o briefing do produto. Sem o Claude Code, ajuste à mão `name` no `package.json`, `src/lib/site.ts` (nome, descrição e dados da empresa usados nas páginas legais) e o título deste README.

### 2. Rodar localmente

Requisitos: Node 22+ e Docker (ou Podman). O Supabase local roda em containers e não toca em nenhum projeto remoto.

```bash
npm install
cp supabase/.env.example supabase/.env   # segredo de teste do Turnstile para o captcha do Supabase local
npm run db:start                         # sobe o Supabase local e aplica as migrações + seed
npx supabase status                      # copie API URL, publishable/anon key e secret/service_role key
cp .env.example .env                     # cole as chaves acima; o Turnstile já vem com as chaves de teste
npm run dev                              # http://localhost:3000 (e-mails de teste em http://127.0.0.1:54324)
```

Banco do zero: `npm run db:reset`. Depois de mudar o banco: `npm run db:types`.

### 3. Configurar os serviços

1. **Supabase**: crie um projeto de produção (ex.: `sa-east-1`) e outro de staging. Ative as chaves JWT assimétricas (padrão em projetos novos). Envie a configuração do Auth **pelo script**, nunca com `supabase config push` direto (ele enviaria `localhost` como Site URL):
   ```bash
   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=<ref> SUPABASE_AUTH_SITE_URL=https://seu-dominio \
   SUPABASE_AUTH_CAPTCHA_SECRET=<secret do Turnstile> RESEND_API_KEY=re_... SMTP_SENDER_EMAIL=no-reply@seu-dominio \
   npm run supabase:config:diff   # confira e depois: npm run supabase:config:push
   ```
   O script envia templates de e-mail em PT-BR, captcha (Turnstile), MFA TOTP, `secure_password_change`, senha mínima, rate limits, URLs de redirect e **SMTP próprio via Resend, que é obrigatório**: o SMTP padrão do Supabase só entrega e-mails para membros da equipe do projeto.
2. **Resend**: verifique o domínio (SPF, DKIM, DMARC) e use-o em `EMAIL_FROM` e `SMTP_SENDER_EMAIL`.
3. **Cloudflare**: Turnstile com os domínios de produção e de preview. No DNS, os registros que apontam para a Vercel ficam **"DNS only" (nuvem cinza)**: com o proxy ligado, toda requisição chega à Vercel com o IP do Cloudflare, os visitantes passam a dividir o mesmo rate limit e a auditoria registra IPs errados (o app só confia no IP do cliente na Vercel, `src/lib/request.ts`).
4. **Vercel**: um projeto ligado ao repositório, com as variáveis da tabela abaixo em Production e Preview. Cada deploy de produção roda `npm run build`, que aplica as migrações (`scripts/build.mjs`) antes do `next build`: se a migração falhar, o deploy falha e a versão anterior continua no ar. Fallback manual: Actions > CI/CD > Run workflow com "migrate".
5. **GitHub**: proteja a `main` exigindo o CI (não precisa de secrets). No ambiente `production`, cadastre os secrets do backup (seção Backup).
6. **Primeiro administrador**: veja a seção abaixo.
7. Rode `/pre-deploy` antes de publicar.

### 4. Staging (previews sem tocar em produção)

- Projeto Supabase separado, configurado com `npm run supabase:config:push` usando o `SUPABASE_PROJECT_REF` dele, o `SUPABASE_AUTH_SITE_URL` do staging e `SUPABASE_AUTH_REDIRECT_URLS=https://<staging>/**,https://*-<time>.vercel.app/**`.
- Na Vercel, as variáveis do ambiente **Preview** apontam para esse projeto (URL, chaves, `NEXT_PUBLIC_SITE_URL`, Stripe em modo teste).
- Migrações no staging: **Supabase Branching** (um banco por PR, recomendado) ou à mão a partir da `main`: `SUPABASE_DB_URL=<staging> SUPABASE_DB_PUSH_CONFIRM=sim npm run db:push`.
- Opcional: `SUPABASE_MIGRATE_PREVIEW=true` + `SUPABASE_STAGING_DB_URL` (+ `SUPABASE_PRODUCTION_REF`) no Preview fazem cada preview migrar o staging. Use só com um PR de banco aberto por vez: a migração de um PR fica no banco e o `db push` das outras branches falha. O build recusa migrar o projeto de produção ou um projeto diferente do `NEXT_PUBLIC_SUPABASE_URL`.

### 5. Backup e restauração

- **Automático**: o Supabase Pro guarda backups diários (7 dias; PITR opcional). Além disso, `.github/workflows/backup.yml` gera todo dia uma cópia criptografada (GPG AES256, 30 dias como artefato do GitHub) do banco (`public`, `auth`, `storage` + contagem de linhas) e, com as chaves S3 do Storage, de todos os buckets. Secrets no ambiente `production`: `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` e, para arquivos, `SUPABASE_S3_ENDPOINT`, `SUPABASE_S3_REGION`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`. Com muitos arquivos, troque o destino por um bucket S3/R2 próprio.
- **Teste semanal**: `.github/workflows/restore-drill.yml` restaura o último backup num Postgres descartável dentro do runner e compara as contagens (falha = e-mail do GitHub). Nunca toca em produção.
- **Restaurar (nunca por cima da produção)**: prefira o backup do próprio Supabase (Database > Backups ou PITR). Para usar a cópia do GitHub:
  1. Crie um **projeto Supabase novo** (mesma região) e aplique o schema: `SUPABASE_DB_URL=<URI do projeto novo> SUPABASE_DB_PUSH_CONFIRM=sim npm run db:push`.
  2. Baixe o artefato `backup-<run>` (Actions > Backup) e descriptografe: `gpg -d backup.tar.gpg | tar -xf -` (gera `backup.dump` e `counts.json`).
  3. Restaure **só os dados**, com os triggers desligados (senão o cadastro recria perfis): `pg_restore --data-only --no-owner --no-privileges -f dados.sql backup.dump` e `psql "<URI do projeto novo>" -v ON_ERROR_STOP=1 -c "set session_replication_role = replica" -f dados.sql` (cliente PostgreSQL 18).
  4. Arquivos: `mkdir storage && gpg -d storage.tar.gpg | tar -xf - -C storage` e envie cada bucket com `aws s3 sync storage/<bucket> s3://<bucket> --endpoint-url <endpoint S3 do projeto novo>`.
  5. Confira as contagens de `counts.json`, um login e um download; rode `npm run supabase:config:push` para o projeto novo.
  6. Troque as variáveis da Vercel (Production) para o projeto novo e faça redeploy. Mantenha o projeto antigo parado para análise.

### 6. Primeiro administrador (fora do app, de propósito)

O `/admin` exige verificação em duas etapas (TOTP) **criada antes** de a conta virar admin (`profiles.admin_since`, `public.admin_mfa_trusted()`). Assim, quem descobrir a senha de um admin não consegue cadastrar o próprio autenticador e entrar: um fator criado depois da promoção bloqueia o `/admin` até o responsável técnico aprovar de novo.

1. A pessoa cria a conta e, ainda como membro, ativa a verificação em duas etapas em `/painel/seguranca`.
2. No SQL Editor, confira que existe um fator verificado: `select status, created_at from auth.mfa_factors where user_id = (select id from auth.users where email = '...');`
3. Promova: `update public.profiles set role = 'admin' where email = '...';` (o trigger grava `admin_since`).
4. Próximos admins: promovidos pelo `/admin`, que só aceita quem já tem o fator.
5. Admin trocou de celular/fator: rebaixe (`role = 'member'`), a pessoa recadastra o fator e é promovida de novo.

Qualquer usuário com fator verificado precisa do código em todo login (`/dois-fatores`); sem ele, páginas, actions e a API (política restritiva `mfa: aal2 when enrolled`) recusam a sessão só com senha.

### Checklist antes do primeiro deploy

- [ ] `npm run supabase:config:push` nos projetos de produção e de staging (templates, SMTP via Resend, captcha, MFA, URLs de redirect)
- [ ] Variáveis da Vercel em Production e Preview; `SUPABASE_DB_URL` só em Production
- [ ] Turnstile com os domínios de produção e preview; Cloudflare em "DNS only"
- [ ] Domínio do Resend verificado; `EMAIL_FROM` com esse domínio
- [ ] Secrets do GitHub (ambiente `production`): `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE` (+ chaves S3 do Storage)
- [ ] Primeiro admin com MFA ativado **antes** da promoção
- [ ] Opcional: `supabase/snippets/agendar-jobs-pg-cron.sql` para processar jobs a cada minuto

## Scripts

| Script | Faz |
|---|---|
| `npm run dev` / `start` | App em `localhost:3000` |
| `npm run build` | `next build`; no build de **produção** da Vercel aplica as migrações antes |
| `npm run lint` / `format` / `format:check` / `typecheck` | Qualidade |
| `npm test` | Testes de RLS (Postgres em memória) e de servidor; `npm run test:rls:real` usa um Postgres real (`RLS_TEST_DB_URL`) |
| `npm run test:e2e` | Playwright (HTTP sempre; jornada completa da conta com o Supabase local) |
| `npm run db:start` / `db:stop` / `db:reset` | Supabase local (Docker) |
| `npm run db:new <nome>` | Nova migração |
| `npm run db:types` / `db:types:check` | Gera os tipos do banco local / confere se o arquivo bate com o banco |
| `npm run db:push` | Push manual para um banco remoto; exige `SUPABASE_DB_PUSH_CONFIRM=sim` e `SUPABASE_DB_URL` |
| `npm run supabase:config:push` / `supabase:config:diff` | Envia/compara a configuração do Auth com um projeto remoto |

## Variáveis de ambiente

Todas estão documentadas no `.env.example` (validação em `src/lib/env.ts`). Por ambiente da Vercel:

| Variável | Production | Preview (staging) | Observação |
|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | domínio real | domínio de staging | obrigatória em produção |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` | projeto de produção | projeto de **staging** | preview nunca aponta para produção |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | chaves reais | chaves reais | produção recusa subir sem elas ou com chaves de teste (ou use `TURNSTILE_DISABLED=true`) |
| `CRON_SECRET` | obrigatória | opcional | também libera os detalhes de `/api/health` |
| `ADMIN_REQUIRE_MFA` | vazio (= `true`) | vazio (= `true`) | `false` desliga o MFA obrigatório do `/admin` |
| `SUPABASE_DB_URL` | URI do banco de produção (Session pooler, porta 5432) | **nunca** | usada só no build, mas a Vercel a expõe também em runtime: senha forte e rotacionada |
| `SUPABASE_PRODUCTION_REF` | ref do projeto de produção | ref do projeto de produção | o build recusa migrar esse projeto a partir de um preview |
| `SUPABASE_MIGRATE_PREVIEW`, `SUPABASE_STAGING_DB_URL` | — | opcional: `true` + URI do **staging** | ver Staging |
| `NEXT_PUBLIC_AUTH_GOOGLE` | opcional | opcional | mostra o botão do Google (ative o provider no Supabase) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `CONTACT_EMAIL` | sim | sim | e-mails do app (fila de jobs) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_IDS`, `NEXT_PUBLIC_STRIPE_PRICE_ID` | chaves live | chaves test | opcional; `STRIPE_PRICE_IDS` obrigatória em produção com Stripe |
| `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | sim | sim | opcional; o ambiente no Sentry vem de `VERCEL_ENV` |
| `FLAG_<CHAVE>` | opcional | opcional | padrão das feature flags por ambiente |

## Estrutura

```
.claude/              agentes, comandos e skill do Claude Code
.github/              CI, backup diário, teste de restauração, Dependabot
e2e/                  testes Playwright
scripts/              build com migração, push manual, config do Auth, checagem de tipos, restauração
src/app/              rotas (App Router): públicas, (auth), painel, admin, api
src/components/       componentes compartilhados (ui/, motion/, cabeçalho, toasts)
src/features/<nome>/  funcionalidades: schema.ts, actions.ts, service.ts e componentes
src/lib/              auth, Supabase (clientes e tipos), env, jobs, notificações, rate limit, CSP, flags
supabase/             config.toml, migrations/, templates/ de e-mail, seed.sql, snippets/
tests/                Vitest: RLS (PGlite ou Postgres real), servidor, segurança, scripts
```

## Agentes e comandos do Claude Code

O `CLAUDE.md` traz as regras do projeto (RLS, multi-tenant, jobs, webhooks, MFA, CSP) e o checklist de entrega. Em `.claude/`:

- **Agentes**: `arquiteto`, `backend`, `frontend`, `motion`, `autenticacao`, `conteudo`, `pagamentos`, `automacao`, `qa`, `infra`, `seguranca`, `desempenho`, `debug`.
- **Comandos**: `/configurar-projeto`, `/planejar`, `/nova-funcionalidade`, `/seo`, `/atualizar-deps`, `/auditoria-seguranca`, `/auditoria-desempenho`, `/auditoria-completa`, `/debug`, `/pre-deploy`.
- **Skill**: `motion-kit` (scroll animado, parallax, 3D e transições).

Fluxo sugerido: `/configurar-projeto` → `/planejar` → `/nova-funcionalidade` por item do backlog → `/pre-deploy`.

## Licença

[MIT](LICENSE)
