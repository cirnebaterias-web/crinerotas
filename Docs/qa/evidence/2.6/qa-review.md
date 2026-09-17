# Story 2.6 — Revisão formal de QA

Data: 2026-09-17. Revisor: Quinn / `@qa` (Codex).
Revisão avaliada: `working-tree-sha256:9054fc51e9aa422b81ebb9dd1652a889a3ccb4fc3bfec06534e11dbb9c13205e`.

O identificador foi calculado imediatamente antes dos artefatos de lifecycle exclusivos de QA. Ele cobre o diff binário rastreado e o manifesto SHA-256 dos arquivos ainda não rastreados.

## Parecer

**PASS.** Os oito critérios de aceite estão atendidos, sem gap, waiver ou issue alto/crítico conhecido. A solução preserva as fronteiras `HTTP/CLI → aplicação → domínio/contratos → adaptadores`, versiona a composição sem reescrever fatos publicados e só informa a atualização ao Vendedor depois do commit local.

Durante a revisão foi encontrado um defeito baixo de codificação em três mensagens novas do `PATCH` e quatro fixtures textuais. O executor corrigiu os textos UTF-8; lint, typecheck e os 164 testes unitários passaram novamente. Nenhuma alteração funcional de banco, integração ou E2E foi necessária depois da bateria completa de 428 testes.

## Rastreabilidade Given–When–Then

| AC | Cenário e evidência | Resultado |
| --- | --- | --- |
| 1 | **Dado** ator autenticado, capacidade e escopo derivados, **quando** o Gestor usa `PATCH`/CLI com chave idempotente, **então** o comando estrito é aceito; Vendedor, ator sem capacidade ou fora do escopo recebem resposta não enumerável/negada. Handler, serviço, pgTAP e `ops:routes` cobrem o fluxo. | PASS |
| 2 | **Dada** uma publicação vigente, **quando** dois comandos usam a mesma versão, **então** o lock agregado permite um `200` e força um `409`; replay idempotente/no-op não duplica versão, lock ou auditoria. Unitários, pgTAP e integração HTTP concorrente cobrem o cenário. | PASS |
| 3 | **Dado** o rascunho sucessor, **quando** ele é publicado, **então** a versão anterior é superseded, a nova recebe snapshots/execuções e o agregado avança atomicamente; falha de auditoria aborta tudo. pgTAP verifica publicação, imutabilidade e falha injetada. | PASS |
| 4 | **Dadas** paradas mantidas, incluídas e retiradas, **quando** a sucessora é publicada, **então** estado e precedência das mantidas permanecem, incluídas nascem pending e retiradas continuam apenas no histórico. Os IDs de parada/versionamento preservam o vínculo futuro de visita. | PASS |
| 5 | **Dado** motivo normalizado e diff mínimo, **quando** a alteração/publicação conclui, **então** versão e auditoria registram ator, origem, anterior/nova e conjuntos added/removed/retained, sem tokens ou snapshots integrais em logs/respostas. | PASS |
| 6 | **Dada** a rota anterior já armazenada, **quando** o aparelho fica offline durante a mudança, **então** ela continua legível; **quando** reconecta, a v3 é confirmada atomicamente e somente então o aviso mostra motivo e contagens. E2E controlado/real e capturas móveis comprovam a jornada. | PASS |
| 7 | **Dados** leitores v2 e dados existentes, **quando** migração, rollback e reaplicação são executados, **então** v2/v3 permanecem discriminados, IndexedDB evolui para v5 e versões/execuções/auditorias anteriores não são perdidas. | PASS |
| 8 | **Dado** o incremento completo, **quando** os gates são executados com fixtures sintéticas, **então** lint, tipos, build, 164 unitários, 231 pgTAP, 14 integrações, 18 E2E controlados, 1 E2E real, CLI, rollback/reapply, CodeRabbit e diff-check passam. | PASS |

## NFRs e riscos

- **Segurança — PASS:** autorização derivada, escopo por Vendedor, `SECURITY DEFINER` com `search_path` vazio, grants mínimos, CSRF para cookie e auditoria síncrona.
- **Confiabilidade — PASS:** lock concorrente, transação atômica, versão anterior imutável, cache monotônico e falhas de rede/quota preservando a cópia anterior.
- **Desempenho — PASS no recorte:** limite de 50 paradas, consultas indexadas e nenhuma dependência ou serviço novo. Não houve benchmark de escala, fora do escopo local.
- **Manutenibilidade — PASS:** contratos discriminados, domínio puro, repositórios isolados, migração/rollback reproduzíveis e cobertura em todos os níveis definidos.

Riscos residuais aceitos pelo escopo: homologação em Android/Chrome e rede reais depende de `AB-14`; privacidade, retenção e limpeza com dados pessoais dependem de `AB-15`; a jornada de visita pertence ao Epic 3. Nenhum deles impede o gate local/sintético desta story.

## Evidências revisadas

- `Docs/qa/evidence/2.6/validation.md`
- `Docs/qa/evidence/2.6/architecture-review.md`
- `Docs/qa/evidence/2.6/route-before-reconnect.png`
- `Docs/qa/evidence/2.6/route-after-reconnect.png`
- `Docs/qa/2.6-po-validation.md`

Gate emitido em `Docs/qa/gates/2.6-alteracao-versionada-da-composicao-da-rota-publicada.yml`.
