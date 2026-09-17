# Story 2.6 — Revisão arquitetural

Data: 2026-09-17. Papel: Aria / `@architect`, executado sequencialmente pelo mesmo agente Codex; não é revisão humana independente.

## Parecer

**APROVADO.** A implementação concretiza a extensão já prevista em `PATCH /routes/{id}` sem introduzir tecnologia, serviço ou fronteira arquitetural nova. O agregado mantém uma raiz concorrente, versões publicadas imutáveis, estado operacional separado e contratos compartilhados. Nenhum risco arquitetural alto/crítico permanece conhecido.

## Compatibilidade por camada

- **CLI-first:** `ops:routes` cria/publica, prepara/publica a sucessora e confirma motivo, versão, diff e leitura do Vendedor exclusivamente por `/api/v1`.
- **Contratos/domínio:** v3 é discriminada e consistente no envelope; v2 continua legível. Normalização/diff permanecem puros em `packages/*`.
- **BFF:** Route Handler trata HTTP, CSRF, identidade e resposta; serviço coordena o caso de uso; somente o adaptador conhece RPC/Supabase.
- **Dados:** `route_versions` recebe metadados aditivos; a publicação supersede a versão anterior sem reescrever paradas, snapshots ou execuções históricas. O lock continua na raiz `routes`.
- **Segurança:** `SECURITY DEFINER` usa `search_path` vazio, ator/capacidade/escopo derivados, tabelas sem grant ao papel autenticado e executor interno não autenticável. Auditoria é parte da mesma transação.
- **Offline/UI:** IndexedDB v5 preserva stores e registros. A substituição é monotônica/atômica; o aviso é emitido somente após commit. Não há acesso direto da UI ao banco.
- **Operação:** migration expand-only, rollback coordenado e reaplicação foram ensaiados sobre versões/auditorias existentes. Limites de 50 paradas mantêm custo previsível.

## Checklist arquitetural escopado

| Área | Resultado | Evidência |
| --- | --- | --- |
| Alinhamento com FR-005/FR-009/FR-052 e DEC-013 | PASS | PRD v0.4, AC 1–8 e contratos implementados |
| Separação UI → aplicação → domínio/contratos → adaptador | PASS | módulos existentes preservados, sem acesso Supabase fora do repositório |
| API, autorização e erro canônico | PASS | PATCH estrito/idempotente, publicação existente estendida, no-store e testes HTTP |
| Integridade/concorrência/histórico | PASS | lock agregado, corrida 200/409, supersessão única, triggers de imutabilidade e auditoria atômica |
| Compatibilidade/migração/rollback | PASS | v2/v3, Dexie v5, reset limpo e ensaio rollback/reapply sem perda |
| Resiliência offline | PASS | falha de quota preserva cache anterior; rota antiga permanece sem rede; nova só após commit |
| Observabilidade/privacidade | PASS | logs estruturados por template/status; nenhum token, payload ou snapshot integral |
| Testabilidade/manutenibilidade | PASS | unitário, pgTAP, integração, E2E controlado/real e CodeRabbit final limpo |

Itens globais de implantação, escala de produção, política de retenção e homologação física não foram reabertos por esta story. Continuam explicitamente condicionados a `AB-14`/`AB-15`, sem constituir dívida oculta do incremento local.

## Riscos residuais

- Homologação em aparelho/rede reais ainda depende de `AB-14`.
- Uso de dados pessoais e limpeza/retenção ainda dependem de `AB-15`.
- O vínculo de visitas permanece estruturalmente protegido pelo `route_version_stop_id`; a jornada de visita será implementada no Epic 3 e não foi antecipada.

Esses riscos não bloqueiam a aprovação arquitetural local/sintética. O veredito final de qualidade e a transição da story pertencem a `@qa`.
