# Ensaio local de recuperação de sucata — 2026-10-07

**Resultado: parcial.** Este ensaio usou exclusivamente dados sintéticos do Supabase local e um PostgreSQL 17 isolado, sem rede. Não é prova de restauração operacional completa nem de conservação recuperável por cinco anos em produção.

## Evidência observada

- Um dump seletivo de nove tabelas do processo de sucata (`54.146` bytes; SHA-256 `38d31dbc1c0aeacf89489ccbce91c4e910a6114e3730e94bf40e4cece71d2a40`) foi restaurado no alvo isolado. Contagens e digests dos dados coincidiram nas nove tabelas; entre elas havia 3 coletas, 3 anexos, 3 recebimentos, 3 correções e 6 agendamentos.
- Três objetos sintéticos do bucket privado `scrap-evidence` foram copiados e recuperados byte a byte. Cada fixture tinha 4 bytes; tamanho e SHA-256 coincidiram com o arquivo de origem e com `api.scrap_attachments`. Isso testa integridade de bytes, não legibilidade de fotografia real.
- `npm run ops:backup:verify -- --manifest .local/scrap-restore-drill-20261007/manifest.json` aprovou o pacote local: 3 objetos declarados e 3 verificados, 12 bytes de evidência. Os artefatos de teste ficam em `.local/` (ignorado pelo Git) e não contêm dados reais.
- Após o ensaio, foram removidos somente o container PostgreSQL temporário e seu volume anônimo exclusivo, depois de confirmar ausência de outros usuários do volume. O Supabase local principal permaneceu saudável. O dump e manifesto em `.local/` permitem repetir a análise dos arquivos; o container descartado não é recuperável sem recriá-lo.

## Limites e próximos critérios

O dump foi seletivo e não transportou funções, triggers, FKs, RLS, identidades Auth nem o conjunto completo de `storage.objects`. O passo de pós-dados falhou porque `private.guard_scrap_attachment_verification()` não estava no alvo genérico. Portanto, não se testaram login restaurado, leitura autorizada/negada, bucket reconstruído ou aplicação funcional após desastre. É necessário um alvo Supabase isolado com restauração completa de banco **e** Storage, seguido dos testes de Auth/RLS/arquivo e reconciliação descritos no [runbook](../../../runbooks/scrap-backup-restore.md).

No momento da captura, o esquema efetivo já incluía a verificação confiável de anexo, mas o histórico local de migrações ainda não marcava as seis migrações de sucata como aplicadas. Após snapshot da tabela de histórico, o registro local foi reparado e a última migração foi renomeada de uma versão com minuto inválido para `20261006170000`; `migration list --local` passou sem divergências. O campo `databaseMigration` do manifesto do ensaio usa essa versão normalizada do mesmo esquema efetivo; o próprio dump seletivo não inclui nem comprova o histórico de migrações restaurado.

Permanecem abertas a configuração de cópia externa criptografada, retenção das cópias e dos bytes pelo prazo definido, monitoramento e um ensaio completo no ambiente de produção escolhido. Nenhuma dessas condições foi declarada concluída.
