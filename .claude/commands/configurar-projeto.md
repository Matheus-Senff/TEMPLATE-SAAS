---
description: Configura um projeto recém-criado a partir do Template SaaS (identidade, Supabase, Vercel, Cloudflare, Resend, Sentry, Stripe)
argument-hint: "<nome do projeto> [objetivo em uma frase]"
---

Projeto: $ARGUMENTS

0. **Tipo de projeto** (pergunte se não estiver claro):
   - **Sistema/SaaS** (padrão): mantém tudo.
   - **Site institucional sem login**: remova `src/app/(auth)`, `src/app/auth`, `src/app/painel`, `src/app/admin`, `src/features/{auth,account,admin,billing,files,notifications}`, `src/components/header-auth.tsx` (troque por links do site) e as rotas de `PRIVATE` no `src/proxy.ts`; mantenha Supabase só se houver formulário/conteúdo no banco (o contato usa o rate limit do Postgres). Rode lint, typecheck, test e build depois.
   - **Nível de movimento** (estático, animado ou 3D): registre no `CLAUDE.md` do projeto; animado/3D usa o agente `motion` e a skill `motion-kit`.
1. **Identidade**: `name` no `package.json`, `src/lib/site.ts` (nome, descrição, dados da empresa para as páginas legais) e o título no `README.md`.
2. **Supabase** (agente `infra`; confirme antes de criar recursos): local com `cp supabase/.env.example supabase/.env` + `npm run db:start`; projeto de **produção** e projeto de **staging** em `sa-east-1`. Schema: migrações aplicadas pelo build de produção da Vercel (`SUPABASE_DB_URL`); no staging, Supabase Branching (recomendado) ou `SUPABASE_DB_URL=<staging> SUPABASE_DB_PUSH_CONFIRM=sim npm run db:push`; `SUPABASE_PRODUCTION_REF` em Production e Preview. Auth de cada projeto com `npm run supabase:config:diff` e `supabase:config:push` (Site URL, redirects, templates PT-BR, captcha Turnstile, MFA, `secure_password_change`, **SMTP próprio via Resend: obrigatório**, o SMTP padrão só entrega para a equipe do Supabase); nunca `supabase config push` direto. No painel: JWT Signing Keys assimétricas (padrão em projetos novos); Google em Providers se for usar (`NEXT_PUBLIC_AUTH_GOOGLE=true`). Tipos: `npm run db:types` (banco local).
3. **Variáveis**: copie `.env.example` para `.env` e peça ao usuário para colar as chaves (nunca no chat). Obrigatórias: Supabase (URL, publishable, secret) e `NEXT_PUBLIC_SITE_URL`; em produção também Turnstile (chaves reais; as de teste são recusadas), `CRON_SECRET` e `SUPABASE_DB_URL` (só no build de Production). Opcionais: Resend (necessário para e-mails do app), Stripe, Sentry, `ADMIN_REQUIRE_MFA`, `FLAG_*`.
4. **Validar**: `npm install`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`; `npm run dev` e abra `/api/health`.
5. **Vercel** (agente `infra`): um projeto ligado ao repositório; variáveis de **Production** apontando para o projeto de produção e de **Preview** para o **staging** (nunca produção); `SUPABASE_DB_URL` só em Production; domínio. Cloudflare: DNS **sem proxy (nuvem cinza)** apontando para a Vercel e Turnstile com os domínios de produção e preview (mesmo secret no `supabase:config:push`).
6. **GitHub**: o CI não precisa de secrets (o job "Banco real" usa o Supabase local). Ambiente `production`: `SUPABASE_DB_URL` + `BACKUP_PASSPHRASE` (backup, teste de restauração e fallback manual de migração) e, para backup de arquivos, `SUPABASE_S3_ENDPOINT`, `SUPABASE_S3_REGION`, `SUPABASE_S3_ACCESS_KEY_ID`, `SUPABASE_S3_SECRET_ACCESS_KEY`. Proteja o `main` exigindo o CI.
7. **Primeiro admin** (README > Primeiro administrador): a pessoa ativa o MFA em `/painel/seguranca` **ainda como membro**; depois `update public.profiles set role = 'admin' where email = '...'`. Ativar o MFA depois da promoção não libera o `/admin` (proteção contra quem roubou a senha).
8. **Relatório**: o que foi feito, o que falta o usuário fazer (checklist do README) e o próximo passo: `/planejar` com o briefing.
