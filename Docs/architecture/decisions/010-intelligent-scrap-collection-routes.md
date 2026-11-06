# ADR 010 — Rotas inteligentes de coleta de sucata independentes do operador

## Estado

Proposto em 05/11/2026 para a Story 4.23. Complementa a ADR 008 e a Story 4.17, que permanecem fonte de verdade para promessa, resultado, divergência e auditoria.

## Decisão

Criar um agregado de rota de coleta separado dos agendamentos e do operador. A rota possui identidade única estável, data, versão, estado e paradas versionadas. A atribuição do operador é uma relação posterior; reatribuir não recria a rota.

Estados mínimos: `draft`, `approved`, `assigned`, `in_progress`, `completed`, `cancelled`. `assigned` exige operador ativo; `in_progress` começa no primeiro resultado; `completed` é derivado atomicamente quando todas as paradas vigentes possuem resultado terminal. Não usar a posição numérica da última parada como atalho de encerramento.

Cada parada preserva referência ao agendamento, snapshot de lojista/endereço/kg, ordem sugerida, ordem aprovada e, após execução, ordem/instante efetivos. Parada executada é histórica e não pode ser removida ou reescrita.

## Sugestão geográfica

A primeira versão será determinística e explicável. Ela calcula proximidade aproximada somente quando existem coordenadas válidas, escolhe um ponto inicial estável a partir do próprio conjunto e ordena os próximos clientes por proximidade, com desempate estável por identificador. Como não existe operador atribuído nessa fase, não usa GPS, residência ou localização do motorista.

Place ID e endereço Google são destinos de navegação, mas não justificam distância numérica sem coordenada resolvida. Paradas sem coordenadas permanecem na rota com pendência geográfica e são posicionadas para revisão manual; nenhuma coordenada é inventada pelo texto do endereço.

Essa heurística reduz deslocamentos óbvios, mas não afirma ser rota rodoviária ótima, pois não incorpora trânsito, restrições viárias, veículo, capacidade ou tempo de serviço. Um provedor de matriz rodoviária poderá substituir o adaptador futuramente, preservando contrato, versão da política e justificativas, após avaliação de custo e privacidade.

## Aprovação e execução

O motor retorna sugestão; o gestor aprova ou altera. Somente a versão aprovada pode ser despachada. Mudança posterior cria nova versão, preservando execuções. Atribuição do operador não altera identidade nem ordem por si só.

A tela do operador é uma lista, não um painel de planejamento: identificador, data, progresso e cards numerados com lojista, endereço e kg. Documento/observação ficam em detalhe. Cada parada reutiliza os comandos de resultado da ADR 008. Ao confirmar a última pendência, o servidor conclui a rota e a UI apresenta confirmação; não existe segundo botão obrigatório de encerramento.

## Integridade e autorização

- Um agendamento não aparece duas vezes na mesma versão nem em duas rotas ativas conflitantes.
- Identidade da rota e versões são distintas; idempotência impede duplicação.
- Gestor planeja dentro do escopo; operador lê/executa somente a rota atribuída.
- O servidor recalcula a condição de conclusão na mesma transação do resultado.
- Resultado logístico não é crédito oficial nem recebimento da Cirne.
- Logs e auditoria preservam política geográfica, versão das entradas, ordem sugerida/aprovada/efetiva e autor das mudanças.

## Consequências

O operador recebe uma jornada simples e o gestor mantém controle sobre a sugestão. A ausência de motorista não bloqueia o planejamento. A qualidade da ordem depende das coordenadas disponíveis e é declarada honestamente. Mapa, rastreamento contínuo, custos e otimização rodoviária externa permanecem fora desta primeira versão.
