# Evidência de desenvolvimento — Story 3.2

Data: 2026-09-18. Ambiente: Windows, Node 24.19.0, npm 11.17.0, Rancher Desktop/Moby e Supabase local. Somente atores e dados sintéticos foram usados.

## Resultado

A seção **Estoque observado** foi integrada ao mesmo agregado de visita e à mesma outbox da Story 3.1. Quantidades Heliar/Moura aceitam zero e rejeitam vazio, negativo, decimal e valores não inteiros; a observação é opcional, normalizada e limitada a 500 caracteres. Nenhuma unidade comercial, estimativa ou quebra por modelo foi introduzida.

O commit IndexedDB atualiza rascunho e evento `visit.stock.saved.v1` na mesma transação. A navegação para `?step=prices` ocorre somente depois do commit; deep-link prematuro volta para Estoque. Edição confirmada cria nova sequência/evento, submissões duplicadas são coalescidas e revogação durante commit não descarta o trabalho durável.

No servidor, `api.stock_snapshots` é 1:1 com a visita. PUT direto e lote de sync compartilham autorização, ordem, idempotência e resposta canônica. O endurecimento final alinha a ordem das travas entre os dois caminhos e remove execução pública de `private.sync_event`, mantendo grant explícito apenas para o executor interno necessário.

## Rastreabilidade dos critérios

| AC | Evidência |
| --- | --- |
| 1–2 | Schemas/testes em `packages/contracts`; mutação pura em `packages/domain`; CLI não imprime observação/payload. |
| 3–4 | Repositório Dexie v7, controlador e Playwright cobrem atomicidade, zero, restauração, edição, hard refresh, URL/currentStep e revogação. |
| 5–7 | Migrações/RPC, testes de serviço/HTTP, 330 asserções pgTAP, integração real, replay divergente, evento fora de ordem e resposta perdida. |
| 8 | Labels, erros associados, inputs nativos, alvos móveis e estados textuais; “1 de 4” só aparece após seção salva. Homologação física continua gate de piloto. |
| 9 | Upgrade IndexedDB v1→v7 preservado; eventos anteriores continuam válidos; rollback recusa histórico; todas as suítes obrigatórias passaram. |

## Gates executados

- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: PASS — 36 arquivos, 203 testes unitários.
- `npm run build`: PASS — build de produção e Service Worker.
- `npm run test:integration`: PASS — 7 arquivos/330 asserções pgTAP e 2 arquivos/16 testes de integração.
- `npm run test:e2e`: PASS — 41 cenários controlados.
- `npm run test:e2e:real`: PASS — 4 cenários com Supabase/atores sintéticos; inclui estoque canônico e retomada offline sem duplicação.
- `git diff --check`: PASS.

O runtime Rancher foi reiniciado uma vez após timeout do socket Hyper-V do Windows; os containers/volumes foram preservados. A repetição completa passou.

## Rollback e compatibilidade

Somente o prefixo/preflight de `supabase/rollbacks/20260917223000_visit_stock.rollback.sql` foi executado, nunca o corpo destrutivo. Após adquirir `ACCESS EXCLUSIVE` como `cirne_visit_executor`, ele recusou com `Rollback refused: stock snapshots exist`. A base permaneceu com 4 snapshots e 4 eventos naquele ponto. As associações preexistentes de `postgres` aos executores, concedidas por `supabase_admin`, permaneceram inalteradas após a tentativa abortada.

A suíte controlada confirmou migração de banco de navegador v1 para v7 com os três registros duráveis preservados. As suítes reais usam `seller_regression`/`manager_regression`; `seller_e2e`/`manager_e2e` permanecem reservados à demonstração. O provisionamento amplia/reutiliza o manifesto sem trocar credenciais existentes, e nenhum reset, limpeza de visitas ou publicação remota foi executado.

## Definition of Done (modo YOLO)

- Requisitos: 2/2 aplicáveis atendidos.
- Padrões/estrutura/segurança: 7/7 atendidos.
- Testes: 4/4 atendidos pela matriz unitária, pgTAP, integração e E2E.
- Funcionalidade e erros: 2/2 atendidos; verificação local automatizada de navegador/API/banco concluída.
- Administração da story: 3/3 atendidos após atualização de tarefas, notas, changelog e File List.
- Build/configuração: build e lint atendidos; dependências, variáveis e vulnerabilidades novas são N/A porque nenhuma dependência/configuração foi adicionada.
- Documentação: 3/3 atendidos em README, comentários necessários e esta evidência.

Não há débito funcional conhecido da Story 3.2. Permanecem fora do gate local os reviews formais de `@data-engineer`, `@architect`, `@ux-design-expert`, o veredito `@qa`, pre-PR de `@devops` e homologação em Android/TalkBack/zoom prevista para o piloto.
