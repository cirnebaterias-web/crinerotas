# ADR 008 — Execução da coleta logística e conciliação da promessa

## Status

Accepted para implementação e homologação local — 2026-11-04. Associada à Story 4.17. Decisão de `@architect`, alinhada ao desenho de contratos de `@data-engineer` e à validação de escopo de `@po`. Não constitui parecer de QA nem implantação na VPS.

## Contexto e autorização

O usuário solicitou, no teste de 2026-11-04, nome/CNPJ/endereço/kg na operação de sucata do gestor, uma conta de operador de logística para consultar a rota diária no celular e registro de coleta efetiva ou não coleta. Pediu comparar o prometido com o realizado e tratar as divergências porque o deslocamento tem custo.

A ADR 004 e a Story 3.10 já implementam agenda de coleta, perfil `logistics`, coleta pelo vendedor, custódia e aceite da Cirne. A execução futura da agenda estava expressamente fora daquele recorte. O pedido atual autoriza esta extensão limitada e supera essa exclusão; não autoriza otimização de rotas, custos presumidos, rastreamento, SLA, push, integração financeira ou criação de identidades de funcionários por suposição.

O objetivo operacional de recolher o prometido não permite impor igualdade falsa ao operador. O fato realizado deve poder ser zero, inferior, igual ou superior à promessa; a diferença produz informação e revisão humana.

## Decisão e fronteiras

Acrescentar execução logística vinculada a `pickup_schedules`, no monólito modular existente, sem reutilizar `scrap_collections` ou `scrap_receipts` para esse fato. Essas entidades continuam representando, respectivamente, coleta do vendedor e recebimento da Cirne da ADR 004. A nova execução não cria visita, canhoto, fotografia ou aceite empresarial fictício.

Os comandos usam contratos compartilhados, serviço BFF, RPC transacional e CLI antes da UI. A interface do celular é uma consulta autenticada da rota atribuída; não se adiciona transporte de notificação. Fluxo inicialmente online: erro de conectividade conserva os campos em edição e não anuncia confirmação. O suporte offline existente de agendamento/visita permanece separado; não afirmar que a execução logística está em outbox se não estiver.

O desenho físico, índices, políticas e testes SQL pertencem a `@data-engineer`; esta decisão fixa semântica, interfaces e invariantes entre camadas. Migrações são incrementais porque as anteriores já foram aplicadas.

## Atribuição e promessa

A atribuição contém operador ativo, dia operacional, ordem, autor, horário do servidor e motivo. Gestor/administração com capacidade própria distribuem manualmente agendas visíveis. Alteração da ordem que colide com outra parada produz conflito explícito, sem renumerar registros que o comando não identificou. Não há algoritmo de otimização nem capacidade de carga presumida.

Na primeira atribuição, congelar o compromisso usado para o despacho: identidade do agendamento/cliente, nome, documento válido disponível, endereço histórico, kg prometidos e contexto de data/período/observação. O peso é o valor efetivo da agenda nessa versão; não apaga a solicitação original ou revisões feitas anteriormente. Reatribuição pode alterar operador/dia/ordem com auditoria, mas não a promessa congelada. A revisão antiga da agenda é recusada depois da primeira atribuição, evitando concorrência entre promessa despachada e formulário legado. Uma política futura de renegociação terá comando próprio; não é simulada por redução do peso prometido.

O documento vem de `api.clients.external_reference`, com normalização restrita de pontuação e validação de 11/14 dígitos. Exibir CPF para 11 e CNPJ para 14; conteúdo que não represente documento fica `null`/“Não informado”, nunca é convertido em CNPJ por preenchimento de zeros ou por outra referência. Antes da atribuição, a projeção pode ler o cadastro atual com o endereço preservado na agenda. Depois, a identificação do compromisso é o snapshot congelado. Não expor documentos fora do escopo operacional autorizado nem colocá-los em logs.

## Estado da tentativa, resultado e reconciliação

O estado técnico da agenda pode evoluir de `pending` para `completed` quando um resultado é registrado. Aqui `completed` significa **tentativa encerrada**, não “coleta integral cumprida”. Leitores legados de pendências devem filtrar `pending` e não receber um estado incompatível com seus contratos antigos. A nova projeção mostra o resultado explicitamente:

| Situação | Resultado | Kg reais | Apresentação |
| --- | --- | --- | --- |
| Sem execução | Ausente | Ausente | Pendente de execução |
| Coleta integral | `collected` | Igual à promessa | Coleta cumprida |
| Coleta parcial | `collected` | Positivo e menor | Coleta parcial; divergência pendente |
| Coleta acima da promessa | `collected` | Maior | Acima da promessa; divergência pendente |
| Tentativa sem coleta | `not_collected` | Zero | Não coletado; revisão pendente |

`collected` exige peso positivo; `not_collected` exige zero e motivo. Qualquer diferença exige motivo, conferido também no banco contra a promessa congelada. Peso é string decimal canônica na API e decimal no banco; não usar `Number`/ponto flutuante para a comparação de igualdade ou para produzir soma de volumes. Não há tolerância comercial aprovada.

`differenceKg = actualWeightKg − promisedWeightKg`, somente após execução. Ausência de resultado não é zero coletado. Totais mostram promessa de todos os itens retornados, realizado dos executados, quantidade pendente e diferenças **somente das tentativas executadas**. A UI rotula esse último recorte explicitamente; não apresenta o total de diferenças como simples subtração de realizado menos toda a promessa quando existem pendências.

O resultado inicial registra operador autenticado e horário do servidor. Chegar à data, selecionar um destino ou atribuir uma rota não cria realizado. Encerrar a tentativa não cria recebimento pela Cirne. Não somar promessa, coleta do vendedor, execução logística e transferência de custódia como quatro entradas independentes.

## Tratamento e correção auditados

Resultado divergente produz `reviewRequired`. Gestor/administração autorizados registram tratamento textual, com autor e horário, sem mudar peso, classificar automaticamente como cumprido, gerar crédito, cobrar multa ou reagendar. A anotação é a decisão humana disponível neste recorte; não representa prova de que uma diferença física deixou de existir.

Erros de registro têm comando separado de correção. Exige versão esperada, motivo obrigatório, resultado e kg efetivos válidos. Preservar `resultOriginal` imutável e eventos com antes/depois; `result` representa somente a versão efetiva corrente. Autor/data do registro original e autor/data da correção ficam distinguíveis. Nunca reescrever o primeiro operador como se o gestor tivesse feito a coleta inicial nem atribuir a correção ao operador por inferência.

A revisão gerencial está vinculada à versão do resultado. Correção invalida a ciência anterior; se o novo resultado divergir, retorna a revisão pendente. Diferença zero remove a necessidade, mas conserva toda a história. Retificação não cria segunda coleta e a soma usa uma única versão efetiva.

Após resultado, não permitir reatribuição do mesmo compromisso para produzir outra coleta silenciosa. Novo deslocamento ou reagendamento exige uma intenção própria; não é criado automaticamente pelo texto de tratamento desta versão.

## Autorização

Reutilizar identidade e papel `logistics` existentes; acrescentar capacidades estreitas:

| Operação | Condição mínima |
| --- | --- |
| Listar operadores aptos e distribuir/revisar/corrigir | Identidade ativa, `scrap.dispatch_pickups`, papel gestor/administrador e abrangência sobre o vendedor da agenda |
| Consultar rota pessoal e registrar resultado | Identidade ativa, papel `logistics`, `scrap.execute_pickups` e atribuição atual ao próprio usuário |
| Registrar resultado de outro operador | Negado, inclusive com UUID conhecido |
| Vendedor distribuir, executar ou tratar divergência | Negado |

Administrador só participa com capacidade explícita; gestor não ultrapassa `scopeIds`. Na nova consulta pessoal, possuir `scrap.read_operations` legado não cria visão global. Perfis múltiplos seguem a capacidade e a finalidade da operação, sem usar um bypass de leitura para execução. Mudança de atribuição revoga imediatamente execução pelo operador anterior. Perfil bloqueado/inativo é negado mesmo com token válido.

As regras são revalidadas no serviço e na RPC, sem confiar em papel, escopo ou coletor enviados pelo corpo. As tabelas de execução/histórico não recebem escrita pública; grants e funções de executor são estreitos. Requisições browser mantêm CSRF/origem do projeto; CLI usa Bearer. Leituras são privadas e sem cache compartilhado.

## Contratos e superfícies

Contrato compartilhado: `packages/contracts/src/logistics-pickups.ts`, `schemaVersion: 1` para esta superfície nova. A integração é distinta dos DTOs de agenda legados, que permanecem limitados a pendências.

| Superfície | Finalidade |
| --- | --- |
| `GET /api/v1/logistics/pickups?date=YYYY-MM-DD` | Gestor: itens não atribuídos com `desiredDate <= date`, incluindo atrasados, mais atribuídos para `routeDate = date`; operador: somente suas atribuições para a data |
| `GET /api/v1/logistics/operators` | Listagem mínima de identidades ativas aptas para distribuição, apenas por gestor/administração autorizados |
| `POST /api/v1/logistics/pickups/{scheduleId}/assignment` | Operador, dia, ordem e motivo; promessa congelada na primeira atribuição |
| `POST /api/v1/logistics/pickups/{scheduleId}/result` | Resultado e kg reais pelo operador atual; motivo se divergente/não coletado |
| `POST /api/v1/logistics/pickups/{scheduleId}/correction` | Correção gerencial de resultado com motivo; mantém original e invalida ciência anterior |
| `POST /api/v1/logistics/pickups/{scheduleId}/review` | Tratamento/ciência gerencial com motivo para o resultado vigente |

RPCs consolidadas com a implementação de dados: `api.list_logistics_pickups(date)`, `api.list_logistics_operators()` e `api.change_logistics_pickup(uuid, text, uuid, jsonb)`. O argumento de operação é allowlist de `assignment`, `result`, `correction`, `review`; não é nome arbitrário de função/tabela.

Toda mutação exige `expectedVersion` da agenda e chave idempotente; usa `schedule.version` como controle concorrente único, incrementado em cada mutação bem-sucedida. A RPC verifica acesso antes de retornar um replay privado. Chave repetida com payload igual repete resultado; conteúdo diferente gera conflito. Operação e ator integram o domínio da chave. Ordem ocupada e versão obsoleta geram erro acionável, sem merge silencioso.

A projeção retorna identidade mínima do cliente/vendedor, promessa, atribuição, `result`, `resultOriginal`, `review`, `reviewRequired` e eventos seguros de antes/depois. Não retorna linhas internas completas, credenciais ou dados de outras carteiras. A lista preserva todas as pendências selecionadas: eventual limite técnico deve falhar explicitamente ou paginar; não truncar silenciosamente a rota.

## Retenção, migração e compatibilidade

Preservar a retenção operacional da ADR 004: histórico/revisões/resultados não são apagados; pendentes permanecem mantidos, e encerramento/correções ampliam o marco aplicável em pelo menos cinco anos a partir do evento mais recente. Não acrescentar expurgo. Backups externos e recuperação efetiva continuam condição de produção, não comprovada por constraints SQL.

Os leitores antigos que serializam `status: pending` precisam continuar selecionando somente agendas pendentes. A migração que amplia o estado não pode fazer `get_scrap_operations`/agenda/exports retornarem `completed` para schemas que o rejeitam. Testar especialmente painéis mistos de coletas e pendências após a primeira execução logística.

Novas tabelas, ações e capabilities não alteram autorização da coleta do vendedor, upload/verificação do comprovante, aceite inicial da Cirne ou suas correções existentes. CNPJ é acrescentado na projeção operacional solicitada, sem alargar por consequência o CRM ou a base global acessível ao operador.

## Análise de impacto e verificação

Impacto alto por atravessar domínio, BFF, banco, identidade e UI. A extensão usa a stack e as fronteiras já existentes; não introduz serviço externo ou scheduler. Principais riscos e verificações:

- Acesso alheio: testar duas carteiras, dois operadores, revogação/reassociação, usuário bloqueado e chamadas diretas SQL.
- Promessa manipulada: testar revisão concorrente/prévia, congelamento, reatribuição e cadastro alterado depois do despacho.
- Estado enganoso: `not_collected` encerra tentativa, mas exibe zero e motivo; `pending` sem execução nunca é convertido em zero coletado.
- Dupla contagem: promessa 100 e realizado 80 produzem diferença -20, não 180; correção para 85 muda somente o realizado efetivo e mantém 80 no histórico.
- Conferência fora de versão: tratamento após correção exige nova versão; ciência antiga não cobre o novo fato.
- Compatibilidade: painéis/exports legados, coleta vendedor, anexos e recebimento Cirne permanecem válidos após existência de agendas encerradas.
- Recuperação: erro de rede, replay, chave conflitante, concorrência de ordem e resultado enviado pelo operador anterior não corrompem o ciclo.

Casos de referência: promessa 100 com realizado 100, 80, 120 e 0; motivos obrigatórios nas três divergências; correção auditada 80→85; total de diferenças considera somente executados enquanto há outra parada pendente. CLI→BFF→SQL e E2E móvel comprovam o ciclo; QA independente verifica os requisitos da Story 4.17.

## Consequências e limitações deliberadas

A gestão ganha comparação verificável entre compromisso e coleta e uma trilha de tratamento. O operador recebe uma lista diária executável no celular, com autorização pessoal. A identidade local de demonstração permite homologar sem presumir funcionário real; credenciais ficam no artefato local privado.

Esta entrega não calcula custo de transporte, não decide punição ou política comercial, não otimiza sequência, não implementa comprovante adicional não definido pelo pedido e não declara que o material já foi recebido pela Cirne. Esses fatos e decisões exigem seus próprios contratos quando solicitados. A hipótese de nova tentativa após coleta parcial permanece intenção humana futura; o sistema não gera deslocamento automático.

## Fontes

- Pedido do usuário e capturas de homologação de 2026-11-04; Story 4.17.
- `Docs/architecture/decisions/004-scrap-custody-scheduling-and-receipt.md`: separação de coleta, agenda, recebimento, acesso, auditoria e retenção.
- `Docs/architecture/decisions/002-visit-evidence-weighted-stock-and-scrap-boundary.md`: fronteira entre observação, venda e fatos de sucata.
- `Docs/architecture.md` §§9.7–9.12, 11.5–11.9, 15.1–15.2 e 16: autorização, versionamento, contratos e verificação.
- Inspeção do contrato `packages/contracts/src/logistics-pickups.ts` em 2026-11-04 e alinhamento com `@data-engineer`: operações, DTO, capacidades e uso de versão única.
