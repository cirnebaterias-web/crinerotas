# ADR 003 — Catálogo de ações próprias e coleta de ações concorrentes

## Status

Accepted — 2026-10-06

## Context

A visita precisa apresentar campanhas Heliar vigentes, registrar a confirmação de repasse ao PDV e coletar ações concorrentes classificadas. O cadastro próprio muda ao longo do tempo, enquanto a visita precisa preservar o conteúdo efetivamente exibido e respondido.

## Decision

- Manter um catálogo próprio de ações comerciais, administrado por Gestores, com vigência, conteúdo e banner opcional.
- Materializar na resposta da visita uma cópia do título e do período da ação confirmada, além do identificador do catálogo.
- Modelar a concorrência como resposta explícita `identified`/`not_identified`, com registros repetíveis quando positiva.
- Usar tipos canônicos e fechados para a classificação, mantendo `other` com descrição obrigatória.
- Persistir a resposta como evento versionado `visit.commercial-actions.saved.v1` no mesmo agregado e outbox da visita.
- Tratar evidência fotográfica como opcional nesta versão e armazená-la no canal privado de anexos da visita.

## Consequences

- Campanhas expiradas deixam de aparecer em novas visitas sem alterar históricos.
- A sincronização mantém ordenação e idempotência já usadas por estoque e preços.
- Segmentação de campanhas e aprovação editorial ficam fora do escopo atual.
