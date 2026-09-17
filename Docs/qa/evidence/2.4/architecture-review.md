# Story 2.4 — Revisão arquitetural

Data local: 2026-09-16. Papel: Aria / @architect, executado sequencialmente pelo mesmo agente Codex; não é uma revisão humana independente.

Revisão: `51f84424b149d0bd3deea1e7f4498bb6d987cc83`, comparada com `a86c3bc`.

## Parecer

Compatível com a arquitetura existente, sem decisão arquitetural nova ou alteração necessária de contratos. O veredito de qualidade e a transição da story pertencem a @qa.

- `packages/domain/src/navigation.ts`: função pura usa apenas dados canônicos e URL padrão; não depende de React, navegador, HTTP ou armazenamento. A mesma regra é consumida pela CLI e UI.
- `apps/cli/src/navigation-cli.ts`: diagnóstico sintético não abre browser, não solicita credenciais e não faz rede. Mantém a validação CLI-first exigida pela Constitution.
- `apps/web/src/lib/copy-address.ts`: adaptador com capacidade de clipboard injetada; falha explícita e timeout limitado, com limpeza do timer. Não modifica dados de negócio.
- `features/routes/navigation-actions.tsx`: estado transitório apenas para feedback de cópia; link HTML externo com origem fixa, query codificada, isolamento de opener e Referer. Nenhum endpoint mutante ou geolocalização.
- `route-screen.tsx`: recebe o cliente do snapshot já validado/autorizado, mantém reordenação e estado de visita. Durante operação ocupada/conflito as ações ficam bloqueadas; perda de conexão remove apenas a navegação externa.
- CSS utiliza tokens e escopo `.seller-*`; não altera o laboratório offline. Fallback manual preserva legibilidade e foco.
- Nenhuma nova dependência, migração, tabela, variável de ambiente, cookie, log de dado privado ou política de cache.

## Base documental e automação

Conferidos `Docs/architecture.md` §§7.2, 17 e 18.3, `Docs/prd.md` Epic 2, FR-008 / AC-006 e a Story 2.4. Revisão CodeRabbit do commit (`--committed --base-commit a86c3bc --agent`) concluída sem apontamentos, cobrindo os 20 arquivos.

## Limites preservados

O link depende da disponibilidade externa do Maps e não confirma sucesso da navegação; cópia de endereço é a degradação. Nenhuma visita é iniciada/concluída. A rota canônica permanece online; o cache offline da rota real é uma entrega futura do Epic 2. A preferência por coordenadas completas válidas é uma decisão local reversível de representação do destino, sem efeito no modelo de dados.
