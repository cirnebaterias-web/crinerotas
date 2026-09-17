# Story 2.5 — Validação de desenvolvimento

Data: 2026-09-16. Branch: `story/2.5-consulta-offline-rota-real`.

## Resultado

Desenvolvimento concluído e pronto para revisão formal (InReview). Não equivale a deploy, homologação em aparelho físico ou autorização para usar dados reais.

| Gate executado | Resultado |
| --- | --- |
| `npm run ops:offline -- --json` | PASS: snapshot canônico v2 e legado v1 sintéticos |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | 158 PASS, 31 arquivos |
| `npm run build` | PASS, shell offline e standalone preparados |
| `npm run test:integration` | 182 pgTAP + 14 HTTP/CLI PASS |
| `npm run test:e2e` | 17 PASS |
| `npm run test:e2e:real` | 1 PASS, Supabase local |
| CodeRabbit | 2 revisões; 4 findings major válidos corrigidos, 0 crítico residual conhecido |
| `git diff --check` | PASS |

Total: 372 testes aprovados. Nenhuma dependência, variável de ambiente, migração remota, dado real, push ou deploy foi adicionado.

## Rastreabilidade dos critérios

1. **Snapshot canônico:** contrato estrito v2 preserva rota, versão, execução, vendedor, estados e clientes; conversão/restauração puras rejeitam partição divergente e não possuem `parameterSetVersion`. O pacote sintético v1 continua válido. CLI confirma os dois contratos.
2. **Commit honesto:** Dexie v4 mantém índices e registros anteriores. Rota/sessão são transacionadas; versões mais antigas não sobrescrevem snapshot ou sessão mais novos. Falha de quota reverte a gravação e preserva o snapshot anterior. A UI só anuncia disponibilidade após revisão do worker e commit.
3. **Abertura autorizada:** hard refresh de `/route` sem rede recebe `~offline`, valida partição/sessão de 24 h e lê IndexedDB. Ausência, expiração, recuo de relógio, 401/403, troca de usuário e logout falham fechados. Respostas privadas não entram no Cache Storage.
4. **Consulta offline:** data, vendedor, progresso, versão, ordem, estados, prioridade, nomes e endereços permanecem visíveis. Clipboard segue disponível; Maps, atualização e reordenação ficam desabilitados com mensagem explícita. Captura móvel foi inspecionada.
5. **Logout/isolamento:** o ponteiro local é removido antes de uma exclusão que possa falhar; a sessão é invalidada sem apagar rota/outbox. Uma barreira impede cache iniciado durante revogação e cancela gravação que ainda aguardava o worker.
6. **Atualização consistente:** cada leitura/reordenação confirmada tenta atualizar o snapshot. Comparação atômica por versão da rota, versão da execução e `cachedAt` impede conclusão antiga de vencer uma nova; o estado visual possui geração independente para o mesmo caso.
7. **Verificação:** unitários cobrem schemas, domínio, upgrade, atomicidade, quota, concorrência, revogação e identidade. E2E controlado cobre hard refresh/logout; E2E real prova login → cache → offline → reordenação → atualização do cache → logout.

## Evidência visual

- `route-real-offline-mobile.png`: rota canônica sintética carregada via Supabase local e reaberta sem rede; inspeção visual aprovada, sem overflow e com ações online desabilitadas.

O teste físico Android/Chrome permanece bloqueado por `AB-14`; dados pessoais e política de limpeza/retensão permanecem bloqueados por `AB-15`. A captura usa somente fixtures sintéticas.

## CodeRabbit e revisão manual

Comando WSL compatível com a versão instalada: `coderabbit review --uncommitted --include-untracked --agent --light`.

- Rodada 1: três findings major válidos — escrita canônica fora de ordem, cache iniciado durante revogação e ponteiro antigo preservado se a exclusão da sessão falhasse. Todos corrigidos com regressões.
- Rodada 2: um finding major válido — resposta antiga preservava a rota nova, mas não revalidava monotonicamente a sessão. Corrigido dentro da mesma transação, sem permitir rollback temporal.
- Nenhum finding CRITICAL. Após a última correção, lint, tipos e testes direcionados passaram; revisão manual conferiu a monotonicidade e os limites transacionais.

## Definition of Done — autoavaliação @dev

- [x] Requisitos e AC 1–7 implementados e rastreados acima.
- [x] Estrutura respeitada: contratos/domínio puros, repositório Dexie, serviço cliente e UI sem acesso direto ao banco.
- [x] Segurança: partição explícita, janela local existente, fail-closed, revogação concorrente, nenhum token/cache privado e nenhuma fixture usada como rota real.
- [x] Testes unitários, pgTAP, integração, E2E controlado e E2E real aprovados; cenários de erro e concorrência cobertos.
- [x] Verificação funcional: CLI, build de produção, Service Worker, IndexedDB, Supabase local e captura visual inspecionada.
- [x] Administração: Tasks, decisões, Change Log, evidência e File List atualizados.
- [x] Build, lint e tipos aprovados. Dependências, variáveis e migrações de servidor: N/A.
- [x] README atualizado com carregamento, hard refresh offline e limitações.
- [x] Todos os itens aplicáveis do DoD atendidos; story pronta para revisão formal, ainda não marcada Done.

## Limites e operação

Não há visita, reordenação offline, mapa offline, deploy nem dados reais. Persistência reforçada do navegador continua sem garantia contra limpeza pelo usuário/sistema. ClickUp não foi alterado porque lista/nome ainda aguardam confirmação explícita.
