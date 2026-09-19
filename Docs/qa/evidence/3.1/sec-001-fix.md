# Story 3.1 — correção SEC-001

Data: 17/09/2026. Implementação: Dex (`aiox-dev`, Codex). Revisão de QA será registrada separadamente; este relatório não aprova release.

## Alteração

- Observador único de sessão para rota carregada online, shell offline e visita aberta: BroadcastChannel `cirne-session`, troca/remoção de `cirne-rotas.last-user-id` e limpeza de localStorage.
- Estado privado ocultado ao receber o sinal. Gerações/abort impedem respostas atrasadas de repopular a rota; inicialização e início de visita não navegam após bloqueio.
- Bloqueio síncrono do serviço impede reautorização pela reconexão. Verificações após fetch, gravação de sessão e leitura de snapshots descartam operações obsoletas.
- Revogação captura o vendedor antes de aguardar persistência. Limpeza não remove a identidade/sessão de outro vendedor que acabou de entrar.
- Rascunhos/outbox não são apagados. Confirmações já enviadas continuam podendo concluir o commit durável.

## Provas executadas

- `npm run lint`: PASS.
- `npm test`: 197 testes, 36 arquivos, PASS, incluindo seis novos testes em `service-revocation.test.ts`. A conferência do diff identificou substituição acidental do arquivo de testes existente: `service.test.ts` foi restaurado integralmente a partir do HEAD (estava sem alterações no início da rodada), sem remover nenhum teste anterior. Sua comparação com HEAD não apresenta diferenças.
- `npm run test:integration`: 300 pgTAP + 16 integrações, PASS. Fixtures sintéticas; sem reset nem execução do corpo destrutivo do rollback.
- Oito E2E direcionados passaram: duas superfícies × quatro sinais. Preservação exata de um rascunho e um evento, ocultação de cliente/endereço/ações, e bloqueio mantido após online, visibilitychange e pageshow.
- Seis testes unitários: bloqueio antes de inicializar; resposta de identidade atrasada; gravação atrasada em initialize e refresh; leitura tardia de snapshot; mudança de vendedor durante limpeza. A sessão do novo vendedor permanece íntegra.
- Build final e typecheck concluídos; 36 E2E controlados + 4 E2E reais passaram no build final. Lint/typecheck e `git diff --check` revalidados após separar os arquivos de testes.

## CodeRabbit — primeira execução

Comando via WSL: `coderabbit review --uncommitted --include-untracked --agent --light`. Concluído com dois apontamentos `major`:

1. Capturar a identidade antes de aguardar limpeza: confirmado; já corrigido durante a execução da revisão e coberto pelo sexto teste do serviço.
2. Possível duplicidade enquanto `visitDrafts` ainda carrega: não confirmado. `saveVisitStartAndEnqueue` consulta a parada dentro da transação IndexedDB antes de criar qualquer intenção; devolve o mesmo draft/evento. O teste `commits visit start and outbox atomically, reopens it and associates the canonical visit` envia IDs novos na segunda chamada e verifica mesmo offlineId e apenas um evento. Adicionar uma consulta fora da transação não fortaleceria a garantia.

Revisão completa sem `--light` concluída sobre o código de produto final: `review_completed`, zero findings. A execução começou antes de restaurar o arquivo de testes anterior; os seis novos testes foram movidos para `service-revocation.test.ts` e os 16 anteriores restaurados integralmente depois do início da análise. Essa organização final foi conferida manualmente e validada por lint/typecheck e pelos 197 unitários; nenhum código de produto mudou depois do início da revisão completa.

## DoD e limites

- [x] Correção alinhada a AC 3/8/9, sem novo requisito comercial.
- [x] Camadas e convenções existentes; sem dependências, variáveis ou migração novas.
- [x] Testes de falha/concorrência e preservação adicionados; lint e unitários aprovados.
- [x] Integrações, pgTAP e build aprovados.
- [x] Regressão completa de navegador e revisão automatizada concluídas; pronta para reavaliação de QA.
- [x] Checklist e File List atualizados; sem alteração dos resultados históricos de QA pelo desenvolvimento.
- [N/A] Inspeção do navegador pessoal: não conectado; utilizado Playwright do projeto.
- [ ] Reviews especializados e homologação física continuam fora desta correção e não foram presumidos.

Sem commit, push, PR, deploy, atualização externa do ClickUp ou limpeza do armazenamento do usuário. Preview mantido em `http://127.0.0.1:3000/` no modo de produção local com suporte offline.
