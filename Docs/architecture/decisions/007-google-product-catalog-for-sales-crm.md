# ADR 007 — catálogo Google de produtos no mini CRM

Data: 2026-11-03. Estado: decisão arquitetural para a Story 4.15; validação comercial de `@po` pendente antes de promover a story a Ready. Não autoriza ativação de fonte real, agenda ou implantação.

## Contexto

O usuário autorizou outro arquivo Google como base de produtos. A única aba autorizada é `Base produtos`, colunas A:R. A inspeção somente leitura da fonte, registrada na Story 4.15, encontrou 157 valores distintos de `Cód.Fábrica`, nenhuma duplicata ou chave obrigatória vazia, e correspondência exata dos 135 códigos observados em `Vendas.CódigoSKU`. Esses números descrevem a captura observada; não são limites nem garantias de capturas futuras. `Vendas` continua sendo a única fonte de fatos e métricas de compra, conforme ADR 006. O catálogo versionado de estoque da Story 3.6/ADR 002 tem finalidade e histórico próprios.

## Decisão

### Fonte, chave e validação

- A integração lê apenas os valores efetivos de `Base produtos!A:R`, com os 18 cabeçalhos exatos do AC1 da Story 4.15 e escopo Google somente leitura. Não busca abas referenciadas por fórmulas, inclusive `Produtos` ou `TAB PREÇO`. A identidade do arquivo fica na configuração privada, fora de contratos, logs e migrações.
- A chave comercial do catálogo CRM é `Cód.Fábrica`; o cruzamento é **igualdade exata** entre essa chave e `Vendas.CódigoSKU` após a normalização textual já aplicada ao SKU de vendas: retirar espaços nas bordas e normalizar Unicode NFC. Não converter caixa, remover zeros, hífens, espaços internos ou pontuação; não recorrer a descrição, `Cód. Cirne`, `SKU/base` ou combinação aproximada. Estes dois últimos são atributos, não aliases de identidade nesta story.
- Cada linha guarda posição original e valores validados da fonte para auditoria. Após normalização, `Cód.Fábrica` vazio, marcador `SEM TAB` ou chave repetida torna a **captura inteira inválida** e impede nova publicação; o diagnóstico privado identifica linhas e códigos técnicos sem derramar a planilha em logs. Repetição de um modelo ou descrição com chaves distintas é permitida e não é agrupada. A mesma chave com atributos divergentes não é deduplicada: também bloqueia a captura. Valores opcionais ausentes não criam atributos supostos.
- A reconciliação de uma geração publicada de vendas com uma geração publicada do catálogo classifica cada SKU de venda como `matched` ou `catalog_missing`. `ambiguous` é um diagnóstico de captura recusada, nunca uma associação escolhida ao acaso. SKU de venda sem catálogo continua nos fatos, métricas, histórico e top 10 com a descrição de `Vendas` e aviso de cadastro pendente. Reconciliar não altera nem reimporta vendas. A comparação é recalculada para o par de gerações consultado; o diagnóstico privado registra quantidade e códigos sem expor a base inteira ao vendedor.
- Produtos presentes somente no catálogo são elegíveis à lista **“Sem compra registrada no histórico disponível”** quando sua chave é única e não há venda positiva desse código para o cliente em toda a geração de vendas disponível. Assim os 22 códigos observados apenas no catálogo podem aparecer como oportunidade, sem afirmar que nunca foram comprados ou que estejam disponíveis. Uma devolução não apaga uma compra positiva anterior. SKU de venda sem correspondência não vira oportunidade do catálogo. Mudança posterior de chave é remoção/inclusão entre gerações, sem alias automático.

### Publicação e autoridade

A captura segue CLI primeiro, com atualização manual forçada e consulta de estado. O adaptador valida cabeçalhos, limites, tipos, chaves e captura completa; duas leituras integrais consecutivas com hash canônico igual reduzem o risco de edição concorrente no Google, sem alegar transação da Sheets API. Apenas uma publicação validada troca o ponteiro corrente em transação. Tentativas, horários, quantidade, hash, identidade técnica e gerações anteriores permanecem auditáveis; repetição idempotente não cria geração divergente. Falha mantém a última versão publicada e um estado de erro distinto. A agenda do catálogo inicia desabilitada e não herda 06:15 de `Vendas`.

Usar capacidade própria de sincronização de catálogo e pareamento privado **fonte + ator técnico** em cada etapa SQL de início, staging, publicação, falha e status. A allowlist nasce vazia; bloqueio ou revogação impede continuar e publicar. Não inferir autorização a partir de `sales.sync`, `clients.import`, gestão de visitas ou uma URL recebida do navegador. O BFF valida entrada e usa o mesmo serviço do CLI; uma eventual ação visual somente solicita execução assíncrona/consulta estado, sem carregar a planilha no navegador. Fonte, credencial, preço e linhas brutas não aparecem em respostas operacionais ou logs.

O desenho físico de tabelas, constraints, índices e RPCs cabe a `@data-engineer`, em **migração incremental** após as migrações já aplicadas. A fronteira mínima é: fonte privada/ator/ponteiro; execução e lease; chunks de staging; linhas imutáveis por geração; diagnósticos privados; RPCs estreitas para comando, status e leitura de projeção por cliente. Staging nunca é visível ao CRM. A leitura direta pela Data API deve aplicar as mesmas permissões, sem bypass por chamada à função. Não alterar as tabelas de fatos de vendas nem o catálogo/linhas de estoque de visita.

### Contexto consistente de leitura

O contexto do detalhe passa a fixar **`salesGenerationId`, `catalogGenerationId`, `asOfDate` e `clientVersion`**. A primeira chamada autorizada deve capturar os dois ponteiros e a versão do mesmo cliente em um retrato SQL coerente. Cada página posterior apresenta o contexto completo; o banco revalida o escopo atual do cliente e verifica ambos os ponteiros, data e versão antes de devolver fatos/produtos. Mudança durante uma leitura inicial descarta dados parciais e permite reinício integral uma vez; paginação com contexto fixado responde `409 VERSION_CONFLICT` e solicita recarga. Nunca somar páginas de pares de gerações diferentes. Uma versão antiga preservada para auditoria não concede acesso de leitura após revogação atual.

Sem catálogo publicado, o detalhe de vendas continua acessível com estado explícito `catalog_unavailable` e oportunidades indisponíveis; uma lista vazia só significa zero oportunidades quando existe catálogo válido. Fonte indisponível durante atualização mantém o último snapshot publicado e informa falha/atraso operacional. A indisponibilidade do CRM não bloqueia rota, check-in nem visita.

### Contrato comercial e compatibilidade

O histórico e as fórmulas do ADR 006 permanecem iguais. Top 10 mantém SKU, descrição e volume vindos de `Vendas`; enriquecimento cadastral opcional vem do catálogo pareado e traz sua procedência. O DTO de oportunidades da Story 4.14 é baseado em campos de `Vendas` e não representa fielmente produtos exclusivos do catálogo. Evoluí-lo com **`schemaVersion: 2`** e tipo explícito de item de catálogo (`factoryCode`/SKU, descrição e somente atributos aprovados), estado de disponibilidade do catálogo, cobertura observada e os quatro marcadores de contexto. Não preencher artificialmente `itemGroup`, `line` ou outros campos de vendas a partir de colunas distintas do catálogo. Atualizar CLI, BFF e UI juntos; leitores de v1 devem falhar por versão incompatível ou receber adaptação explícita, nunca reinterpretar o DTO silenciosamente. Ordenação/paginação é estável por chave de fábrica e as páginas são limitadas.

A projeção por cliente entrega apenas top 10 e página de oportunidades autorizadas, não um endpoint de catálogo global. Revalidar `sales.read_client` e o escopo atual do cliente em toda chamada; administrador não recebe bypass. `Preço médio mercado (R$)` pode ser retido na evidência privada, mas não integra DTO, CLI de leitura comercial, CRM, logs nem cálculos nesta story. Peso, dimensões e aplicações, se a projeção de produto os aprovar, são referência cadastral; a UI não promete estoque, disponibilidade, preço de venda ou compatibilidade garantida.

## Consequências e verificação

- Catálogo e vendas têm ciclos de publicação independentes. O par de versões aparece no detalhe e evita que uma atualização de produtos altere retrospectivamente o sentido de uma página de histórico já aberta.
- Dados de compra fora do catálogo permanecem corretos; o operador recebe diagnóstico para corrigir a fonte sem perder fatos. Uma duplicata futura bloqueia nova publicação e mantém a última versão válida.
- A migração é aditiva. A Story 3.6 continua usando seus pesos e snapshots de visita, inclusive versões anteriores; nenhuma visita é recalculada.
- Testar captura alterada entre duas leituras, chave vazia/`SEM TAB`/duplicada, SKU de vendas ausente, código exclusivo do catálogo, devolução após compra, troca simultânea de qualquer geração, mudança de documento/escopo do cliente, revogação do ator, acesso direto à Data API, falha de importação sem perda do snapshot e ausência de preço em todo DTO. Testar compatibilidade de CLI/UI v2 e regressão das fórmulas da 4.14 e dos fluxos de visita/rota.

## Pontos para validação de produto e operação

`@po` deve confirmar o significado comercial de usar `Cód.Fábrica` como chave única e de incluir códigos exclusivos do catálogo na lista com o rótulo de histórico limitado. A observação atual 135/135 apoia a decisão, mas não substitui essa validação. A cadência automática, autoridade de exibição de preço e possível migração do catálogo de estoque são decisões futuras separadas. Credenciais, carga real, retenção e implantação exigem os gates operacionais já registrados nas Stories 4.13–4.15.

## Referências

- Pedido do usuário e inspeção somente leitura registrados em `Docs/stories/4.15.story.md`.
- `Docs/architecture/decisions/006-sales-history-client-crm.md` e Stories 4.13–4.14.
- `Docs/architecture/decisions/002-visit-evidence-weighted-stock-and-scrap-boundary.md` e Story 3.6.
- `Docs/architecture/decisions/005-google-sheets-client-sync.md` para padrão de fonte/ator privados.
