# Operação do histórico Vendas

Stories 4.13/4.14; ADR 006. Implementação local com fixtures sintéticas. **Não significa integração Google, timer ou VPS ativos.** Não importar a fonte real na base sintética.

## Pré-condições para ativação autorizada

1. Aprovar ambiente, privacidade, escopos, retenção de versões, capacidade, backup e recuperação (gates G1–G5 da Story 4.13).
2. Aplicar a migração versionada depois de backup e QA. A tabela privada de fonte começa vazia; não há cadastro automático por HTTP.
3. Usar conta de serviço Google com acesso de leitura exclusivamente à planilha autorizada. Escopo OAuth `spreadsheets.readonly`; não habilitar Drive, compartilhamento público nem reutilizar sessão do chat. Somente a aba `Vendas` será consultada; não incluir `Produtos`.
4. Provisionar identidade técnica Supabase ativa com `sales.sync`. Permissão não basta: parear também seu UUID à fonte no banco administrativo. Não usar `service_role` na CLI ou no BFF.
5. Implantar a CLI e suas dependências fixadas no host operacional, distinta do bundle standalone Next.js. O host recebe configuração privada e credenciais; não copiar segredos para imagem/Git.

## Configuração privada

Configuração validada em `packages/config/src/sales-sync.ts`; exemplo sem valores reais em `apps/web/.env.example`:

- `GOOGLE_SALES_SYNC_ENABLED`: padrão `false`.
- `GOOGLE_SALES_SYNC_SPREADSHEET_ID`, `GOOGLE_SALES_SYNC_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_SALES_SYNC_PRIVATE_KEY`: fonte e conta técnica. Chave RSA de pelo menos 2048 bits; `\n` escapado é aceito.
- `GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID`: UUID obrigatório do operador, inclusive para execução manual; não é o e-mail Google.
- `GOOGLE_SALES_SYNC_SCHEDULE_ENABLED`: padrão `false`, separado da configuração de clientes.
- `APP_BASE_URL`: origem HTTPS da aplicação (HTTP somente loopback em desenvolvimento).
- `SUPABASE_PUBLIC_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CIRNE_SALES_SYNC_EMAIL`, `CIRNE_SALES_SYNC_PASSWORD`: login novo da CLI a cada execução. Não armazenar JWT efêmero como credencial do timer.

Na VPS, arquivo privado `/etc/cirne-rotas/sales-sync.env`, legível somente pelo operador/administrador autorizado, fora do repositório. O BFF recebe apenas ID da fonte, UUID técnico e flags correspondentes; as credenciais Google e de login da CLI ficam exclusivamente no processo operacional, sem necessidade de duplicá-las no servidor web. Status `configured` do BFF comprova sua configuração local, não valida a conta Google nem a instalação do timer. Não imprimir ambiente nem executar comandos de diagnóstico que exibam segredos.

### Pareamento de fonte e ator

Administração de banco calcula `source_key = SHA256 UTF-8(spreadsheetId + ':Vendas')` e cadastra em `private.sales_sources` o mesmo UUID configurado em `GOOGLE_SALES_SYNC_SCHEDULER_ACTOR_ID`. Não gravar ID da planilha em SQL versionado. A fonte é singleton: troca de fonte/ator exige operação administrativa revisada, não tentativa de `INSERT` concorrente nem concessão pública.

Exemplo para `psql`, com variáveis privadas fornecidas por ferramenta administrativa aprovada, não pelo navegador:

```sql
\set ON_ERROR_STOP on
begin;
insert into private.sales_sources(source_key, scheduler_actor_id)
values (:'source_hash', :'technical_actor_uuid'::uuid);
commit;
```

`authenticated`, `anon` e `service_role` não têm DML nessa tabela. O executor de RPC só pode alterar `published_run_id`/`updated_at`, não provisionar identidade. Testar que outro gestor, vendedor e identidade bloqueada são negados diretamente pela Data API. Antes de ativar, conferir que os documentos da Base Clientes e os escopos atuais são canônicos; Vendas não modifica esses cadastros.

Para revogar a integração preservando seu histórico, administração de banco define `scheduler_actor_id = NULL` na fonte exata. A igualdade de identidade falha fechada imediatamente nos comandos seguintes; não apagar a fonte referenciada por gerações. Novo provisionamento exige atualizar o UUID privado e a configuração do processo de forma pareada. Nenhuma RPC pública altera essa configuração.

## Operação CLI primeiro

```text
npm run ops:sales-sync -- --status --json
npm run ops:sales-sync -- --key UUID-DA-INTENCAO --json
npm run ops:sales-sync -- --scheduled --json
```

Manual sem `--key` gera UUID e o imprime antes de começar, para recuperação. Guarde essa chave operacional; não invente outra quando uma resposta de publicação se perder. A CLI faz login técnico novo, chama BFF begin, obtém token Google read-only, lê duas vezes, valida, envia chunks e publica. Não imprime linhas, documentos, credenciais ou ID real da fonte. Saída de sucesso/status é JSON; código 0 é operação confirmada/consulta, 1 falha e 2 execução ainda em coleta. `--status` não consulta Google.

RPCs de escrita revalidam capacidade e pareamento privado a cada chamada. BFF usa Bearer e cliente Supabase do chamador. Importação não aceita clique de navegador como executor do job longo. Consulta CRM tem capacidade/escopo separados e não recebe documentos brutos ou custos.

## Consulta do mini CRM (Story 4.14)

A consulta é somente leitura, online, sob o token atual de um vendedor/gestor com `sales.read_client`. A identidade da importação não concede leitura global. Fornecer o token por `CIRNE_ACCESS_TOKEN` ou stdin, nunca por argumento de linha de comando; proteger também o JSON resultante, que contém informações comerciais autorizadas.

```text
npm run ops:sales-crm -- --client UUID-DO-CLIENTE --json
npm run ops:sales-crm -- --client UUID-DO-CLIENTE --history-page 2 --sales-generation UUID-VENDAS --catalog-generation UUID-CATALOGO --as-of AAAA-MM-DD --client-version 1 --json
npm run ops:sales-crm -- --seller UUID-DO-VENDEDOR --date AAAA-MM-DD --clients UUID-CLIENTE-1,UUID-CLIENTE-2 --json
```

Os placeholders devem ser substituídos pelos valores autorizados. Página de oportunidades: `--opportunity-page`; quando houver catálogo oficial, transportar o mesmo quarteto `salesGenerationId`, `catalogGenerationId`, `asOfDate` e `clientVersion` retornado anteriormente. Sem catálogo, oportunidades ficam explicitamente indisponíveis, mas a paginação do histórico continua fixando vendas/data/cliente. `clientVersion` é a versão cadastral, não um documento: mudanças no cadastro/vínculo dos fatos impedem combinar páginas antigas e novas. Conflito HTTP 409 exige reiniciar a consulta; não trocar somente um componente do cursor. Cada chamada revalida o escopo atual, independentemente da versão.

O comando de sinais exige também `route.plan_scoped`, um vendedor ativo da abrangência atual e de 1 a 50 clientes ativos/não arquivados da carteira. Um único cliente inelegível rejeita o lote inteiro. No painel, somente os 25 clientes da página visível são consultados e ordenados; isso não modifica composição, prioridades, rascunho ou publicação da rota. `--date` identifica o contexto da rota, mas não desloca a data analítica do servidor.

Regras de apresentação: histórico de 12 meses-calendário incluindo o atual (marcado parcial); gráfico e média de seis meses civis completos, volume líquido com devoluções e denominador fixo 6. Recência considera a última venda positiva em todo o histórico disponível; ciclo usa datas positivas distintas dos 12 meses. Menos de duas datas não permite calcular periodicidade. Top 10 usa saldo líquido positivo de Vendas. Após a Story 4.15, oportunidades usam a base oficial separada descrita em `google-product-catalog-sync.md`, sem afirmar estoque, preço ou compatibilidade.

Respostas identificam captura, referência e cobertura `observed_only`: o intervalo observado não comprova completude. Captura com mais de 24 horas recebe aviso, sem afirmar agenda ativa. Sem geração publicada: HTTP 503, `DEPENDENCY_UNAVAILABLE`, motivo `no_published_generation`, distinto de cliente autorizado sem fatos. Cliente sem acesso retorna negação/404 sem revelar disponibilidade da fonte. A CLI retorna exit 1 sanitizado nesses erros, nunca histórico zero fictício. Offline não amplia o cache comercial e não bloqueia a visita existente.

APIs: `GET /api/v1/clients/{clientId}/sales` e `GET /api/v1/management/sales-signals`; não aceitam URL Google ou CPF/CNPJ arbitrário. RPC de sinais é read-only e não usa autoridade de importação. Migrations já aplicadas são imutáveis; a extensão de contexto da 4.14 exige implantar os contratos/BFF compatíveis junto da migration incremental `20261107120000`.

## Agenda e recuperação

Artefatos: `infrastructure/systemd/cirne-sales-sync.service` e `.timer`. Uma execução às **06:15 America/Sao_Paulo**, sem depender do fuso do host ou de navegador aberto. `Persistent=false`: boot tardio não executa atualização inesperada. Não instalar/ativar unidades durante desenvolvimento local. Operação autorizada futura deve verificar `systemd-analyze calendar` e observar execução/auditoria antes de afirmar agenda ativa. Flag habilitada sozinha não prova timer instalado.

Retry de agendamento é permitido somente das **06:15 às 06:59** no fuso definido, preservando a mesma chave diária `YYYY-MM-DD@06:15`; não criar segunda intenção automática. Fora da janela, recuperação é manual com UUID explícito. A rotina de clientes (06:00/13:00) permanece intacta; 06:15 posterior não garante que a execução de clientes concluiu.

Uma lease dura dez minutos. Resposta perdida de begin pode ser recuperada pela mesma intenção/lease válida. Chunks reenviados são conferidos contra seu conteúdo real. Fonte alterada entre as duas leituras bloqueia publicação; resposta perdida depois de publish é recuperada pela mesma intenção, sem marcar um commit incerto como falha. Lease expirada impede executor antigo de publicar; consulte status e registre motivo antes de iniciar nova intenção manual.

## Limites e diagnóstico

- Projeção: cabeçalho A1:AL1; dados B, I:M, R:T, AB:AD, AH e AL. Nunca custos U/V. Ranges esparsos mantêm número original da linha.
- Limites: 100.000 linhas, 32 MiB por leitura Google; RPC até 1.000 linhas; CLI até 500 linhas por chunk e corpo de 1 MiB medido. Excesso falha sem cortar a base.
- Integridade: SHA256 do JSON compacto da tupla canônica de 15 campos por linha; hash de chunk/geração sobre concatenação desses hashes em ordem de linha. O SQL recompõe hashes, não confia só no valor declarado.
- Datas pt-BR validadas em calendário; J é a data do fato. Venda positiva e devolução negativa; dinheiro decimal exato. AA/AI não recalculam ou substituem os fatos.
- Duas leituras iguais comprovam repetibilidade observada, não transação de snapshot Google. Sem leitura completa válida, sem publicação.
- Status distingue configuração desativada/ausente/inválida, tentativa atual e última publicação. `unmatchedClientCount` conta documentos distintos sem cadastro correspondente (`CLIENT_NOT_FOUND`). `issueCount` soma as linhas sem cadastro e as linhas de clientes cadastrados sem nenhum vínculo ativo de carteira (`CLIENT_WITHOUT_ACTIVE_SCOPE`, nenhum `client_seller_scopes.revoked_at IS NULL`). Os dois motivos não se sobrepõem na mesma linha. Cliente vinculado a outra carteira não é pendência por estar fora do escopo pessoal do importador técnico. Não atribuir carteira por vendedor histórico.
- Esses diagnósticos privados retratam o momento da publicação; não descartam vendas, bloqueiam publicação nem concedem acesso. A revisão cadastral deve ocorrer pelo fluxo autorizado de clientes. Correção posterior de vínculo afeta a autorização atual do CRM, mas não altera contadores da geração histórica ou seu replay. Uma nova captura registra o novo estado; não recalcular retroativamente gerações já publicadas.
- `SOURCE_UNAVAILABLE`: conferir acesso, quota e transporte sem registrar mensagem privada do Google. `SOURCE_INVALID`/`SOURCE_CHANGED`: revisar fonte no ambiente autorizado. `VERSION_CONFLICT`/lease: consultar status e intenção. Nunca ocultar falha como volume zero.

## Rollback preservativo

Desabilitar flag e timer no ambiente autorizado, impedir novas execuções e aguardar/encerrar o processo operacional se necessário. Manter gerações, staging e auditoria; não apagar tabelas, resetar banco ou reescrever migration aplicada. A última publicação válida continua consultável. Selecionar uma geração antiga como atual não é endpoint deste recorte: exige procedimento administrativo auditado próprio. Nenhum expurgo automático está habilitado; estimar crescimento antes de dados reais.

## Evidência de ativação

Registrar ambiente, versão, hashes/IDs operacionais, horário/fuso, contagens, resultado autorizado, teste negativo de escopo e backup/recuperação. Não incluir PII/ID da planilha/segredos nos anexos. Gates locais e QA independentes não substituem observação do timer e aprovação de uso real.
