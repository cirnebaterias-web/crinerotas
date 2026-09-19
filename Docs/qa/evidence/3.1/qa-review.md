# Story 3.1 — revisão de QA

Data: 17/09/2026. Revisor: Quinn (`aiox-qa`, Codex). Veredito: **FAIL** por SEC-001; devolver ao desenvolvimento, sem aprovação de release.

Revisão local: `working-tree-sha256:3343e64efe41351d9cf314b7c822fb4f62e6dad50406fe923b24c7a3d096a2d9`.
Base Git: `020bcc525e97170cd7583742adb2c63b95ee5a0b`.

## Escopo e proveniência

- Revisão aprofundada pelos riscos de autenticação, persistência offline, migração e nove critérios de aceite. Lidos os contratos, domínio, CLI, adaptadores HTTP/RPC, migração/rollback, repositório local, sincronizador, controlador e superfícies de rota/visita relevantes.
- O identificador acima foi calculado antes da gravação de QA Results: SHA-256 UTF-8 das linhas `caminho SHA256_DO_ARQUIVO`, ordenadas com `Sort-Object`, separadas por LF, para os 45 arquivos da File List. Inclui os testes acrescentados pelo QA; não inclui os novos artefatos de parecer/gate. O digest inicial, anterior aos testes de QA, era `25e22651b03f7d3f92f314ce7ce6a3bc74faf01f7f4dcb20bfcc26311d3ca38f`.
- CodeRabbit executado antes da análise manual: `review --uncommitted --include-untracked --agent`, via WSL; terminou com `review_completed`, zero findings, sobre a versão inicial desta rodada. A alteração posterior é somente a prova E2E de QA, não uma correção do produto. Revisão automatizada sem findings não substitui o ensaio funcional abaixo.
- O checklist auxiliar `qa-master-checklist.md` não existe no framework. O template local `qa-gate-tmpl.yaml` descreve criação genérica de gates, incompatível com a estrutura de gate de story. Aplicados os critérios e o schema explícitos de `qa-review-story.md`/`qa-gate.md`, sem alterar o framework ou inventar aprovação especializada.
- Browser sem sessão conectada; usado o Playwright existente. Não houve inspeção do Chrome pessoal, limpeza de dados, mudança no código da aplicação, alteração de migração instalada, reset, commit, push, PR, deploy ou sincronização externa do ClickUp.

## SEC-001 — revogação local não oculta dados nas outras telas de rota

Severidade: **high**. Responsável sugerido: `dev`. Critérios afetados: fronteira de acesso/privacidade de AC 3/8 e regressão de AC 9.

### Reprodução

1. Abrir a rota com vendedor sintético e iniciar uma visita. Manter um evento local pendente de revisão para verificar preservação de trabalho.
2. Receber uma nova composição que retira o cliente; a visita aparece em **Visitas salvas de outras versões**.
3. Ficar offline. Ensaiar tanto a rota já carregada online (`loaded-route`) quanto sua reabertura pelo shell offline (`offline-shell`).
4. Em outra aba do mesmo contexto, abrir a rota offline e clicar no botão real **Bloquear acesso local**.
5. A segunda aba exibe **Acesso local bloqueado**, mas a primeira continua mostrando o cliente histórico, endereço, dados da rota atual e ações. O heading privado permanece presente mesmo após 10 segundos de espera.

Prova adicionada em `tests/e2e/visit-start.spec.ts`, cenário parametrizado `hides historical visits on ... when another tab blocks local access`.

```text
npm run test:e2e -- tests/e2e/visit-start.spec.ts --grep "hides historical visits" --output test-results/qa-3.1
2 failed: loaded-route, offline-shell
Expected private heading count: 0
Received: 1
```

Antes da asserção de ocultação, ambos os testes confirmaram que rascunho e outbox permaneciam exatamente iguais. O defeito comprovado é exposição visual após revogação, não perda de trabalho nem acesso indevido ao banco pelo servidor.

Artefatos locais:

- `test-results/qa-3.1/visit-start-hides-historic-25af2-her-tab-blocks-local-access/error-context.md`
- `test-results/qa-3.1/visit-start-hides-historic-db5f0-her-tab-blocks-local-access/error-context.md`
- Traces sintéticos nas mesmas pastas; não contêm credenciais reais.

### Causa e correção requerida

`OfflineFoundationService.invalidateLocalAccess` remove `cirne-rotas.last-user-id` e a sessão IndexedDB. `VisitStartScreen` observa os eventos correspondentes, mas `OfflineRouteScreen` carrega uma vez e não observa revogação entre abas; `RouteScreen` observa apenas `BroadcastChannel`, não a remoção da identidade no armazenamento. As duas superfícies continuam renderizando seus snapshots em memória, incluindo `SavedVisits`.

Corrigir as duas superfícies para ocultar imediatamente todo estado privado ao receber revogação/troca de identidade. Invalidar carregamentos/cache pendentes para que não republiquem dados nem restabeleçam a sessão revogada. Não apagar rascunhos/outbox; não recarregar automaticamente a identidade online como reação ao bloqueio explícito. Preservar a conclusão de commits duráveis já em andamento quando aplicável.

Aceite da correção: os dois testes novos passam; proteção permanece após eventos de reconexão/retorno ao primeiro plano, troca de identidade e carregamento concorrente; regressões anteriores continuam aprovadas. Não remover as asserções, adicionar `skip`/`fixme` ou aumentar timeout para encobrir a falha.

## Rastreabilidade Given–When–Then

| AC | Dado / quando / então e evidência | Resultado |
| --- | --- | --- |
| 1 | Dado vendedor autorizado, ao enviar comando estrito pela CLI/HTTP, confirmar contrato canônico; rejeitar campos/identificadores inválidos. Contratos, `visits.test.ts`, testes de serviço/HTTP e integração CLI. | Atendido no recorte testado |
| 2 | Dadas duas sessões e mesma intenção, ao concorrer/repetir, gerar um único efeito; payload divergente recebe conflito. `visit_start.test.sql` e `visit-concurrency.test.ts`. | Atendido |
| 3 | Dado ator fora do escopo, negar RPC/BFF/replay; dada retirada, aceitar trabalho histórico autorizado. Banco passa; dada revogação local em outra aba, a rota ainda exibe a visita. | **Parcial — SEC-001** |
| 4 | Dada nova versão/cadastro alterado, ao receber início atrasado, conservar parada e snapshot originais sem reinserção na composição. pgTAP e E2E real de retirada. | Atendido |
| 5 | Dado armazenamento com falha, ao iniciar, não navegar nem prometer salvamento; com commit válido, reabrir o mesmo rascunho offline. Repositório e E2E. | Atendido |
| 6 | Dada resposta perdida/erro recuperável, reenviar mesma intenção; confirmação parcial preserva ID canônico sem antecipar sincronização total. Controlador, repositório e sync-engine. | Atendido |
| 7 | Dada parada elegível/visita salva, iniciar/continuar pelo mesmo ID; Maps e cópia são independentes. E2E e inspeção de controles nativos/estados textuais. | Atendido no ambiente local; não certifica acessibilidade |
| 8 | Dado comando com localização opcional, manter validação e logs mínimos; sem foto/geofence. Ao revogar acesso em outra aba, dados da visita continuam visíveis na rota. | **Parcial — SEC-001** |
| 9 | Dadas versões anteriores, manter upgrade/cache/contratos; rollback com histórico deve recusar remoções. Regressão anterior aprovada, mas dois novos testes de segurança falham. | **Pendente da correção** |

## Validações e limites

- Reexecutados nesta revisão: lint, typecheck e **191 unitários** aprovados; **300 asserções pgTAP** e **16 testes de integração** aprovados, incluindo concorrência e recusa do preflight de rollback. Lint/typecheck/unitários aprovados novamente após adicionar os testes de QA.
- Baseline do turno anterior: build de produção, **28 E2E controlados + 4 reais** aprovados; mesmo código de aplicação nesta revisão. Não foi necessário interromper/reconstruir o preview por alterações apenas nos testes/documentos. Essas aprovações não incluem os dois cenários novos que revelaram SEC-001.
- Novo teste offline inicialmente reproduziu a falha; a versão parametrizada confirmou falhas em **duas superfícies**. A suíte controlada agora contém 30 casos; não se declara aprovação dos 30.
- Segurança: **FAIL** pela exposição visual. As verificações de escopo no servidor, grants mínimos, `search_path`, transação e logs não revelaram outro bloqueador na leitura realizada.
- Confiabilidade dos registros: provas de atomicidade, replay e preservação aprovadas; nenhum registro do usuário foi apagado. O problema visual não deve ser corrigido removendo os registros locais.
- Performance: índices/limites de lote existentes conferidos; sem ensaio de carga/latência ou memória de campo. A lista histórica carrega os rascunhos da partição; acompanhar volume e retenção em evolução posterior.
- Testabilidade: bom controle de rede/falhas/tempo nos testes; a lacuna era testar revogação somente em `/visit`, não onde o resumo da visita também passou a ser exibido.
- Não executados: instalação e encerramento em Android físico, TalkBack, auditoria WCAG completa, recuperação de ambiente produtivo ou reviews especializados independentes. Não há liberação para campo.

## Melhorias não bloqueantes já conhecidas

- `TEST-001` (low): reduzir sensibilidade temporal da fixture de concorrência sob carga; não relaxar a observação de lock. A execução isolada atual passou.
- `MNT-001` (low): distinguir `ERR_PARSE_ARGS_*` de outros erros com `code` na CLI, mantendo mensagens seguras.
- `TEST-002` (low): upsert do parâmetro sintético deve restaurar todos os campos necessários caso o UUID da fixture já exista. pgTAP atual passou; não é causa de SEC-001.

## Handoff

Gate FAIL deve aplicar `InReview → InProgress`. Próxima ação: `@dev *apply-qa-fixes` para SEC-001, seguido de nova revisão. As aprovações especializadas de banco/arquitetura/UX permanecem pendentes e não foram presumidas por este parecer negativo.

Arquivos produzidos pelo QA: este relatório, gate da Story 3.1, atualização de QA Results/Status/Change Log e dois testes em `tests/e2e/visit-start.spec.ts`. Dev deve acrescentar os novos artefatos à File List ao retomar; QA não alterou esse campo nem os checkboxes de implementação.

---

## Reavaliação de 17/09/2026 — SEC-001 resolvida

Veredito atual: **CONCERNS**, substituindo o FAIL histórico acima. Revisor: Quinn (`aiox-qa`, Codex), mesmo agente principal, sem apresentar esta rodada como revisão especializada independente.

Revisão: `working-tree-sha256:0d5ea72d93a20b2d45607927e44f9e68f6eb4e73635d5486f6b096463637ac60`. Base Git inalterada. Digest dos 51 arquivos da File List antes da gravação do novo gate/QA Results, pelo mesmo algoritmo documentado acima. O snapshot inclui os documentos com o parecer anterior; não representa o hash dos documentos após esta atualização.

### Evidências e análise

- As duas reproduções originais passaram e foram ampliadas para oito casos: rota carregada e shell offline × botão real de bloqueio, BroadcastChannel, troca de vendedor e limpeza da identidade. Cliente/endereço/ações desaparecem e permanecem ocultos após reconexão/primeiro plano/pageshow. Rascunho/outbox permanecem exatamente iguais. As quatro provas equivalentes na visita aberta também passaram.
- `observeLocalAccessRevocation` elimina divergências entre as três superfícies. RouteScreen invalida gerações/cache/fetch e exige ação explícita de login. OfflineRouteScreen bloqueia antes de aguardar persistência e descarta inicialização/navegação obsoletas. VisitStartScreen bloqueia o serviço e preserva o encerramento coordenado do controlador.
- `blockLocalAccess` impede novas leituras/reautorizações pela instância revogada. Verificações após fetch, sessão e leitura protegem as corridas. A limpeza captura previamente o vendedor e remove apenas seu ponteiro/sessão, não a identidade estabelecida por outro vendedor durante a espera.
- Seis unitários novos em `service-revocation.test.ts` provam esses limites. O arquivo `service.test.ts` anterior foi restaurado integralmente após substituição acidental detectada na revisão do diff; está sem diferenças contra HEAD. Resultado final: 197 unitários (191 anteriores + seis novos), 36 arquivos.
- Lint/typecheck/build/diff, 300 pgTAP, 16 integrações, 36 E2E controlados e quatro E2E reais passaram. Suites de navegador/banco executadas sequencialmente; contas de regressão separadas da demonstração. Preview final na porta 3000 com `ops:live` saudável.
- CodeRabbit completo terminou com zero findings sobre o código de produto final. A organização final dos arquivos de teste ocorreu depois do início da análise, sendo conferida manualmente e validada pelos gates. Na primeira revisão leve, a captura tardia da identidade foi corrigida; a hipótese de duplicação por hidratação da UI foi rejeitada pela consulta transacional ao draft existente e teste de reabertura com IDs diferentes.

### Rastreabilidade e NFRs atualizados

AC 1/2/4/5/6/7 mantêm as provas do parecer anterior, reexecutadas. AC 3 e 8: dada revogação em outra aba, ao receber o sinal, ocultar os dados sem permitir restauração por operações atrasadas; oito E2E e seis unitários aprovados. AC 9: dada a correção, ao executar a regressão completa, manter contratos, cache, início/retomada, sincronização, banco e CLI; gates aprovados.

Segurança/confiabilidade: PASS neste recorte. Performance: PASS apenas para a avaliação local já descrita. Manutenção: CONCERNS por TEST-001, MNT-001 e TEST-002 (low), ainda não corrigidos e não agravados por esta alteração. Score 90: nenhum FAIL e um NFR CONCERNS. Não há waiver.

### Limites e continuidade

O gate aplica `InReview → Done`, versão 1.0.13, para o desenvolvimento local da Story 3.1. Não autoriza publicação: reviews especializados, homologação Android físico, acessibilidade e privacidade de campo continuam pendentes. Nenhum reset/rollback destrutivo, descarte de visita, commit/push/PR/deploy ou atualização externa do ClickUp foi feito.

Detalhes dos comandos e DoD: `Docs/qa/evidence/3.1/sec-001-fix.md`. Os caminhos de traces da reprodução inicial acima são históricos; a execução dos testes direcionados reutilizou sua pasta de saída. Os resultados atuais aprovados constam da suíte controlada completa.
