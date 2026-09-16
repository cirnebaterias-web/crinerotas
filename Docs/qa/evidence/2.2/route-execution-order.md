# Story 2.2 — evidência de implementação

Data: 2026-09-16. Branch: `story/2.2-reordenacao-operacional-rota`.

## Resultado

Reordenação transacional de todas as paradas pendentes por API/CLI. O lock da raiz serializa comandos concorrentes; a versão agregada avança uma vez por mudança efetiva. Composição, snapshots, prioridade, ordem planejada e posições não pendentes permanecem intactos. No-op não avança versão nem grava auditoria.

O banco valida identidade/capacidade antes de procurar a rota e escopo antes de revelar versão/estado. A constraint de posição é deferível, qualificada pelo schema e validada imediatamente após a troca. O adaptador e o CLI rejeitam confirmação com IDs, cardinalidade, ordem ou versão divergentes. As leituras canônicas passam a schemaVersion 2; o comando/resultado nascem na versão 1.

## Verificações executadas

| Comando | Resultado |
| --- | --- |
| `npm run db:reset` | PASS; migrações limpas e atores sintéticos provisionados |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS; 25 arquivos, 114 testes |
| `npm run build` | PASS; endpoint de reordenação dinâmico |
| `npm run db:test` | PASS; 4 arquivos, 182 testes, 59 específicos desta story |
| `npm run test:integration` | PASS; 11 testes, incluindo duas execuções do CLI e disputa vendedor/gestor |
| `npm run test:e2e` | PASS; 3 testes de regressão offline/IndexedDB |
| `npm audit --audit-level=high` | PASS; zero vulnerabilidades reportadas |
| `git diff --check` | PASS |

A integração foi repetida no mesmo banco com a rota já existente. O resultado continuou estável; não depende de uma versão agregada inicial fixa. Dois comandos simultâneos com a mesma versão retornam um 200 e um 409; a leitura posterior confirma a ordem vencedora.

## Reversibilidade reproduzível

Execute `node --import tsx scripts/verify-route-execution-rollback.ts` com Supabase local disponível. O ensaio lê os arquivos reais de rollback/migração, substitui apenas seus delimitadores externos por uma transação descartável e compara todos os campos de rotas, versões, paradas, execuções e auditoria antes/depois. Ao terminar, faz rollback do próprio ensaio. Verifica função pública, capacidades e constraint nas duas direções.

O comando passou em base sem rotas e depois da integração persistir uma rota reordenada. Os arquivos completos também foram executados diretamente, cada um com seu COMMIT, via psql no container local `supabase_db_cirne-rotas-dev`. A suíte SQL e os 11 testes de integração passaram após a reaplicação. A reversão restaura a interface v1, preservando a ordem já armazenada; aplicação e banco devem ser revertidos juntos.

## Atomicidade e segurança

O pgTAP revoga temporariamente INSERT de auditoria do executor para forçar falha após a atualização das posições. Confirma reversão integral da ordem e da versão, sem evento adicional. O teste inteiro termina em rollback, inclusive as permissões da fixture.

Outros cenários: swap com posições esparsas; parada em visita; IDs duplicados/ausentes/alheios; payload inválido; ator bloqueado; papel sem capacidade; vendedor alheio; gestor com escopo revogado; rota não publicada; versão obsoleta; imutabilidade integral da composição; SQL direto negado; RLS forçada. O BFF foi exercitado com 422, 404, 409 e cabeçalhos no-store. Logs e CLI não expõem tokens ou snapshots.

## CodeRabbit pre-commit

O comando legado `--prompt-only -t uncommitted` não existe na versão instalada. Foi usado o equivalente indicado pelo próprio help: `coderabbit review --uncommitted --include-untracked --agent`, via WSL Ubuntu. Revisão concluída de 19 arquivos, com um achado minor e nenhum crítico/alto.

O achado sugeriu alterar os checks `created`/`published` quando uma rota é reutilizada. Eles são checks de existência/publicação herdados do contrato operacional da Story 2.1, não contadores de mutações. A semântica foi explicitada no README; `reordered` já distingue mudança e no-op. Alterar esses campos nesta story quebraria a interface existente sem necessidade.

As validações adicionais de segurança/CLI e o script de rollback foram incluídos durante a revisão. A revisão de QA deve considerar o commit final completo.

## Definition of Done — autoavaliação dev

- [x] Requisitos funcionais e oito critérios implementados e rastreáveis aos testes.
- [x] Padrões, estrutura, stack, contratos e modelo existentes respeitados.
- [x] Validação de entrada, erros públicos, autorização, auditoria e redaction verificadas.
- [x] Lint sem erros; comentários presentes nos pontos transacionais e no ensaio.
- [x] Testes unitários, SQL, integração e E2E passam; cenários críticos cobertos.
- [N/A] Meta percentual de cobertura: não definida na story; nenhuma porcentagem inferida.
- [x] Verificação funcional por HTTP/CLI reais e casos de erro/concorrência.
- [x] Checklist, decisões, modelo, changelog e File List atualizados na story.
- [x] Build e configuração existentes validados.
- [N/A] Novas dependências, variáveis de ambiente ou configurações: nenhuma introduzida.
- [x] README e evidências atualizados; reversibilidade reproduzível.
- [x] Desenvolvimento pronto para revisão de QA; nenhum bloqueio funcional conhecido.

## Limites

Somente dados sintéticos e serviços locais. Sem UI de reordenação, alteração de composição publicada, cache canônico offline, push ou deploy. Próxima etapa funcional deve partir do PRD/backlog, preservando AB-12.
