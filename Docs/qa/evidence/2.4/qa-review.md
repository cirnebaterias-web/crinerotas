# Story 2.4 — Revisão de qualidade

Data local: 2026-09-16. Revisão por Quinn / @qa, com análise arquitetural por Aria / @architect. Papéis executados sequencialmente pelo mesmo agente Codex; não representam revisão humana independente.

## Escopo e proveniência

Base de produto: `51f84424b149d0bd3deea1e7f4498bb6d987cc83`. Única alteração de código durante QA: `apps/cli/src/navigation-cli.test.ts`, SHA-256 `507fe6361cff5195e8392444f487b824753de0678e3625cc1857597358273542`. Nenhuma mudança em código de produto, dependências, schema, autorização ou cache.

Resultado: **PASS** para esta story local. O gate não aprova o MVP completo para piloto e não autoriza publicação.

## Execuções desta revisão

- `npm run ops:navigation -- --json`: PASS; diagnóstico sintético sem rede.
- `npm run lint`: PASS.
- `npm run typecheck`: PASS.
- `npm test`: execução final com **148 PASS em 31 arquivos**.
- `npm run test:e2e`: **16 PASS**, incluindo as regressões offline, login, reordenação e navegação.
- CLI isolada após ajuste: **2 PASS**; são subconjunto dos 148, não somados novamente.
- CodeRabbit no commit (`--committed --base-commit a86c3bc --agent`): concluído, **0 findings**, 20 arquivos revisados.
- CodeRabbit no ajuste (`--uncommitted --include-untracked --agent`): concluído, **0 findings**, teste CLI e parecer arquitetural revisados.
- `git diff --check`: PASS; prévia `http://127.0.0.1:3000/api/v1/health/live`: HTTP 200.

Build, 182 pgTAP, 14 integrações HTTP/CLI e 1 E2E Supabase real permanecem cobertos pelas evidências de `validation.md`, executadas na etapa anterior sobre o mesmo código de produto. Não foram repetidos nesta revisão: a alteração posterior é exclusivamente o limite dos testes CLI. Portanto, a evidência agregada continua sendo **361 casos**, dos quais **164 reexecutados integralmente nesta revisão** (148 unitários + 16 E2E). As capturas versionadas permaneceram inalteradas na reexecução.

## Achado e correção

`TEST-CLI-TIMEOUT` — resolvido. Na primeira reexecução, 146 testes passaram e os dois que iniciam Node/tsx excederam o timeout padrão de 5s (aproximadamente 16,3s e 9,3s). O diagnóstico CLI real passou; a falha era o prazo dos testes sob a carga observada nesta máquina, não uma divergência de saída do produto.

QA ajustou somente esses testes para 40s, com timeout de 30s no processo filho e verificação explícita de `result.error`. Não ampliou o prazo global, removeu assertions, alterou o diagnóstico ou adicionou retries. A execução isolada e a suíte completa passaram depois do ajuste.

## Critérios de aceite — Given / When / Then

| AC | Evidência e resultado |
| --- | --- |
| 1 | Dado um endereço ou par válido de coordenadas, quando o destino é composto, então a URL tem domínio fixo, `api=1` e um único destino codificado. Unitários + CLI + link E2E: PASS. |
| 2 | Dada uma rota com reordenação não salva, quando o usuário abre e fecha o popup Maps interceptado, então paradas, rascunho, progresso e versão permanecem iguais, sem mutações HTTP: PASS. |
| 3 | Dada perda de conexão ou clipboard ausente/negado, quando o usuário copia, então existe cópia offline ou texto manual selecionável, sem falso sucesso. Clipboard real, falhas e timeout: PASS. |
| 4 | Dado um cliente do snapshot autorizado, quando o cartão é renderizado, então não há geolocalização, prefetch Maps, token, Referer ou opener compartilhado; UI mantém foco, alvos >=44px e ausência de overflow em 390/1440px: PASS. |
| 5 | Dados os comandos e cenários definidos, quando os gates são executados, então os critérios têm cobertura em domínio, CLI, navegador e evidência de integração real: PASS. |

## Risco residual e NFRs

- Segurança — PASS: destino codificado não permite trocar host/parâmetros; nenhuma mutação implícita, segredo novo ou mudança na sessão. Impacto potencial de navegação indevida mitigado por domínio fixo e testes negativos (probabilidade 1 × impacto 3 = 3).
- Confiabilidade — PASS: ausência de rede/clipboard não é apresentada como sucesso. Timeout evita espera indefinida; endereço manual permanece recuperável (1 × 2 = 2).
- Desempenho — PASS no recorte: uma composição de URL por cartão, nenhum request/SDK de mapas no render e nenhuma dependência nova. Sem alegação de benchmark em aparelhos físicos.
- Manutenibilidade/testabilidade — PASS: domínio puro compartilhado pela CLI/UI, adaptador injetável e efeitos externos controlados. Parecer detalhado em `architecture-review.md`.

Sem achados abertos nem waiver. O teste em aparelho físico/abertura real do aplicativo Maps continua recomendado para homologação do piloto; o ensaio local intercepta o Google para não transmitir dados. Não é uma lacuna bloqueante do recorte desta story.

## Procedimento e limites

O arquivo `qa-master-checklist.md` citado pelo framework não está presente. Foram usados o roteiro completo de `qa-review-story.md`, a decisão de `qa-gate.md`, os cinco critérios da story e os padrões de `Docs/architecture.md` como checklist explícito. Nenhuma instrução de qualidade foi considerada aprovada apenas por faltar esse arquivo.

Esta revisão mantém o Epic 2 aberto. O próximo incremento de produto indicado pelos artefatos é conectar a rota canônica já carregada ao armazenamento offline com isolamento de identidade; o laboratório sintético atual não substitui essa entrega. Visitas completas pertencem ao Epic 3.

Sem push/deploy, troca de credenciais GitHub ou escrita no ClickUp. A confirmação de lista/nome para sincronizar a story no ClickUp permanece pendente e não bloqueia o desenvolvimento local.
