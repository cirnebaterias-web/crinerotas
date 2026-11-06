# ADR 006 — Histórico de vendas e mini CRM por cliente

## Status

Accepted para implementação local — 2026-11-03. Stories 4.13 e 4.14. Não autoriza ativar credenciais, importar dados reais no ambiente sintético, instalar timer na VPS ou declarar a integração produtiva ativa.

## Origem e fronteira

O usuário solicitou leitura diária da aba `Vendas`, histórico de 12 meses ao abrir o cliente, dias desde a última compra, periodicidade, gráfico de volume de seis meses, média mensal, dez produtos mais comprados, produtos ainda não comprados e sinais para apoiar o planejamento de rotas. Confirmou o horário diário **06:15, America/Sao_Paulo**, o uso **exclusivo da aba Vendas** como universo de produtos e que o aplicativo deve refletir a fonte atual, preservando versões anteriores. A aba `Produtos` não está autorizada.

O pedido amplia o MVP descritivo do PRD, mas não autoriza integração direta com Orion, IA, previsão, otimização avançada, criação/publicação automática de rota ou mutação de sucata. Permanecem válidas as fronteiras de `Docs/prd.md` §1.6, FR-002/004/005/009 e `Docs/architecture.md` §7.5, exceto a nova leitura Google explicitamente pedida. A ADR 002 continua separando venda, estoque observado e movimentos de sucata. A sincronização de clientes da ADR 005 não é substituída.

As fórmulas abaixo são decisões técnicas transparentes para concretizar o pedido, não políticas comerciais individualmente ditadas pelo usuário. Serão apresentadas com janela, unidade e cobertura observada.

## Fonte e normalização

A descoberta autorizada identificou cerca de 26 mil registros, 38 cabeçalhos e `CHAVE UNICA` preenchida e única na fotografia observada. Isso não prova estabilidade da chave entre atualizações. Nenhum ID privado de planilha, linha real, CPF/CNPJ, nota ou nome de cliente integra este documento ou fixtures.

| Coluna | Cabeçalho | Uso mínimo |
| --- | --- | --- |
| B | CNPJ/CPF | Referência externa normalizada; vínculo ao cliente atual |
| I | Num. Nota Fiscal | Documento textual, sem remoção de zeros |
| J | Data da Venda | Data canônica do evento, calendário `d/m/yyyy` ou `dd/mm/yyyy` |
| K | CódigoSKU | Identidade textual do produto |
| L | Volume | Quantidade inteira com sinal |
| M | Valor Total Moeda Local | Valor decimal com sinal, JSON decimal string canônica e PostgreSQL numeric(12,2) |
| R | Descrição do Item | Descrição para exibição |
| S/T | Grupo do Item / Subgrupo do Item | Classificação observada |
| AB/AC/AD | Categoria / Marca / Fabricante / Linha | Atributos observados do produto |
| AH | Devolução | Discriminador `Venda` / `Devolução` |
| AL | CHAVE UNICA | Identidade de linha dentro da geração |

Validar o vetor oficial de 38 cabeçalhos antes de usar posições. O cabeçalho AC é um único campo chamado `Marca / Fabricante`. A coluna U/V (`Custo Unitário`/`Custo Total`) não é solicitada nem persistida pelo novo adaptador. Os valores de `Quantidade Geral` em AI são positivos inclusive em devoluções e não representam volume líquido. `Data da Última Compra`, em AA, não é usada: recência é recalculada a partir de J. Campos de vendedor histórico e atual não concedem acesso e não alteram carteiras.

Venda exige volume positivo e valor não negativo; devolução exige volume negativo e valor não positivo. Não aplicar `abs()` nem inverter o sinal outra vez. Tipos desconhecidos, documentos/chaves ausentes, duplicidade de chave, data impossível ou divergência de sinal impedem publicar a geração. Datas são validadas em calendário, sem `Date.parse` ambíguo. Não transformar os limites observados de quantidade em limites comerciais. Utilizar limites técnicos explícitos de tamanho/contagem e falhar, sem truncamento, quando excedidos. Volume é inteiro de magnitude máxima 1.000.000; dinheiro permanece string decimal canônica, nunca ponto flutuante ou centavos numéricos na API.

## Aquisição e publicação

### CLI one-shot, fonte privada e leitura repetível

A CLI é o executor diário. Obtém uma sessão nova da identidade técnica Supabase, inicia o run pelo BFF, lê a projeção autorizada no Google, valida, envia lotes limitados ao BFF e solicita publicação. Não executar um job longo em React, em `setInterval` do Next.js ou em uma requisição de navegador. O timer é um artefato de implantação ainda desabilitado, separado dos horários de clientes (06:00/13:00).

O timer dispara às 06:15; recuperação agendada aceita somente 06:15–06:59 no mesmo fuso, com a mesma intenção diária `YYYY-MM-DD@06:15`. Fora da janela, somente intenção manual explícita. Lease de dez minutos, sem renovação implícita. A resposta perdida do início pode ser retomada pelo mesmo ator/intenção com a lease ainda válida; resultado terminal é replay sem nova publicação.

Reutilizar princípios e componentes de transporte/credenciais da Story 3.13, sem relaxar os limites, cabeçalhos ou regras do importador de clientes. Não chamar `execute_client_import` para fatos de vendas. A nova operação possui contratos e autoridade próprios.

Usar Sheets API `values.batchGet` para o cabeçalho A1:AL1 e projeções B, I:M, R:T, AB:AD, AH, AL. Os valores devem ser alinhados pelo índice da linha original, preenchendo ausências de ranges esparsos; não juntar arrays truncados por posição sem preservar sua origem. Nunca buscar outras abas. Endpoints Google são constantes, com redirecionamentos recusados, timeout e leitura limitada; segredos e mensagens/células do provedor não entram em logs.

Para não exigir escopo OAuth de Drive, realizar duas leituras integrais consecutivas da projeção e comparar o hash da representação canônica. Divergência impede a publicação e mantém a geração anterior. Isso verifica repetibilidade das leituras observadas, não promete um snapshot transacional fornecido pelo Google nem ausência de alteração depois da segunda leitura. Falha de rede/quota/leitura/validação nunca ativa staging parcial. Backoff tem limite e respeita `Retry-After` quando disponível.

### Gerações imutáveis

Persistir uma geração completa por atualização efetiva. As chaves são únicas dentro da geração, não precisam identificar eternamente a mesma linha entre versões. Corrigir ou remover uma linha na fonte aparece na próxima geração publicada; gerações anteriores não são sobrescritas ou apagadas. Mudança de `CHAVE UNICA` não duplica o resultado corrente porque o leitor usa somente uma geração.

Publicar o ponteiro da fonte em uma transação somente após conferir lease, ator autorizado, quantidade esperada, integridade de chunks, hash e validação da geração. Staging não é acessível por leitores CRM. Repetir a mesma intenção/chunk é idempotente; conteúdo divergente sob a mesma chave é conflito. Um executor cuja lease expirou não pode publicar depois de um sucessor.

Conteúdo igual pode reutilizar a geração publicada sem copiar novamente todas as linhas, mas registra a nova tentativa/horário de leitura. A execução e sua identidade são distintas do hash do conteúdo. Não adicionar expurgo automático: retenção e capacidade de gerações ficam como gate de produção, pois copiar todo o histórico diariamente tem custo cumulativo.

## Modelo e contratos mínimos

O desenho físico é de `@data-engineer`, preservando os seguintes objetos privados:

- `sales_sources`: hash opaco da fonte, ator técnico autorizado e ponteiro da geração publicada;
- `sales_sync_runs`: intenção, trigger, identidade, lease/fencing, versão do parser, hash, horários, contagens e cobertura observada;
- `sales_sync_chunks`: índices/contagens/hash de lotes persistidos para replay verificável;
- `sales_snapshot_lines`: geração, chave da linha, documento normalizado, NF, data, SKU, descrição/classificação, tipo, volume e valor assinados;
- `sales_sync_issues`: linha e código técnico, sem cópia integral da célula ou custos.

Contrato mínimo de linha: `sourceRow`, `externalKey`, `clientExternalReference`, `invoiceNumber`, `saleDate` ISO de calendário, `sku`, `productDescription`, `itemGroup`, `itemSubgroup`, `category`, `brand`, `line`, `kind: sale | return`, `volume` inteiro assinado, `totalAmount` string decimal canônica assinada, por exemplo `-3198.00`. Documento normalizado tem 11 ou 14 dígitos; chave externa até 256 caracteres, NF/SKU até 80, descrição até 240 e classificações até 80. Hashes têm 64 caracteres hexadecimais.

Limites técnicos iniciais: 100.000 linhas por geração, até 1.000 linhas por chunk na RPC, chunks de 500 no CLI respeitando também corpo de 1 MiB e até 32 MiB por leitura Google. Exceder qualquer limite falha explicitamente; não se corta a fonte. Publicação vazia falha, preservando a geração anterior.

Canonicalização: hash por linha = SHA256 UTF-8 do JSON compacto da tupla `[sourceRow,externalKey,clientExternalReference,invoiceNumber,saleDate,sku,productDescription,itemGroup,itemSubgroup,category,brand,line,kind,volume,totalAmount]`. Hash do chunk/geração = SHA256 da concatenação dos hashes de linha em ordem crescente de `sourceRow`. O SQL recompõe a tupla escalar sem espaços, confere os hashes e recusa conteúdo divergente; não confia exclusivamente no checksum recebido.

Nomes públicos consolidados: `GET /api/v1/sales-sync`, `POST /api/v1/sales-sync/runs` e `POST /api/v1/sales-sync/runs/{runId}/{stage|publish|fail}`. Configuração privada `GOOGLE_SALES_SYNC_*`, CLI `ops:sales-sync`, capacidade de ingestão `sales.sync` e leitura `sales.read_client`. Fonte única Vendas: configuração singleton de propriedade administrativa com pareamento obrigatório do ator também para intenção manual. Status distingue `latestRun` de `lastPublishedRun`; identificador real da planilha nunca integra a resposta.

Fronteiras de comando acordadas para detalhamento na implementação:

| RPC | Responsabilidade |
| --- | --- |
| `begin_sales_sheet_sync` | Autorizar fonte/ator, reservar intenção e lease, retornar run ou replay |
| `stage_sales_sheet_sync` | Gravar chunk validado idempotente sob a mesma lease |
| `publish_sales_sheet_sync` | Validar geração completa e trocar ponteiro atomicamente |
| `fail_sales_sheet_sync` | Registrar falha sanitizada sem substituir última geração válida |
| `get_sales_sheet_sync_status` | Consultar último estado autorizado, distinguindo tentativa e publicação |
| Leitura CRM por `clientId` | Retornar uma geração identificada, dados/agregados mínimos e histórico paginado autorizado |

Cada resposta CRM identifica `generationId`, `asOfDate`, `clientVersion`, janelas, `observedMinDate`, `observedMaxDate`, `coverageStatus: observed_only`, último sucesso e condição de desatualização. Min/max de datas observadas não comprovam que o extrato original está completo. Histórico paginado conserva geração, data de referência e versão cadastral entre páginas. Consultas posteriores reavaliam autorização atual, mesmo quando o cursor aponta para geração anterior.

## Autorização e minimização

A escrita de vendas tem autoridade própria, vinculada à fonte e ao UUID técnico também no SQL. Não basta esconder o botão no BFF, possuir `clients.import` ou enviar `trigger=scheduled`. A allowlist começa vazia e é provisionada por administração de banco, sem endpoint público de configuração. Início, staging e publicação verificam capacidade atual e o vínculo; revogação durante a coleta impede publicação.

Leitores consultam por UUID de cliente. O servidor resolve o CPF/CNPJ atual e aplica `api.clients`/`api.client_seller_scopes` e os escopos atuais do gestor. Vendedor não recebe importação ou edição de clientes para abrir o CRM. A matriz de capacidades de leitura será explícita na story/migração, sem inferência a partir de nome/e-mail presente na planilha. Clientes não encontrados ficam privados/não vinculados; não são criados automaticamente nem associados por nome aproximado. Clientes inativos podem manter histórico autorizado, mas não se tornam elegíveis para novas rotas por terem vendas.

### Diagnóstico de vínculo na publicação — complemento de AC7

Cada linha permanece no snapshot validado, inclusive quando não pode ser consultada pelo CRM. O diagnóstico privado distingue `CLIENT_NOT_FOUND` (documento sem cadastro correspondente) de `CLIENT_WITHOUT_ACTIVE_SCOPE` (cadastro correspondente sem nenhum vínculo em `client_seller_scopes` com `revoked_at IS NULL`). A verificação considera todas as carteiras, não a abrangência pessoal do importador técnico: a fonte global autorizada não torna problemático um cliente vinculado a outra carteira. Status do cliente ou do vendedor não é um novo critério de diagnóstico neste ajuste.

Os motivos são mutuamente exclusivos por linha. `issueCount` soma as linhas dos dois motivos; `unmatchedClientCount` continua contando somente documentos distintos sem cadastro. Não acrescentar campo público, descartes, bloqueio de publicação, concessão automática de vínculo ou alteração de vendas. Os diagnósticos refletem o cadastro no momento da publicação e ficam preservados com a geração, inclusive em replay; não são um inventário vivo de permissões. Leituras CRM continuam reavaliando os vínculos atuais. Uma correção cadastral posterior pode liberar uma leitura autorizada, mas não reescreve os contadores históricos.

Implementar o complemento por migração incremental, pois `20261105120000_sales_sheet_sync.sql` já foi aplicada localmente. Testar cliente existente sem vínculo, vínculo somente revogado, vínculo ativo fora da abrangência do importador, motivo desconhecido separado, preservação dos fatos e replay após mudança de vínculo. Não recalcular retroativamente gerações publicadas.

DTO de vendedor não inclui custos, margem, totais de outros clientes nem a base inteira. A consulta de um cliente não é um caminho indireto para consultar outro por CPF/CNPJ ou cursor. Respostas são privadas e sem cache compartilhado. O CRM inicial é online e independente do fluxo crítico offline: indisponibilidade do histórico não bloqueia a rota, check-in ou formulário de visita.

## Definições das métricas

O servidor fixa a data de referência no calendário `America/Sao_Paulo`. Dados futuros não participam dos indicadores correntes. O histórico de 12 meses usa **12 meses-calendário incluindo o atual**: do primeiro dia do mês de 11 meses atrás até a data de referência, inclusiva. A UI informa a janela exata e marca o mês atual como parcial. Isso não é uma janela móvel de 365 dias nem produz um décimo terceiro bucket mensal. O gráfico de seis meses e a média usam somente meses completos, conforme abaixo.

| Indicador | Cálculo e limite interpretativo |
| --- | --- |
| Dias desde a última compra | Data de referência menos a maior `Data da Venda` de uma Venda positiva no histórico disponível do cliente; devolução não reinicia o contador. Sem Venda, retorna `null`, não um número fictício. |
| Periodicidade | Média dos intervalos em dias entre datas distintas com Venda positiva na janela de 12 meses. Mínimo de duas datas; mostrar contagem de datas/intervalos. Uma NF com vários SKUs ou várias NFs no mesmo dia não cria intervalos zero artificiais. |
| Volume de seis meses | Seis meses-calendário completos imediatamente anteriores ao mês de referência; soma de `Volume` com sinal por mês, incluindo devoluções. Meses sem registros aparecem como zero com o aviso de cobertura observada. |
| Média mensal de baterias | Soma líquida desses seis meses dividida por seis, incluindo meses sem registros; não extrapolar o mês corrente parcial. Rótulo: últimos seis meses completos. |
| Dez produtos mais comprados | SKU por volume líquido na janela de 12 meses, somente totais positivos, ordem decrescente e desempate estável por SKU. Retornar menos de dez quando não houver dez produtos elegíveis. |
| Produtos sem compra registrada | Universo DISTINCT SKU em todas as linhas válidas da aba Vendas, menos SKUs com ao menos uma Venda positiva do cliente em todo o histórico disponível. Devolução não apaga o fato de já ter comprado. A presença no universo não prova disponibilidade/atividade comercial atual. |

Nunca apresentar ausência no recorte como certeza de que o cliente jamais comprou. A expressão da UI é **“sem compra registrada no histórico disponível”**, acompanhada de cobertura. Devoluções sem vínculo à NF original não autorizam inventar cancelamento retroativo de uma compra nem reescrever sua data.

O sinal de rota é explicável: comparar dias desde a última Venda com a periodicidade observada quando ela existir, exibindo ambos e a quantidade de observações. Não criar escore oculto, porcentagem de previsão, urgência inventada ou publicação automática. O gestor mantém seleção, prioridade, ordem e confirmação da rota pelos comandos existentes. Clientes fora da abrangência/inativos permanecem excluídos das novas rotas, ainda que um indicador sugira contato.

## Complemento de leitura da Story 4.14 — contratos aprovados

Consolidado após validação formal `@po` Ready e início da implementação local da Story 4.14. Mantém as fórmulas anteriores, sem nova autorização de produto, dados reais ou implantação. Contratos, domínio, BFF e CLI antecedem a interface; alterações SQL seguem migração incremental por `@data-engineer`.

### Uma geração, uma data de referência e um vínculo cadastral consistente

O carregador do detalhe compara **`generationId`, `asOfDate` e `clientVersion`** em todas as páginas de fatos e produtos, além dos metadados já conferidos. `get_client_sales_products` passa a retornar também `asOfDate` e `clientVersion`. O servidor deriva a data do calendário `America/Sao_Paulo`; ela não é substituída pela data de planejamento nem por uma data arbitrária enviada pela UI.

O mesmo UUID/nome de cliente pode receber outro CPF/CNPJ durante a paginação, alterando quais fatos lhe correspondem sem mudar a geração de vendas. `clientVersion` é o inteiro positivo de `api.clients.lock_version`, incrementado pelo trigger existente em toda atualização cadastral, inclusive importação oficial. O contexto SQL o obtém do **mesmo registro de cliente** usado para resolver a referência externa; não expor o documento ou seu hash, criar outra versão paralela ou manter locks entre requisições. Alteração cadastral sem troca de documento também pode invalidar a captura de forma conservadora. Versão cadastral não é versão de autorização: os vínculos e a identidade continuam revalidados a cada chamada, pois mudança em `client_seller_scopes` não necessariamente atualiza `api.clients`.

Se geração, data ou versão cadastral mudar durante uma leitura sem referência previamente fixada, descartar todo o resultado parcial e reiniciar a captura completa no máximo uma vez. Leitura com referência já fixada pelo chamador retorna **409 `VERSION_CONFLICT`**, sem trocar silenciosamente de contexto. Nas próximas páginas, o cursor público exige a **tripla completa**; a comparação ocorre antes de incorporar linhas ou produtos. Data/versão esperadas são guardas de consistência, nunca parâmetros de autorização ou de escolha de cadastro histórico. Não combinar páginas obtidas antes/depois de uma publicação, da meia-noite operacional ou da alteração do vínculo documental do cliente.

### Sinais somente para os clientes visíveis

A RPC de lote `get_sales_route_signals(p_seller_id, p_client_ids, p_snapshot_id = null)` recebe **1–50 UUIDs únicos** de clientes. O planner existente envia os **25 clientes da página visível**. Não criar paginação global adicional nem consultar o detalhe individual em laço: uma chamada SQL agrega apenas os IDs solicitados, evitando N+1 e a transferência desnecessária de toda a carteira.

O banco exige identidade ativa com **`route.plan_scoped` e `sales.read_client`**, vendedor ativo/não bloqueado dentro de `scopeIds` e, para **cada** ID, cliente ativo, não arquivado e com vínculo atual àquele vendedor. Não há bypass de administrador nem autorização pela carteira histórica da venda. Qualquer cliente inexistente, inativo, arquivado ou fora da carteira rejeita o lote inteiro com **404**; não retornar lista parcial nem omitir silenciosamente um ID. Cliente autorizado sem compras continua presente, com ausência de compra/ciclo explícita e volume registrado zero sujeito ao aviso de cobertura observada.

A resposta identifica vendedor, geração, `asOfDate`, captura/publicação e intervalo observado, além das linhas identificadas por `clientId`; a UI relaciona os resultados pelo ID, não pela posição do array. Todos os agregados da chamada usam o mesmo contexto de geração/data. Projeção mínima de estatísticas por cliente:

- `lastPurchaseDate`: maior data de Venda positiva em todo o histórico até `asOfDate`, ou ausência explícita;
- `purchaseDayCount12`: número de datas distintas com Venda positiva nos 12 meses-calendário definidos;
- `intervalTotalDays12`: diferença entre a última e a primeira dessas datas, suficiente para a soma dos intervalos consecutivos;
- `netVolume6`: soma assinada de Volume nos seis meses completos anteriores ao mês de referência.

O domínio compartilhado deriva recência, periodicidade, média mensal e sinal exatamente como no detalhe. Para `n >= 2`, periodicidade é `intervalTotalDays12 / (n - 1)`; para menos de duas datas, é `null`/histórico insuficiente. Média é `netVolume6 / 6`. Não acrescentar `salesVolume6`, `returnVolume6` ou `netVolume12` ao DTO mínimo de métricas/sinais. A série mensal do detalhe continua mostrando venda, devolução e líquido por mês para explicar o resultado, sem alterar a fórmula do gráfico.

No BFF, a consulta de sinais recebe vendedor, IDs e `serviceDate` do contexto do planner. **`serviceDate` serve somente como contexto/eco**, não modifica `asOfDate`, janelas ou autorização. A UI pode oferecer **“Ordenar esta página”**, limitada aos clientes visíveis: consultar ou ordenar sinais não seleciona clientes, muda prioridades, reordena a composição ou publica a rota. Troca de vendedor, data, página ou filtro invalida os sinais anteriores; respostas antigas são abortadas ou ignoradas antes de atualizar a tela.

O lote permanece mínimo, com `client: { id, name }`, sem acrescentar uma versão apenas para navegação. Ao abrir o mini CRM a partir dos sinais, iniciar uma **nova consulta sem contexto previamente fixado**, em vez de herdar geração/data do lote sem possuir a versão cadastral correspondente. O detalhe obtém e fixa sua própria tripla para todas as páginas seguintes, exibindo seus metadados atuais.

### Ausência de geração não é ausência de cliente

Depois de validar a autorização do cliente — ou de todos os clientes/vendedor no lote — ausência de uma geração publicada produz `SALES_UNAVAILABLE` no banco. O BFF a traduz para **503 `DEPENDENCY_UNAVAILABLE`**, com motivo **`no_published_generation`** e texto de histórico ainda não disponibilizado. Não chamar esse estado de `not_configured`, pois uma fonte corretamente configurada pode ainda não ter a primeira publicação. Não revelar a disponibilidade da fonte antes da autorização.

`NOT_FOUND` continua protegendo cliente inexistente/não autorizado; geração válida sem compras do cliente é sucesso com estado vazio explícito. Indisponibilidade de transporte, ausência de geração e ausência de compras permanecem distintas. A consulta não exige ativar a captura Google, não expõe configuração privada e não bloqueia os fluxos existentes de visita ou rota.

Verificar em testes: lote de 1/50 IDs e excesso/duplicatas, rejeição integral com um ID inválido, cliente autorizado sem compras, revogação atual, mudança de geração/data/versão entre páginas inclusive produtos, documento alterado com UUID/nome/geração iguais e posterior retorno ao valor anterior, reinício único versus 409 fixado, mesmas métricas no detalhe e no lote para o mesmo contexto, `serviceDate` sem efeito analítico, ordenação só da página e resposta obsoleta sem mutação de rota.

## Sequência e verificação

Story 4.13: contratos e normalizador, CLI de aquisição, staging/publicação, scheduler desabilitado, consulta operacional e testes sintéticos. Story 4.14: leitura CRM autorizada, métricas, entrada ao abrir o cliente, histórico/gráfico e apoio explícito ao planejamento.

Testar: cabeçalhos, datas sem zero, CPF/CNPJ/SKU com zeros, devolução assinada sem segunda inversão, duplicidade, linha sem cliente, limites sem truncamento, duas leituras divergentes, chunk repetido/conflitante, crash antes da publicação, lease expirada, ator revogado, chamada direta à Data API, troca de geração entre páginas, custos ausentes de contratos/respostas/logs, transferência de carteira, período sem compras, uma única data, várias NFs no mesmo dia, empate no top dez e histórico insuficiente. Cobrir mês parcial, virada do ano e ano bissexto.

Antes de dados reais: aplicar controles de privacidade/retenção existentes, definir retenção/capacidade das gerações, provisionar credenciais e allowlist, validar a carga real em ambiente autorizado e observar a execução agendada. O código e testes locais não substituem esses gates. Procedimento: `Docs/runbooks/google-sales-sync.md`.

## Fontes técnicas

- [Sheets values.batchGet](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchGet): projeção de ranges em uma chamada com escopo read-only.
- [Limites da Sheets API](https://developers.google.com/workspace/sheets/api/limits): payload recomendado, quotas, timeout e backoff. O limite recomendado de 2 MB não é apresentado como limite rígido do provedor.
- ADR 002, ADR 005 e Stories 3.11–3.13: separação de domínios, importação controlada e autoridade de agendamento.
