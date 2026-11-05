---
description: Atualiza dependências com segurança (Dependabot, npm outdated, breaking changes, testes)
---

1. Liste `npm outdated` na raiz e os PRs abertos do Dependabot.
2. Rode `npm audit --omit=dev` e priorize vulnerabilidades High e Critical.
3. Atualize patch e minor em lote; majors uma por vez, lendo o changelog e listando breaking changes que afetam o código.
4. Depois de cada lote: `npm run typecheck`, `npm test` e `npm run build` (e `npm run test:e2e` se existir). Se algo quebrar, use o agente `debug`.
5. Entregue tabela: Pacote | De | Para | Tipo | Impacto | Status.
