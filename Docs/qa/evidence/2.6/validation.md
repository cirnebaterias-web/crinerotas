# Story 2.6 — Validação de desenvolvimento

Data: 2026-09-17. Branch: `story/2.6-alteracao-composicao-rota-publicada`.

## Resultado

Desenvolvimento concluído e pronto para revisão formal. O recorte permanece local, sintético e sem deploy, push ou dados reais.

| Gate | Resultado |
| --- | --- |
| `npm run db:reset` | PASS: todas as migrations reaplicadas desde zero e atores sintéticos provisionados |
| `npm run ops:routes -- --json` | PASS: composição sucessora aplicada, motivo confirmado e leitura/reordenação canônicas |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | 164 PASS em 31 arquivos |
| `npm run build` | PASS: produção e standalone preparados |
| `npm run db:test` | 231 pgTAP PASS em 5 arquivos |
| `npm run test:integration` | 14 HTTP/CLI PASS; inclui corrida de composição com um vencedor e um `409` |
| `npm run test:e2e` | 18 PASS |
| `npm run test:e2e:real` | 1 PASS contra Supabase local |
| `npx tsx scripts/verify-route-composition-rollback.ts` | PASS: rollback/reaplicação sem alterar versões, execuções ou auditorias |
| CodeRabbit | 5 rodadas; 8 findings válidos corrigidos; rodada final com 0 findings |
| `git diff --check` | PASS |

Total automatizado: 428 testes aprovados (164 unitários + 231 pgTAP + 14 integrações + 18 E2E controlados + 1 E2E real).

## Rastreabilidade

1. **Autoridade e CLI-first:** handler, serviço e RPC exigem Gestor com `route.plan_scoped`, escopo derivado e `Idempotency-Key`; Vendedor recebe `403`. O diagnóstico real percorre somente `/api/v1` e não expõe tokens ou snapshots.
2. **Rascunho concorrente:** lock agregado, versão esperada, validação estrita, chave idempotente e no-op foram cobertos em domínio, adaptador, pgTAP e integração. Dois `PATCH` simultâneos produziram exatamente um `200` e um `409`.
3. **Publicação sucessora:** a transação congela snapshots, supersede a publicação anterior, publica a próxima versão, cria execuções e avança o lock uma vez. A versão anterior permanece consultável e imutável.
4. **Trabalho preservado:** retained mantém estado e precedência relativa; added nasce `pending`; removed permanece somente na versão antiga. Os fatos da versão anterior não são reescritos.
5. **Motivo e auditoria:** motivo normalizado e diff mínimo acompanham versão e auditoria síncrona com ator/origem derivados; replay e no-op não duplicam auditoria.
6. **Reconexão explícita:** IndexedDB v5 aceita v2/v3, substitui monotonicamente e só anuncia a mudança após commit. E2E controlado e real comprovam versão anterior offline, nova versão após reconexão e aviso com motivo.
7. **Compatibilidade e reversão:** leitores v2 seguem válidos; envelopes v2/v3 são consistentes; migration expand-only e rollback coordenado foram reaplicados sobre dados versionados sem perda.
8. **Verificação:** contratos, domínio, BFF, banco, CLI, cache, UI, concorrência e jornada real possuem cobertura nos níveis definidos pela story.

## Evidência visual

- `route-before-reconnect.png`: rota anterior disponível no aparelho sem conexão, sem remoção silenciosa.
- `route-after-reconnect.png`: nova composição visível depois da reconexão, com inclusões/retiradas e motivo do Gestor.

As duas capturas foram inspecionadas em viewport móvel: sem overflow, ações online corretamente desabilitadas offline e aviso de atualização legível após o commit local.

## CodeRabbit

- Rodada 1: seis findings válidos — mensagens UTF-8, UUID canônico, coerência do envelope v2/v3, unicidade do retorno da RPC e repetibilidade do E2E real.
- Rodada 2: um finding válido — envelope disponível deve derivar a versão da rota parseada.
- Rodada 3: zero findings.
- Rodada 4: um finding válido — teste de chave ausente precisava isolar somente o cabeçalho.
- Rodada 5: zero findings sobre o delta final.

## Limites

O teste físico Android/Chrome permanece condicionado à `AB-14`; dados pessoais e retenção permanecem condicionados à `AB-15`. Não há painel gerencial, solicitação do Vendedor, push em tempo real, visita do Epic 3, deploy ou uso de dados reais nesta entrega.
