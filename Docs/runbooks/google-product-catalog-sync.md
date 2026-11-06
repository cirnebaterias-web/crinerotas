# Operação da base oficial de produtos

Story 4.15; ADR 007. Implementação local e desabilitada por padrão. Este documento não autoriza credenciais, carga real, timer, VPS ou publicação em produção.

## Fonte e limites

- Ler exclusivamente os valores efetivos de `Base produtos!A:R` com os 18 cabeçalhos fixados no contrato. Não ler `Produtos`, `TAB PREÇO` nem referências de fórmulas em outras abas.
- A chave é `Cód.Fábrica`, comparada com `Vendas.CódigoSKU` após `trim` e Unicode NFC, sem alterar caixa, zeros, hifens, espaços internos ou pontuação.
- `Cód.Fábrica` vazio, `SEM TAB`, duplicado ou campo obrigatório A/D/E/F/G vazio invalida toda a captura. A última geração válida permanece corrente.
- Limites: 10.000 linhas, resposta Google de 8 MiB, chunk de até 500 linhas e corpo BFF de 1 MiB. Excesso falha sem truncamento.
- `Preço médio mercado (R$)` é evidência privada. Nunca aparece em status, CLI, API comercial, CRM ou logs.

## Configuração privada

As chaves vazias estão documentadas em `apps/web/.env.example`:

- `GOOGLE_PRODUCT_CATALOG_ENABLED=false` por padrão;
- `GOOGLE_PRODUCT_CATALOG_SPREADSHEET_ID` e `GOOGLE_PRODUCT_CATALOG_ACTOR_ID` no BFF;
- `GOOGLE_PRODUCT_CATALOG_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRODUCT_CATALOG_PRIVATE_KEY`, `CIRNE_PRODUCT_CATALOG_SYNC_EMAIL` e `CIRNE_PRODUCT_CATALOG_SYNC_PASSWORD` somente no host da CLI.

Use conta Google somente leitura (`spreadsheets.readonly`) e uma identidade Supabase ativa com capability própria `products.sync`. O banco também exige pareamento da fonte e do ator em `private.product_catalog_sources`; capability, URL ou acesso a vendas/clientes não concedem esse vínculo. A tabela nasce vazia e nenhuma role recebe `products.sync` automaticamente.

O `source_key` é `SHA256 UTF-8(spreadsheetId + ':Base produtos')`. O identificador real e as credenciais ficam fora do Git, respostas e logs. Revogação preservativa define `sync_actor_id = NULL` na fonte exata e desabilita a configuração; não apaga snapshots.

## CLI primeiro

```text
npm run ops:product-catalog-sync -- --status --json
npm run ops:product-catalog-sync -- --key UUID-DA-INTENCAO --json
npm run ops:product-catalog-sync -- --json
```

Sem `--key`, a CLI gera e imprime a chave antes da aquisição. Em interrupção ou resposta perdida, reutilize a mesma intenção. O fluxo faz duas leituras integrais, exige o mesmo hash, envia staging limitado e publica atomicamente. `--status` não chama Google nem expõe fonte/linhas.

Não existe opção `--scheduled`, unidade systemd ou horário automático nesta story. A agenda permanece inativa até decisão específica do usuário/PO e novo gate operacional; ela não herda 06:15 de Vendas.

## Mini CRM v2

O detalhe fixa `salesGenerationId`, `catalogGenerationId`, `asOfDate` e `clientVersion`. Quando há catálogo publicado:

- top 10 mantém volume/descrição de Vendas e recebe enriquecimento oficial por igualdade exata;
- SKU vendido sem correspondência continua no top/histórico com `catalog_missing`;
- oportunidades partem do catálogo oficial, inclusive itens exclusivos dele, e removem qualquer código com venda positiva no histórico disponível do cliente;
- cobertura informa quantos SKUs observados em Vendas têm cadastro nesta versão.

Sem catálogo, o CRM retorna `catalog_unavailable`: métricas, gráfico, top e histórico permanecem disponíveis, mas oportunidades ficam indisponíveis. Lista vazia só significa zero oportunidades quando `availability=available`. O catálogo não comprova estoque, disponibilidade, preço ou compatibilidade técnica.

Paginação CLI do detalhe usa o contexto retornado:

```text
npm run ops:sales-crm -- --client UUID-CLIENTE --history-page 2 \
  --sales-generation UUID-VENDAS --catalog-generation UUID-CATALOGO \
  --as-of AAAA-MM-DD --client-version 1 --json
```

Conflito HTTP 409 exige reiniciar a consulta completa; nunca misture apenas parte do contexto. Toda chamada revalida a autorização atual do cliente, mesmo para versões históricas.

## Recuperação e rollback

- `SOURCE_CHANGED`/`SOURCE_INVALID`: não publique; revise a fonte no ambiente autorizado e preserve a última versão.
- `VERSION_CONFLICT`, lease ou resposta incerta: consulte status e recupere pela mesma chave antes de criar outra intenção.
- Falha Google ou atualização recente não bloqueia rota, visita nem a última geração publicada.
- Para rollback operacional, desabilite a flag, revogue o ator pareado e preserve runs, itens e diagnósticos. Não reescreva migration aplicada, não resete banco e não selecione geração antiga sem procedimento administrativo auditado próprio.

Antes de ativar dados reais: backup/restore testado, QA independente, retenção/capacidade aprovadas, fonte/ator pareados, teste negativo de escopo e observação de uma atualização manual. Registre apenas hashes/IDs operacionais e contagens, sem ID da planilha, linhas, PII ou segredos.
