# Evidência de implementação — Story 2.1

Data: 2026-09-15
Revisão QA: 2026-09-16
Branch: `story/2.1-rota-canonica-sintetica`
Escopo: criação, publicação e carregamento canônico de uma rota diária exclusivamente sintética.

## Resultado funcional

- Contratos estritos e versionados para criar rascunho, publicar e carregar a rota do dia.
- Agregado persistente com raiz por Vendedor/data, versões, paradas, execução separada e snapshots no momento da publicação.
- Capacidades `route.plan_scoped`, `route.read_scoped` e `route.read_self`, com identidade derivada da sessão e escopo atual.
- RPCs estreitas e transacionais; tabelas com RLS forçada e sem acesso direto para `anon` ou `authenticated`.
- BFF autenticado com validação, limite de corpo, CSRF para cookie, `no-store`, timeout e erros públicos estáveis.
- CLI `ops:routes` cria, publica e carrega o agregado por HTTP real; uma nova execução reutiliza a mesma publicação sintética validada sem conflito.
- Publicação congela composição e snapshots. A única transição posterior permitida é `published → superseded`, preservando todos os demais campos; versões superseded continuam imutáveis.
- A data operacional usa `OPERATIONAL_TIME_ZONE` IANA explícito; a CLI adota a data canônica devolvida pelo servidor e não deriva o dia por UTC.

## Gates executados

| Gate | Resultado |
| --- | --- |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 25 arquivos, 106 testes |
| `npm run build` | PASS — quatro endpoints de rota identificados como dinâmicos |
| `npm run db:test` | PASS — 3 arquivos, 123 testes pgTAP (53 de rotas) |
| `npm run test:integration` | PASS — 11 testes, incluindo duas execuções consecutivas da CLI e isolamento de escopo |
| `npm run test:e2e` | PASS — 3 testes de regressão offline/IndexedDB |
| `npm audit --audit-level=high` | PASS — zero vulnerabilidades conhecidas |
| `git diff --check` | PASS |

## Reversibilidade

- O rollback foi executado contra o Supabase local e removeu tabelas, funções, permissões e `cirne_route_executor` em uma única transação.
- A associação temporária ao papel de identidade foi removida sem apagar a associação anterior concedida por `supabase_admin`.
- A consulta de catálogo confirmou `api.routes` ausente e `cirne_route_executor` inexistente após a reversão.
- A migração foi reaplicada a partir do arquivo, os atores/clientes sintéticos foram reprovisionados e os 123 testes pgTAP passaram novamente.
- O pgTAP usa datas reservadas e passou novamente depois da integração persistir rotas sintéticas, sem limpeza prévia ou conflito entre ensaios.

## Revisão automática e autocorreção

O CodeRabbit revisou os 31 arquivos do diff dentro do limite de duas iterações da story. A primeira conexão encerrou após emitir três achados major; a segunda concluiu com quatro achados adicionais. Todos foram verificados e corrigidos:

- comparação integral da composição carregada pela CLI;
- entradas inválidas mapeadas para `VALIDATION_FAILED` antes do repositório;
- falha de transporte/timeout do Supabase mapeada para dependência indisponível;
- reutilização segura da rota sintética já publicada no mesmo dia;
- rejeição de clientes duplicados em respostas do adaptador;
- restauração exata da associação temporária no rollback;
- transição explícita para superseded sem tornar o conteúdo histórico mutável.

Cada correção recebeu teste unitário, SQL ou de integração correspondente. A rodada concluída retornou quatro achados e nenhum Critical; a confirmação pós-correção fica como entrada explícita para o gate independente de QA, pois o limite de autocorreção da story foi atingido.

No gate independente de QA, a primeira rodada encontrou a data UTC implícita e a contagem documental. O fuso IANA passou a ser configuração obrigatória, a CLI passou a consumir a data do servidor e a documentação foi corrigida. Duas rodadas posteriores do CodeRabbit revisaram 36 arquivos e concluíram com zero achados. A inspeção manual acrescentou imutabilidade das paradas superseded e isolamento do pgTAP; ambas as correções passaram na última rodada automática.

## Segurança e dados

Foram usados apenas atores, UUIDs, clientes, nomes e endereços claramente sintéticos. Tokens vieram do manifesto local ignorado pelo Git e não aparecem na saída da CLI, logs ou arquivos versionados. O BFF usa a chave publicável e a credencial do próprio chamador; nenhuma chave administrativa foi introduzida.

## Limites preservados

Este incremento não conecta a rota canônica ao IndexedDB/UI, não implementa reordenação de execução, visitas, navegação externa, alteração de composição publicada ou cadastro real. `AB-12`, `AB-13` e `AB-15` permanecem respeitados.
