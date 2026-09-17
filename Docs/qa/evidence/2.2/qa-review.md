# Revisão QA — Story 2.2

Revisor: Quinn (`@qa`). Data: 2026-09-16.

Base revisada automaticamente: `51475c5a84a7d0edea0905c3789a200d0b85a8aa`.
Revisão manual inclui a correção posterior de UUIDs e seus testes. Digest do diff de código/testes contra master: `29d7332bb6186b40bc5d58699bee329b301ed8b6`, reproduzível em PowerShell com `git diff --binary master -- apps packages scripts supabase tests | git hash-object --stdin`.

## Rastreabilidade

| AC | Dado / Quando / Então | Evidência |
| --- | --- | --- |
| 1 | Dado comando versionado, quando IDs inválidos/duplicados chegam, então são rejeitados; UUIDs equivalentes são normalizados | Contratos, domínio e testes unitários; pgTAP |
| 2 | Dada base limpa ou com rota reordenada, quando rollback/reaplicação executam, então interface e constraint são restauradas e todas as linhas preservadas | Reset limpo, script de ensaio e execução completa via psql |
| 3 | Dado ator ativo com capacidade/escopo, quando reordena, então é autorizado; demais atores não enumeram nem alteram rotas | pgTAP e integração 403/404; capacidade validada antes da busca |
| 4 | Dadas duas intenções com a mesma versão, quando disputam o lock, então só uma confirma; a outra recebe 409 | Integração vendedor/gestor real; pgTAP versão obsoleta |
| 5 | Dada parada não pendente/composição publicada, quando outras pendências mudam, então seus dados/posições permanecem; no-op não muda versão | pgTAP comparação integral da composição, posição/estado e contagem de auditoria |
| 6 | Dada mudança efetiva, quando confirma, então auditoria registra ator/ordens/origem/requestId; falha da auditoria desfaz a mudança inteira | pgTAP com falha injetada e leitura canônica v2; logs por allowlist |
| 7 | Dada rota sintética, quando CLI executa e repete, então aplica ordem determinística e depois reconhece no-op sem expor conteúdo privado | CLI como processo real; testes de resposta divergente e redaction |
| 8 | Dado o incremento completo, quando gates executam, então unitários, SQL, integração, build e offline passam | Evidência de implementação e comandos registrados |

## Riscos e atributos de qualidade

- Concorrência/atomicidade: mitigadas por lock da raiz antes das execuções, conjunto completo de IDs pendentes, constraint deferível e validação antes do retorno; falha pós-update ensaiada.
- Segurança: caller-scoped client, SECURITY DEFINER com owner NOLOGIN/NOBYPASSRLS, search_path vazio, grants estreitos, RLS forçada; capacidade e escopo reavaliados por comando. Nenhum segredo adicionado.
- Compatibilidade: consumidores atuais de rota canônica atualizados para v2. Cache/UI continuam sintéticos e fora do escopo. Rollback exige reversão coordenada da aplicação para v1.
- Performance: comandos limitados a 50 paradas; índices de raiz/versão e timeout no adaptador; testes locais sem regressão observada. Não é comprovação de carga ou latência em campo.
- Recuperação: no-op estável; versão obsoleta exige recarga; perda de resposta não cria duplicidade silenciosa porque a versão antiga conflita. Sem adicionar reenvio offline nesta story.
- Manutenção: portas existentes estendidas, domínio puro, contratos compartilhados e nenhum pacote novo.

## Achados tratados

1. UUID em caixa diferente: confirmado por teste exploratório; normalizado no comando e routeId antes do repositório. Testes unitários de unicidade e normalização adicionados; HTTP cobre UUIDs maiúsculos sem falsa indisponibilidade.
2. CodeRabbit pre-commit: semântica herdada dos checks created/published esclarecida no README; eles confirmam existência/publicação, não mutações ocorridas nesta execução.
3. CodeRabbit QA: checklist deve refletir a CLI atual (`review --uncommitted --include-untracked --agent`). Ajuste documental delegado ao registro de fechamento de dev.

O arquivo opcional `.aiox-core/product/checklists/qa-master-checklist.md` referenciado pela tarefa não existe neste checkout, nem foi encontrado por busca. A avaliação usa os critérios explícitos de `qa-review-story.md`, `qa-gate.md`, PRD, arquitetura e os oito ACs da story. Não há waiver de qualidade.

## Artefatos alterados durante QA

`packages/contracts/src/index.ts`, `packages/contracts/src/index.test.ts`, `apps/web/src/server/routes/service.ts`, `apps/web/src/server/routes/service.test.ts`, `tests/integration/health.test.ts`, esta revisão, evidência de implementação e os artefatos de gate/status da story. Os cinco arquivos de código/testes já constam na File List; dev deve incorporar os novos artefatos de QA ao fechar o registro.
