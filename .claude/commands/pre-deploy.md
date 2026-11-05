---
description: Checklist antes de publicar em produção (verificações, segurança, migrações e variáveis)
---

Antes de publicar:

1. Rode na raiz `npm run typecheck`, `npm test`, `npm run build` e `npm audit --omit=dev --audit-level=high`. Pare se algo falhar.
2. Confira se cada migração é compatível com o código que está no ar (expand/contract: ela roda no build, mas o código antigo atende até o deploy terminar), se nenhuma migração já aplicada foi editada, se toda mudança de banco está em `supabase/migrations` (com RLS e teste em `tests/rls.test.ts`) e se `src/lib/supabase/database.types.ts` bate com o banco (`npm run db:reset && npm run db:types:check`, ou o job "Banco real" verde no CI).
3. Use o agente `seguranca` só nos arquivos alterados desde o último deploy (`git diff --name-only origin/main...HEAD`).
4. Confira no `.env.example` se toda variável nova está documentada e lembre quais precisam ser cadastradas na Vercel (Production e Preview/staging) e no GitHub (ambiente `production`: `SUPABASE_DB_URL`, `BACKUP_PASSPHRASE`, chaves S3 do Storage).
5. Confira produção: `NEXT_PUBLIC_SITE_URL` com o domínio real; `SUPABASE_DB_URL` só em Production (migração no build) e `SUPABASE_PRODUCTION_REF` em Production e Preview; **`npm run supabase:config:diff` sem diferenças** (templates, SMTP via Resend, captcha Turnstile, MFA, Site URL e redirects; senão `supabase:config:push`); Turnstile com chaves reais e domínios cadastrados; `CRON_SECRET` na Vercel; `STRIPE_PRICE_IDS` se houver Stripe; previews apontando para o staging; Cloudflare em DNS only; primeiro admin com MFA; último `restore-drill` verde.
6. Entregue um resumo: pronto ou bloqueado, e o motivo.
