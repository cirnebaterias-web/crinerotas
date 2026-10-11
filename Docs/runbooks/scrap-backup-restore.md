# Backup e restauração dos registros de sucata

## Estado e alcance

Este runbook é o procedimento de ensaio para a Story 3.10. O banco local contém somente atores e fatos sintéticos. A existência de marcos de retenção e bloqueios de exclusão no PostgreSQL/Storage **não prova**, sozinha, recuperação por cinco anos. Não usar este ensaio como autorização para dados reais ou como parecer jurídico.

O pacote precisa cobrir os registros de coleta, recebimento, agenda, revisões, auditoria, identidade/autorização e metadados do bucket privado `scrap-evidence` **mais os bytes dos objetos**. Uma cópia apenas do PostgreSQL não contém os arquivos do Storage; [o guia do Supabase](https://supabase.com/docs/guides/database/overview) confirma essa separação. A restauração de banco e a migração de objetos são procedimentos distintos no [guia oficial de backup e restauração](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

## Antes de produzir um backup operacional

1. Designar responsável, destino externo ao projeto Supabase e à VPS, criptografia, controle de acesso, segregação das chaves e política de cópias/imutabilidade. Não gravar senhas, URLs com credenciais, termos ou fotografias no repositório ou no relatório de ensaio.
2. Registrar versão do aplicativo, migração mais recente, momento do snapshot, origem autorizada e identificador do pacote. Definir uma restauração de teste em projeto isolado; nunca usar `db:reset` nem sobrescrever a base de trabalho/produção como ensaio.
3. Exportar o banco inteiro de forma consistente, inclusive papéis, estrutura, dados, histórico de migrações e customizações em schemas gerenciados. Seguir as ressalvas do [procedimento oficial do Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore); um dump padrão que omite Auth, grants ou políticas não é backup completo do Cirne Rotas.
4. Enumerar as evidências referenciadas pelo snapshot de banco e copiar seus bytes pelo Storage API ou interface S3 autorizada, sem alterar diretamente `storage.objects`. Para cada objeto, conferir caminho, tamanho e SHA-256 com o registro e o arquivo copiado. Uploads ainda pendentes devem constar como pendentes; o pacote só fica **completo** quando todas as evidências confirmadas referenciadas pelo snapshot estiverem presentes.
5. Produzir manifesto versionado com caminhos relativos, tamanhos, SHA-256, contagens e versão do schema; criptografar o pacote antes de enviá-lo ao destino externo. Guardar as credenciais de restauração separadamente. Não descartar cópias anteriores até a política de retenção e a capacidade de restauração estarem aprovadas.

O comando `npm run ops:backup:verify -- --manifest <caminho-do-manifesto>` valida a integridade local do pacote e retorna código diferente de zero para arquivo ausente, caminho inseguro ou hash/tamanho divergente. Ele **não** atesta que o snapshot é completo, que o destino externo está protegido ou que Auth/RLS funcionarão após a restauração.

Com o Supabase local ativo e ao menos uma coleta sintética com termo verificado, `npm run ops:scrap:restore-drill` cria um dump dos schemas `auth`, `api`, `private`, `storage` e `supabase_migrations`, baixa e confere todos os objetos verificados de `scrap-evidence`, restaura o banco em alvo local isolado e valida contagens, identidade, grants, funções, RLS e bucket privado. O alvo temporário usa o prefixo validado `cirne_scrap_restore_` e é removido ao final; dump, manifesto e relatório permanecem em `.local/` para auditoria. Esse comando é um ensaio local com fixtures, não substitui a restauração no projeto Supabase externo escolhido para produção.

## Ensaio de restauração

1. Registrar operador, início, identificador e idade do backup. Validar o manifesto **antes** de iniciar a restauração. Se houver falha, preservar o pacote e escalar; não tentar “corrigir” hashes manualmente.
2. Criar alvo Supabase isolado e autorizado, sem acesso de vendedores reais. Reconstituir extensões, papéis, schema, dados, histórico de migrações, políticas, bucket privado e configuração pertinente conforme o procedimento oficial. Não aplicar restauração diretamente à origem. Qualquer diferença de versão ou chave de criptografia exige avaliação antes de prosseguir.
3. Importar os objetos pelo Storage API/S3 para o alvo. Conferir novamente caminho, tamanho e SHA-256 dos bytes recuperados; metadados presentes sem arquivo são falha de restauração.
4. Comparar contagens e vínculos de coleta, recibo, termo, revisões, agenda e auditoria com o manifesto. Em uma coleta sintética recebida, confirmar que kg coletados e kg conferidos continuam separados, com vendedor, cliente, responsável da Logística, horários e histórico preservados.
5. Fazer login com ator sintético de cada perfil e testar leitura autorizada/negada de dados e foto privada, capacidade de recebimento exclusiva da Logística, replay idempotente e reconciliação de outbox. Uma consulta SQL bem-sucedida não substitui esses testes de Auth/RLS/Storage.
6. Registrar término, tempo total, idade do snapshot (RPO observado), duração da recuperação (RTO observado), contagens, hashes e resultado dos testes sem anexar dados pessoais ou fotos ao relatório. Falha de login, autorização, byte, vínculo ou histórico reprova o ensaio.

As metas de **RPO até 24 h** e **RTO até 4 h** são alvos de ensaio da arquitetura, não garantias. Perda de um registro confirmado é incidente crítico mesmo dentro da janela. Ver [Docs/architecture.md](../architecture.md), seção 14.5.

## Fechamento e pendências de produção

O ensaio local prova apenas a amostra sintética exercitada. Para marcar o AC 14 como cumprido, a operação ainda precisa comprovar, no ambiente escolhido: cópia criptografada externa, cobertura contínua de banco **e** objetos, conservação recuperável pelo prazo de cinco anos contado do último evento/encerramento (sem expurgo de processos pendentes), alertas de falha/idade, ensaios periódicos de restauração e responsável pela resposta a incidentes. A frequência, o destino, as chaves e o aceite do risco residual ainda dependem de decisão operacional. Não configurar descarte automático apenas porque um prazo mínimo terminou.
