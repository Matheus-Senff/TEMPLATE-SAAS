---
description: Auditoria e implementação de SEO técnico e desempenho de páginas públicas
argument-hint: "[rotas públicas opcionais]"
---

Escopo: "$ARGUMENTS" (se vazio, todas as páginas públicas do app).

Verifique e, com o agente `frontend`, implemente o que faltar:

1. `metadata` por página (título único, descrição, `alternates.canonical`) e `metadataBase` no `app/layout.tsx`.
2. Open Graph e Twitter Card (`opengraph-image` padrão), favicon e `manifest.ts`.
3. `app/sitemap.ts` (só rotas públicas de `publicRoutes` em `src/lib/site.ts`) e `app/robots.ts` bloqueando as rotas privadas e de conta: `/painel`, `/admin`, `/entrar`, `/cadastro`, `/recuperar-senha`, `/redefinir-senha`, `/convite`, `/auth`, `/api`, `/monitoring`.
4. Dados estruturados JSON-LD adequados ao nicho (Organization, LocalBusiness, Product, Article, FAQ).
5. HTML semântico: um `h1` por página, hierarquia de títulos, `alt` em imagens, `lang="pt-BR"`.
6. Desempenho das páginas públicas com o agente `desempenho`: Server Components, `next/image` com `sizes`, `next/font`, páginas estáticas ou com `revalidate`.
7. Páginas privadas com `robots: { index: false }`.

Entregue tabela: Item | Status | Arquivo. Rode `npm run typecheck` e `npm run build`.
