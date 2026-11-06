# ADR 005 — Sincronização da base de clientes do Google Sheets

## Status

Accepted — 2026-11-03, associada à Story 3.13. Esta decisão autoriza a implementação; não declara a integração ou o agendamento produtivo ativos.

## Origem e fronteira

O usuário indicou uma planilha Google e a aba `Base clientes`. Confirmou que a carteira `OUTROS` deve ser desconsiderada, status vazio ou indefinido deve permanecer pendente de revisão, deve existir um botão para forçar atualização e devem ocorrer duas atualizações diárias, às 06:00 e às 13:00, no fuso `America/Sao_Paulo`.

Essa solicitação amplia a fonte manual de clientes prevista na Story 3.11 e a lista de integrações externas da arquitetura base (§7.6). Não substitui o importador XLSX legado, não autoriza escrita no Google, não muda carteiras implicitamente e não adiciona um worker permanente (§11.14). O modelo Excel oficial de 21 colunas continua independente da compatibilidade do parser XLSX legado.

## Decisão

### Leitura e normalização

Um adaptador server-only lê a API oficial Google Sheets por `spreadsheets.values.get`, com autenticação de conta de serviço e escopo `spreadsheets.readonly`. A planilha permanece privada, compartilhada somente para leitura com a conta técnica Google. O ID e a aba autorizados ficam em configuração do servidor; o cliente não fornece uma URL arbitrária para o servidor buscar.

Ler os valores calculados, não executar fórmulas. `FORMATTED_VALUE` preserva a representação textual de CPF/CNPJ; validar e normalizar coordenadas com separador decimal da planilha. Aplicar limites de tempo, tamanho e quantidade de linhas, validar os 21 cabeçalhos e falhar fechado quando a fonte não corresponder ao contrato. Não usar exportação pública, scraping ou a sessão pessoal do conector de chat como credencial de execução da aplicação.

O adaptador transforma somente os campos já representados no cadastro atual:

| Coluna oficial | Contrato atual |
| --- | --- |
| CNPJ/CPF | `externalReference`, normalizado pelo contrato existente |
| Razão Social | `name` |
| Endereço completo | `address` |
| Latitude / Longitude | `latitude` / `longitude` |
| Carteira | `portfolioReference` e mapa explícito para `sellerEmail` |
| Status | `ATIVO` → `active`; `INATIVO` → `archived` |

As demais colunas não passam a existir como atributos do aplicativo por esta integração. O layout é validado, mas não se promete preservar campos ainda ausentes do modelo de clientes. Alterar esse modelo exige requisito próprio.

Normalizar caixa e espaços antes das regras. Linhas `OUTROS` são ignoradas antes da atribuição/status, contabilizadas separadamente e não modificam clientes existentes. Carteira sem mapeamento explícito, inclusive `VERIFICAR`, fica pendente; não deduzir e-mail ou identidade pelo nome. Status vazio/desconhecido fica pendente e não é convertido para ativo. Clientes ausentes da fonte não são removidos nem arquivados. Falhas das demais validações também não modificam a linha correspondente.

### Autorização e execução única

CLI e interface usam o mesmo BFF e os contratos de domínio. A execução manual usa a sessão humana e a capacidade `clients.import`. A execução agendada usa uma identidade técnica Supabase previamente provisionada, com papel e abrangência suficientes, autenticada novamente a cada execução. Nunca converter uma sessão de gestor em uma credencial `service_role` nem substituir silenciosamente seu autor por um usuário mais privilegiado.

Reutilizar `validate_client_import_sellers` e `execute_client_import`, incluindo a normalização vigente, escopo de vendedores/clientes e eventos de auditoria existentes. A conta técnica Google autoriza leitura da planilha; a identidade técnica Supabase autoriza a mutação do domínio. São credenciais distintas e nenhuma é entregue ao navegador.

A autoridade para disparar uma execução `scheduled` também é verificada no PostgreSQL, pois usuários autenticados podem acessar a Data API sem passar pelo BFF. Uma configuração privada relaciona o hash da fonte ao UUID exato da identidade técnica autorizada. Ela começa vazia, é provisionada somente por administrador de banco e não tem API nem permissões de escrita para os papéis da aplicação. Uma fonte não configurada falha fechada; possuir `clients.import` ou o papel de administrador não substitui o vínculo explícito de agendador. A verificação ocorre antes de adquirir a fonte ou consultar/repetir um slot, impedindo que outro gestor reserve a chave agendada global e bloqueie o operador legítimo. A conclusão de uma execução agendada revalida esse vínculo antes de importar, respeitando revogação ou troca da identidade durante a lease. O UUID configurado no servidor e no banco deve corresponder; a tabela não armazena senhas ou tokens.

O estado técnico da fonte, a posse temporária da execução e o último resultado precisam ser duráveis no PostgreSQL, acessados somente por RPCs estreitas. Nesta entrega, a consulta é restrita ao autor da execução ou a administrador, sem exposição global de pendências a outros gestores. Assim, execuções da identidade técnica são visíveis ao administrador; outro gestor vê suas próprias execuções manuais. A interface deve explicar esse limite, sem apresentar a ausência de resultados visíveis como ausência global de sincronização. Não usar variável global do processo nem armazenamento local do navegador como controle de concorrência ou histórico canônico. O desenho físico, RLS, leases e testes de banco ficam com `@data-engineer`.

Usar uma chave estável por execução: slot de data/hora agendada ou UUID da operação manual, preservado em retries. A execução transacional precisa verificar novamente a posse da lease antes de aplicar importação, para que um processo expirado não sobrescreva um mais novo. Repetir a mesma execução retorna o resultado canônico; uma nova execução pode reaplicar a fonte. O checksum do importador legado é único por autor para sempre, portanto o comando Google deve incorporar identidade da fonte, conteúdo normalizado, versão do mapeamento e identidade da execução. Usar somente o hash do conteúdo impediria atualizar novamente após mudanças locais, correção de permissões ou retorno a uma versão antiga da fonte.

### Pendências e observabilidade

O resultado distingue importados, ignorados e pendentes. Persistir número da linha e códigos/mensagens de validação suficientes para localizar a correção na fonte, sem copiar as 21 colunas de dados pessoais em logs. Pendência não é um novo status de cliente: a linha não é aplicada. Corrigir a planilha ou o mapeamento e executar uma nova sincronização reavalia a pendência; não criar editor paralelo de cadastros pendentes nesta story.

A tela de clientes oferece `Forçar atualização`, estado da operação, horários planejados e último resultado autorizado. A disponibilidade de código/configuração não significa agendamento instalado. Sem credencial, mapa ou ambiente produtivo provisionado, a tela informa que a integração exige configuração, sem falsa indicação de sincronização ativa.

### CLI First e horários

Disponibilizar execução one-shot e consulta de estado pela CLI antes da UI. Um agendador do host/container chama a CLI às 06:00 e às 13:00 em `America/Sao_Paulo`; não colocar `setInterval`, cron interno ou efeito React dentro do Next.js. Escolher cron com suporte comprovado ao fuso ou timer systemd com fuso explícito durante o provisionamento da VPS. Duas réplicas/execuções simultâneas são tratadas pelo controle durável, não por suposição de processo único.

O comando agendado identifica seu slot de forma determinística para retries. A chave manual não reutiliza a chave agendada. Um host desligado não executa tarefas; validar política de retomada e persistência do timer no provisionamento, sem afirmar disponibilidade de 24 horas antes de instalar e observar a VPS.

## Alternativas consideradas

- Planilha publicada/CSV anônimo: rejeitada por ampliar a exposição da base e depender de compartilhamento público desnecessário.
- Apps Script escrevendo diretamente no banco: rejeitado por duplicar regras e ampliar a superfície de credenciais do domínio.
- Worker permanente dentro da aplicação: desnecessário para dois horários diários e vulnerável a reinícios/réplicas sem estado durável.
- Implementar todas as 21 colunas como novo modelo de cliente: fora do pedido atual; preservar contrato existente e documentar a fronteira.

## Gates externos

Antes da ativação real: configurar Sheets API/conta de serviço e compartilhamento read-only, validar o mapa Carteira → vendedor, provisionar a identidade técnica Supabase, aplicar migração em ambiente aprovado, instalar agendamento no host com timezone, executar uma verificação controlada e observar resultado/auditoria. Não importar a base real no banco sintético de desenvolvimento nem declarar o cron ativo com base somente em testes unitários.

## Referências verificadas

- [OAuth 2.0 server-to-server e conta de serviço](https://developers.google.com/identity/protocols/oauth2/service-account). O Google recomenda bibliotecas de autenticação; uma implementação sem nova dependência precisa manter RS256, endpoint/token scope fixos e testes do protocolo, sem inventar criptografia.
- [Sheets values.get e escopos](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).
- [Valores formatados, calculados e fórmulas](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueRenderOption).
