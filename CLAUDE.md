# Instruções para o Claude neste projeto

App único Next.js 16 (App Router, React 19, Tailwind 4) + Supabase (Postgres com RLS, Auth, Storage, Realtime) + Resend + Cloudflare (DNS e Turnstile) + Sentry + Stripe opcional. Deploy: Vercel (`gru1`), Supabase em `sa-east-1`. Ambientes: local (Supabase em Docker), **staging** (projeto Supabase separado ligado ao Preview da Vercel) e produção.

## Regras

- **Migrações compatíveis (expand/contract).** Em produção a migração roda no build da Vercel (`npm run build` → `scripts/build.mjs`, `supabase db push` antes do `next build`): se falhar, o deploy falha e a versão anterior continua no ar. Mesmo assim o código antigo atende até o novo entrar: adicione colunas opcionais ou com default, publique o código que usa e só remova ou renomeie numa entrega seguinte. Nunca edite uma migração já aplicada; crie outra (timestamp maior).
- **RLS é a principal defesa.** Toda tabela nova: migração em `supabase/migrations` (`npm run db:new <nome>`) com `enable row level security`, grants explícitos (`grant select ... to authenticated`, `grant all ... to service_role`; projetos novos do Supabase não liberam tabelas automaticamente e o `config.toml` local também não), políticas por operação, índice nas colunas usadas pelas políticas e teste em `tests/rls.test.ts`. Funções nas políticas sempre dentro de `select` (`(select auth.uid())`, `(select public.is_admin())`). Depois `npm run db:types` (tipos gerados do banco **local**, `npm run db:start`).
- **Dados de negócio são da organização (multi-tenant).** Tabela nova de negócio tem `org_id uuid not null references public.organizations (id) on delete cascade` + índice, e políticas com os helpers: `using (org_id in (select public.my_org_ids()))` para membros, `(select public.my_org_ids('admin'))` para escrita de admins/donos; `public.has_org_role(org, 'admin')`/`public.is_org_member(org)` em checagens pontuais (actions, RPC). Todo usuário tem uma organização pessoal (criada no cadastro); a organização ativa vem de `getActiveOrg()` (`src/features/organizations/service.ts`). Dado realmente pessoal (arquivos, notificações) continua com `user_id`.
- Ler e escrever em nome do usuário: `createClient()` (`@/lib/supabase/server` ou `/client`). `createAdminClient()` (service role, ignora RLS) só em webhooks, cron, jobs, `notify`, `audit`, flags, convites, exportação da auditoria e exclusão de conta; nunca em componentes (o ESLint bloqueia em `.tsx`).
- Funcionalidades em `src/features/<feature>/` (`schema.ts`, `actions.ts` com `"use server"`, `service.ts`, componentes). Exemplo completo: `features/contact`. Arquivo `"use server"` só exporta funções async.
- Server Actions: `requireUser()` primeiro, zod `safeParse`, retorno `ActionResult` (`fail(...)`), erro inesperado vira `fail()` com mensagem clara + `reportError()` (nunca página de erro). Route Handlers só para webhooks, cron e integrações.
- **Identidade**: `getUser()` usa `getClaims()` (JWT verificado localmente com chaves assimétricas; sem ida à rede). Um token revogado vale até expirar (≤ 1 h): ação sensível (trocar senha, excluir conta, ativar o primeiro fator) pede a senha de novo (`verifyPassword`, `src/lib/reauth.ts`).
- **Verificação em duas etapas**: quem tem fator verificado precisa de aal2 em tudo: `requireUser()` manda sessões só com senha para `/dois-fatores` e o banco recusa com políticas restritivas. **Tabela nova com dado de usuário/organização ganha a política** `create policy "mfa: aal2 when enrolled" on <tabela> as restrictive for all to authenticated using ((select public.mfa_satisfied())) with check ((select public.mfa_satisfied()));`. `/admin` exige aal2 com fator anterior à promoção (`admin_mfa_trusted()`); primeiro admin fora do app (README).
- Abuso: `rateLimit(chave, limite, janelaSeg)` (Postgres) em login, cadastro, formulários públicos, e-mail, exportação e checkout; auth com chave por IP **e** por e-mail (`hashKey`, sem PII). O contador por e-mail só é **consultado** antes (`rateLimitPeek`) e **cobrado** depois que o Supabase aceitou o captcha (senão qualquer um bloqueia a conta de outra pessoa sem resolver captcha). Falha **fechado** por padrão; `{ failOpen: true }` só onde não há risco (documente o motivo). IP só é confiável na Vercel (`src/lib/request.ts`; Cloudflare só como DNS).
- Captcha: formulários de auth mandam o token do Turnstile para o Supabase (`options.captchaToken`; `[auth.captcha]` no `config.toml`), que valida; nunca valide o mesmo token duas vezes. Formulários públicos sem Supabase Auth usam `verifyTurnstile` (confere o hostname).
- **Trabalho em segundo plano é durável**: e-mail e integrações via `enqueue(tipo, payload)` (`src/lib/jobs`, tabela `public.jobs`): gravado antes de responder, processado logo depois (`after()`), reprocessado com backoff por `/api/cron/jobs`, "dead" após N tentativas (lista no `/admin`). Handler idempotente (use o id do job como chave). `after()` puro só para o que pode se perder. Cron: `src/app/api/cron/*` com `hasCronSecret()` + `vercel.json` (Hobby: 1x/dia; a cada minuto: `supabase/snippets/agendar-jobs-pg-cron.sql`).
- Webhooks: assinatura no corpo cru + `processOnce()`; responda 2xx só depois de processar ou gravar um job (409 enquanto outra entrega do mesmo evento roda, 5xx em erro, para o provedor tentar de novo). Evento sobre conta/organização que não existe mais: reconheça e ignore. Efeito visível em código que pode rodar duas vezes (webhook, job, cron) leva chave de idempotência: `` notify(..., { idempotencyKey: `${event.id}:${userId}` }) ``, `enqueue(..., { idempotencyKey })`. Stripe: webhook é a fonte da verdade, cobrança por organização, preços em `STRIPE_PRICE_IDS`, acesso só com pagamento compensado (`src/features/billing/plans.ts`, `public.has_active_subscription(org)`).
- Front: TanStack Query para dados (provider só nas áreas logadas: `AppProviders` nos layouts de `/painel` e `/admin`), `react-hook-form` + `zodResolver` com o mesmo schema da action, componentes de `src/components/ui`, `useToast()` em toda ação (com `try/catch` em volta da chamada da action), `useSession()` para o usuário no cliente, `Dialog` para confirmar ações destrutivas ou de permissão.
- Login, logout e exclusão de conta terminam com navegação completa (`hardNavigate`, só mesma origem). Redirecionamentos vindos do usuário passam por `safePath()` (`src/lib/redirect.ts`).
- **Páginas públicas ficam estáticas e leves**: nada de `cookies()`/`getUser()` nelas, nada de supabase-js/TanStack Query no layout raiz (o cabeçalho carrega a parte logada sob demanda), Sentry no cliente só com DSN. Página privada nova: prefixo em `PRIVATE` **e** no `matcher` de `src/proxy.ts` + `requireUser()` na página.
- Tempo real: Broadcast em canal privado (`user:<id>:...`, trigger com `realtime.send` + política em `realtime.messages`), como o sininho; evite `postgres_changes` (checa RLS por assinante a cada linha).
- CSP: lista de origens montada no build (`src/lib/csp.ts`); script, iframe ou API externa nova precisa entrar lá. Sem nonce de propósito (páginas públicas estáticas).
- Feature flags: `await isEnabled("chave")` (`src/lib/flags.ts`: tabela `feature_flags` > `FLAG_<CHAVE>` > padrão no código). Flag nunca substitui checagem de permissão.
- Variáveis novas: valide em `src/lib/env.ts` (vazio = módulo desligado; produção recusa subir sem Turnstile e `CRON_SECRET`) e documente no `.env.example`. Segredos nunca em `NEXT_PUBLIC_*`. Nunca commite `.env`. Variável só de build (ex.: `SUPABASE_DB_URL`) não entra no `env.ts` (a Vercel a expõe também em runtime: nunca `NEXT_PUBLIC_*`).
- Banco remoto: nunca rode `supabase db push`/`config push` direto. Produção migra no build; manual só com `SUPABASE_DB_PUSH_CONFIRM=sim npm run db:push`; configuração do Auth com `npm run supabase:config:push` (recusa localhost). Testes e experimentos no banco local ou no staging.
- **Idioma**: só pt-BR, sem framework de i18n (mercado brasileiro; textos direto nos componentes). Para internacionalizar depois: `next-intl` com `[locale]` no App Router, extrair os textos para `messages/pt-BR.json` e trocar strings por `t("...")`.
- Antes de entregar: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (e `npm run format`). Mudou migração: `npm run db:reset && npm run db:types:check` com o Supabase local (o CI faz isso no job "Banco real").

## Módulos prontos

- Auth: `/entrar`, `/cadastro`, `/recuperar-senha`, `/redefinir-senha` (só com sessão de link de recuperação), `/auth/callback` (OAuth), `/auth/confirm` (links de e-mail com botão: scanners não consomem o token), Google opcional (`NEXT_PUBLIC_AUTH_GOOGLE`), captcha do Supabase, e-mails em português em `supabase/templates` (inclui aviso de senha alterada); `getUser()`, `requireUser()`, `requireAdmin()` (`profiles.role` + aal2 com fator anterior à promoção), `/dois-fatores` (código TOTP no login de quem tem fator), mensagens de erro por código (`features/auth/errors.ts`).
- Segurança da conta: `/painel/seguranca` (trocar senha com a senha atual, encerra outras sessões; MFA TOTP: ativar, verificar, desativar).
- Organizações: `organizations`, `memberships` (owner/admin/member), `invitations`; organização pessoal automática; `createOrganization`, `inviteMember`, `acceptInvitation` + `/convite` em `src/features/organizations` (sem tela de equipe ainda).
- Administração: `/admin` (usuários, busca, paginação, troca de papel com confirmação e auditoria, jobs com falha) em `src/features/admin`.
- Notificações: `notify(userId, {...}, { email? })` + sininho com Realtime Broadcast + `useToast()`.
- Jobs: `enqueue()`, `runJobs()`, `/api/cron/jobs` (`src/lib/jobs`).
- Arquivos: bucket privado `user-files` (pasta por usuário, cota em bytes por usuário, limites no bucket) e `features/files`.
- Pagamentos: checkout/portal por organização, sem assinatura duplicada, volta do checkout sincronizada, webhook idempotente (`src/features/billing`).
- LGPD: `exportMyData()` (paginado, inclui auditoria e organizações) e `deleteMyAccount()` (senha, Stripe cancelado, arquivos, jobs, convites, auditoria anonimizada, usuário em cascata); IP da auditoria apagado após 180 dias; `/privacidade` e `/termos` (dados em `src/lib/site.ts`).
- Feature flags (`src/lib/flags.ts`), auditoria `audit()`, retenção diária (`/api/cron/cleanup`), `/api/health` (público só `{status}`, 503 com banco fora; detalhes com `Bearer CRON_SECRET`), SEO (metadata, sitemap, robots, imagem Open Graph, ícone, manifest), headers de segurança + CSP.
- Operação: migração no build da Vercel, CI com Supabase real (migrações, lint SQL, tipos, RLS e E2E autenticado), backup diário do banco e do Storage + teste de restauração semanal, `supabase:config:push`.
- Movimento: `Reveal`, `useReducedMotion` e tokens (`src/lib/motion.ts`); `prefers-reduced-motion` global no `globals.css`. Scroll animado, parallax, 3D e transições: agente `motion` + skill `motion-kit` (receitas de Lenis, GSAP ScrollTrigger, React Three Fiber, motion/react e checklist).

## Checklist de entrega (o que a IA costuma esquecer)

- Estados de tela: carregando, vazio (com próximo passo), erro (com ação), sucesso.
- Feedback: toast em toda ação, confirmação antes de excluir, botão com `loading`.
- Notificações: eventos importantes chamam `notify()`; críticos também e-mail (`{ email: true }`, vai pela fila).
- Painel administrativo: quem gerencia usuários, conteúdo e configurações (`requireAdmin()` + `(select public.is_admin())` nas políticas, sempre dentro de `select` para rodar uma vez por consulta e não por linha).
- Multi-tenant: tabela de negócio com `org_id` e políticas via `my_org_ids()`; teste com membro, não membro e papel insuficiente.
- Listas: busca, filtros, ordenação, paginação e exportação CSV quando útil.
- Formulários: validação no cliente e no servidor, máscaras (CPF, telefone, CEP), mensagens claras, Turnstile se público.
- Responsivo, dark mode, acessibilidade (labels, foco, contraste, teclado).
- SEO e conteúdo: `metadata` por página, Open Graph, nenhum texto provisório.
- Segurança: RLS testada, `rateLimit`, `audit()` em ações sensíveis, origem nova na CSP.
- LGPD: dados novos entram em `exportMyData`/`deleteMyAccount`.
- Operação: variáveis no `env.ts` e `.env.example`, migração expand/contract, tipos atualizados (`npm run db:types`).

## Agentes e comandos (`.claude/`)

| Agente | Papel |
|---|---|
| `arquiteto` | Briefing vira plano de MVP, tabelas com RLS e backlog (não escreve código) |
| `backend` | Migrações, RLS, Server Actions, rotas, jobs, regras com teste |
| `frontend` | Telas, componentes, formulários, layout, acessibilidade |
| `motion` | Animação, scroll storytelling, 3D/WebGL com 60 fps (skill `motion-kit`) |
| `autenticacao` | Login, OAuth, MFA, papéis, organizações/equipes, convites, sessão |
| `conteudo` | Textos reais, landing pages, microtextos, SEO on-page |
| `pagamentos` | Stripe: planos, assinaturas, Pix/boleto, webhooks, acesso por plano |
| `automacao` | Chatbots, IA, WhatsApp/Telegram, fluxos automáticos |
| `qa` | Testes de RLS, servidor e E2E, critérios de aceite |
| `infra` | Supabase, Vercel, Cloudflare, Resend, Sentry, GitHub, staging, backups |
| `seguranca` | Auditoria de segurança e LGPD (só leitura) |
| `desempenho` | Auditoria de desempenho (só leitura) |
| `debug` | Causa raiz, correção mínima e teste |

Revisão de código: `/code-review` (nativo do Claude Code). Comandos: `/configurar-projeto`, `/planejar`, `/nova-funcionalidade`, `/seo`, `/atualizar-deps`, `/auditoria-seguranca`, `/auditoria-desempenho`, `/auditoria-completa`, `/debug`, `/pre-deploy`.

Fluxo: criar o repositório com "Use this template", `/configurar-projeto`, `/planejar`, `/nova-funcionalidade` por item, `/pre-deploy` antes de publicar.
