# Sincronização de clientes — Google Planilhas

Story 3.13 · ADR 005 · Estado: implementação local; **não ativada em produção**.

## Comportamento e uso

Em **Clientes → Atualização pelo Google Planilhas**, `Atualizar agora` lê novamente a aba `Base clientes` e aplica as linhas válidas. O botão exige `clients.import`. A consulta exibe apenas execuções próprias; administradores podem consultar a identidade técnica. Consulte os três contadores: importados, ignorados e pendentes de revisão.

- `OUTROS`: ignorado, inclusive se o status estiver vazio; não exclui, arquiva ou desvincula cadastros existentes.
- `ATIVO`/`INATIVO`: atualiza/arquiva preservando histórico. Status vazio, `0`, `Sim` ou desconhecido: pendente, sem mutação.
- Carteira sem mapa, `VERIFICAR`, vendedor inválido/inativo/fora da abrangência: pendente. Nenhuma atribuição é inferida pelo nome.
- CPF/CNPJ repetido na fonte: todas as ocorrências ficam pendentes. Ausência na fonte não remove clientes.
- Corrija as linhas indicadas na planilha ou o mapeamento privado e faça uma **nova** atualização. Não há escrita de volta no Google.
- Se a resposta se perder, `Recuperar tentativa` consulta/reenvia a mesma intenção, sem duplicar importação. Depois do resultado terminal, `Atualizar agora` volta a criar uma intenção nova. Recarregar a página perde a chave local: consulte primeiro o último resultado antes de iniciar nova execução.

O adaptador usa os 21 cabeçalhos oficiais, mas importa somente os campos canônicos já suportados (nome, CPF/CNPJ, endereço, coordenadas, carteira/vendedor e status). Não altera o importador XLSX legado de oito campos. Leitura limitada a `A:U`, 5 MiB e 5.001 linhas incluindo cabeçalho/linhas vazias intermediárias; exceder o limite falha sem importação parcial. Não executar fórmulas recebidas.

## Configuração privada do BFF

Não colocar segredos em `NEXT_PUBLIC_*`, argumentos de shell, imagens Docker, fixtures, logs ou arquivos versionados. A sessão Google conectada ao chat **não** autentica a aplicação.

1. No projeto Google Cloud autorizado, habilitar Sheets API e criar conta de serviço dedicada, sem delegação de domínio ou papéis amplos desnecessários.
2. Compartilhar **somente esta planilha** como Leitor com o email da conta de serviço, sem publicar na web. Guardar sua chave privada em secret store/ambiente protegido; rotacionar e revogar se exposta.
3. Configurar o BFF com as variáveis abaixo. O exemplo versionado permanece desabilitado.

| Variável | Uso |
| --- | --- |
| `GOOGLE_CLIENT_SYNC_ENABLED` | `true` somente após gates reais; padrão `false` |
| `GOOGLE_CLIENT_SYNC_SPREADSHEET_ID` | ID privado da fonte autorizada; aba fixa `Base clientes` |
| `GOOGLE_CLIENT_SYNC_SERVICE_ACCOUNT_EMAIL` | Email técnico Google, domínio `iam.gserviceaccount.com` |
| `GOOGLE_CLIENT_SYNC_PRIVATE_KEY` | PEM RSA >=2048 bits; aceita quebras de linha ou `\n` escapado |
| `GOOGLE_CLIENT_SYNC_PORTFOLIOS_JSON` | Objeto JSON carteira → email de login exato do vendedor |
| `GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED` | `false` até preparar identidade/agendador |
| `GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID` | UUID da identidade técnica **do aplicativo**, obrigatório se agenda habilitada |

Exemplo sintético de mapa: `{"CARTEIRA TESTE":"seller@example.invalid"}`. Chaves são normalizadas por caixa/espaços; duplicidades normalizadas, `OUTROS` e `VERIFICAR` são recusadas. `{}` deixa todas as carteiras importáveis pendentes. Alterar mapa exige validação do responsável, não concede escopos.

O arquivo local `.local/client-sheet-sync-source.env` contém somente a fonte e os quatro vínculos obtidos por correspondência exata com a planilha de emails fornecida, com flags desligadas. É ignorado pelo Git, não é carregado automaticamente, não contém a credencial Google e **não deve ativar importações reais no banco sintético**. Validar no ambiente de destino que os quatro emails correspondem a vendedores ativos e autorizados.

## CLI e contrato HTTP

`GET /api/v1/client-sync`: consulta segura `{configured,reason,scheduleEnabled,timeZone,times,latest}`. Não devolve fonte, chave ou mapa privado. `POST` aceita exatamente um dos contratos:

```json
{"trigger":"manual","idempotencyKey":"31300000-0000-4000-8000-000000000001"}
```

```json
{"trigger":"scheduled"}
```

Ambos exigem autenticação e `clients.import`. Cookie exige origem same-origin; CLI usa Bearer. Agendado exige Bearer da identidade configurada e horário válido no servidor. Não aceita URL/fonte/slot arbitrários. Resposta: execução durável com estado, contadores, linhas/motivos e lote. Códigos usuais: 401 sessão, 403 permissão/CSRF, 409 fonte ocupada, 422 comando/estrutura/horário, 503 configuração/dependência.

```sh
npm run ops:client-sync -- --status --json
npm run ops:client-sync -- --key UUID-DA-INTENCAO --json
```

Use token de acesso autorizado por stdin ou `CIRNE_MANAGER_ACCESS_TOKEN`, nunca na linha de comando. Em retry manual, reutilize **o mesmo UUID**. Sem `--key`, cada execução CLI manual gera nova intenção. `--status` não importa dados. Saída JSON e exit code não zero em falha; pendências são um resultado concluído, não erro de transporte. Origem é `APP_BASE_URL` ou `--url`, HTTPS obrigatório salvo loopback local; redirects são recusados.

## Agendamento na VPS (somente após aprovação operacional)

O timer fornecido roda **06:00 e 13:00 em America/Sao_Paulo**, independentemente do fuso do host. Não depende de navegador, `setInterval` ou processo Next persistente. Esta seção é roteiro de implantação: nenhum comando abaixo foi aplicado à VPS nesta entrega.

1. Provisionar identidade técnica Supabase exclusiva, com papel/capacidade `clients.import` e apenas escopos necessários; validar com o administrador. Não usar `service_role` nem login pessoal. Seu UUID deve coincidir com a configuração do BFF.
2. Aplicar migrações `20261103120000_client_sheet_sync.sql` e `20261104120000_client_sheet_sync_scheduler_identity.sql` por fluxo aprovado, após backup e gates. Não usar `db reset` em ambiente real. Registrar o par fonte hash → UUID técnico na configuração privada do banco, usando acesso administrativo aprovado. A flag/UUID do BFF **não substitui** essa autorização: o banco começa negando todos os disparos agendados até o pareamento existir. Não conceder leitura/escrita dessa configuração a usuários do aplicativo.
3. Preparar checkout operacional da versão aprovada em `/opt/cirne-rotas/ops` com Node/npm nas versões de `package.json`, dependências do lockfile (`npm ci`, incluindo `tsx`) e usuário sem privilégios `cirne-ops`. O bundle standalone do Next **não inclui esta CLI**: instalá-la separadamente no host ou empacotar imagem operacional aprovada. O serviço de exemplo pressupõe `/usr/bin/npm`; ajustar ao executável instalado e validar sob o usuário real.
4. Criar `/etc/cirne-rotas/client-sync.env`, proprietário root, modo `0600`, fornecido pelo gerenciador systemd ao processo. Campos: `APP_BASE_URL`, `SUPABASE_PUBLIC_URL`, `SUPABASE_PUBLISHABLE_KEY`, `CIRNE_SHEET_SYNC_EMAIL`, `CIRNE_SHEET_SYNC_PASSWORD`. Não colocar a chave Google neste arquivo: ela pertence ao BFF. A cada disparo a CLI obtém sessão nova para a identidade técnica; sem refresh token pessoal.
5. Instalar as duas unidades de `infrastructure/systemd/` em `/etc/systemd/system/`, habilitar a flag de agendamento no BFF após a verificação manual controlada, então validar e ativar:

```sh
systemd-analyze verify /etc/systemd/system/cirne-client-sync.service /etc/systemd/system/cirne-client-sync.timer
systemd-analyze calendar '*-*-* 06:00:00 America/Sao_Paulo'
systemd-analyze calendar '*-*-* 13:00:00 America/Sao_Paulo'
systemctl daemon-reload
systemctl enable --now cirne-client-sync.timer
systemctl list-timers cirne-client-sync.timer
systemctl status cirne-client-sync.timer
```

Verificar NTP, resolução DNS/HTTPS e acesso à aplicação/Google. O hash da fonte é SHA-256 UTF-8 de `${spreadsheetId}:Base clientes`, exatamente como o serviço; calcular em ambiente privado a partir da configuração, sem imprimir o ID real ou passá-lo na linha de comando. O UUID pareado no banco deve ser exatamente `GOOGLE_CLIENT_SYNC_SCHEDULER_ACTOR_ID` e o usuário do login técnico. O banco valida esse par antes de adquirir/reproduzir um slot e novamente antes de importar; outra identidade, mesmo com `clients.import`, não pode reservar o horário. Ao trocar/revogar o par durante uma execução, a lease antiga não autoriza importar. Encerrar falha pelo próprio autor não altera clientes; histórico continua owner/admin.

Observar um disparo de cada horário, exit code e resultado persistido/auditoria. `scheduleEnabled=true` é configuração, **não prova** de timer instalado ou pareamento válido. Só anunciar ativo após essas evidências e gates G1–G5 da story.

`Persistent=false` evita execução atrasada ao ligar o host: horário perdido não roda automaticamente depois. Recuperar manualmente pelo botão. A janela agendada aceita tentativas dentro das horas 06 e 13, com uma única chave por data/horário. Não há retry automático configurado: uma repetição nesse período recupera o mesmo resultado; uma falha terminal exige nova intenção manual ou o próximo horário. Fora dessas janelas, CLI `--scheduled` é recusada. A agenda continua tendo exatamente dois disparos diários.

## Pareamento técnico no banco — administrador

Executar somente em sessão administrativa `psql` aprovada, como `postgres` com BYPASSRLS e INHERIT. Não executar como usuário do aplicativo ou com token do navegador. O script não concede `clients.import`; o usuário técnico precisa estar ativo, com essa capacidade e os escopos revisados previamente.

Definir as variáveis `source_key` (hash calculado privadamente), `scheduler_actor_id` (UUID técnico) e `operation` (`provision` ou `revoke`) usando variáveis psql. Não passar senha/URL de conexão privada na linha de comando. `revoke` exige o UUID atualmente pareado, evitando remover por engano um vínculo que já tenha mudado.

O bloco abaixo acrescenta somente a associação temporária necessária ao administrador da sessão, preserva grants de outros concedentes e remove apenas o grant próprio recém-criado. Se já houver herança suficiente, não altera a associação. Não usar `SET ROLE cirne_route_executor`, pois isso perde o BYPASSRLS exigido para provisionar. Qualquer erro aborta a transação inteira; não continuar por fora dela.

```sql
-- psql variables: source_key (64 lowercase hex), scheduler_actor_id (UUID),
-- operation (provision or revoke). Run only as the privileged DB administrator.
\set ON_ERROR_STOP on
begin;
set local lock_timeout='5s';
select set_config('cirne.sync.source_key',:'source_key',true) as _source,
  set_config('cirne.sync.scheduler_actor_id',:'scheduler_actor_id',true) as _actor,
  set_config('cirne.sync.operation',:'operation',true) as _operation \gset
do $provision$
declare
  source_key_value text:=current_setting('cirne.sync.source_key');
  scheduler_actor uuid:=current_setting('cirne.sync.scheduler_actor_id')::uuid;
  operation_value text:=current_setting('cirne.sync.operation');
  temporary_membership boolean:=false;
  affected integer;
begin
  if current_user<>'postgres' or not exists(
    select 1 from pg_catalog.pg_roles where rolname=current_user and rolbypassrls and rolinherit
  ) then
    raise exception 'PRIVILEGED_DATABASE_ADMIN_REQUIRED';
  end if;
  if source_key_value !~ '^[0-9a-f]{64}$' or operation_value not in ('provision','revoke') then
    raise exception 'INVALID_SOURCE_BINDING_PARAMETERS';
  end if;
  if not pg_catalog.pg_has_role(current_user,'cirne_route_executor','USAGE') then
    -- Supabase normally grants ADMIN only via supabase_admin (not inheritance).
    -- Add our own temporary grant without replacing that separate grantor's row.
    if exists(select 1 from pg_catalog.pg_auth_members membership
      where membership.roleid='cirne_route_executor'::regrole
        and membership.member=current_user::regrole and membership.grantor=current_user::regrole) then
      raise exception 'EXISTING_SELF_GRANTED_MEMBERSHIP_REQUIRES_REVIEW';
    end if;
    execute pg_catalog.format('grant cirne_route_executor to %I with admin false, inherit true, set false granted by current_user',current_user);
    temporary_membership:=true;
  end if;
  if operation_value='provision' then
    if not exists(
      select 1 from api.user_profiles profile
      where profile.id=scheduler_actor and profile.status='active' and profile.blocked_at is null
        and exists(select 1 from api.user_role_assignments assignment
          join api.role_permissions permission on permission.role_id=assignment.role_id
          where assignment.user_id=profile.id and assignment.revoked_at is null
            and permission.permission_code='clients.import')
    ) then
      raise exception 'ACTIVE_IMPORT_SCHEDULER_REQUIRED';
    end if;
    insert into private.client_sheet_sync_sources(source_key,scheduler_actor_id)
    values (source_key_value,scheduler_actor)
    on conflict (source_key) do update set scheduler_actor_id=excluded.scheduler_actor_id;
  else
    delete from private.client_sheet_sync_sources
    where source_key=source_key_value and scheduler_actor_id=scheduler_actor;
  end if;
  get diagnostics affected=row_count;
  if affected<>1 then
    raise exception 'SOURCE_BINDING_NOT_FOUND_OR_CHANGED';
  end if;
  if temporary_membership then
    execute pg_catalog.format('revoke cirne_route_executor from %I granted by current_user',current_user);
  end if;
  raise notice 'Scheduler binding % succeeded',operation_value;
end
$provision$;
commit;
```

Validação local sintética: provisionamento e revogação repetidos com rollback, tanto no cenário ADMIN-only do Supabase quanto com herança preexistente; `pg_auth_members` ficou idêntico ao estado anterior. Nenhum pareamento real foi persistido. Após ativação aprovada, guardar evidência administrativa do par e confirmar o primeiro resultado agendado.

## Diagnóstico, concorrência e desativação

- Google negado/revogado/timeout/limite: execução falha com código seguro; clientes e último resultado persistido são preservados. Corrigir credenciais/compartilhamento/quota sem colar corpos de resposta em logs.
- Fonte ocupada: aguardar e consultar. Lease de dez minutos, revalidada na transação que importa. Processo expirado não conclui sobre uma execução nova. Nunca liberar lease manualmente para forçar sobreposição.
- Estado owner/admin: gestor não enxerga automaticamente a execução do operador técnico. Administrador deve acompanhar o agendador. Mensagens e contadores não substituem observação operacional do timer.
- `journalctl -u cirne-client-sync.service` contém somente resumo/códigos, sem tokens ou células. Evitar `set -x` ou dump de ambiente; proteger acesso e retenção dos logs.
- Desativar: `systemctl disable --now cirne-client-sync.timer`, desligar `GOOGLE_CLIENT_SYNC_SCHEDULE_ENABLED` e, se necessário, `GOOGLE_CLIENT_SYNC_ENABLED`; revogar o pareamento técnico privado no banco para bloquear também a Data API e conclusão de execução agendada já em voo. Reiniciar/reimplantar BFF conforme fluxo aprovado. Preservar tabela de execuções, lotes e auditoria. Não dropar tabela/migração para rollback operacional.
- Reverter cadastros já importados exige restauração/reconciliação autorizada com backup/auditoria (não exclusão em massa). Seguir os runbooks de clientes e rollback Contabo.

## Endereço Google e navegação (Story 4.22)

- A sincronização lê Q (endereço encontrado Google), U (Place ID), P (status geo) e R (precisão). Esses campos são referências da fonte, não validação de presença em campo.
- A navegação prioriza Place ID acompanhado de Q (ou endereço cadastral J), depois Q e, somente sem ambos, o fallback anterior por coordenadas/endereço. O endereço J continua preservado.
- Campos Google vazios na fonte limpam somente os metadados Google. Uma importação legada que não contenha `googleLocation` preserva esses metadados. Depois da atualização, acionar uma nova execução manual importa esses campos mesmo sem mudanças na planilha; reenvios da mesma chave de execução permanecem idempotentes.
- Publicações novas de rota preservam os campos no snapshot. Rotas antigas já publicadas e visitas históricas não são reescritas: criar uma revisão e publicá-la pelo fluxo normal quando for necessário usar a nova referência.
- No detalhe autorizado da visita, referência Google e GPS observado são apresentados separadamente. Divergência não corrige o cadastro automaticamente. A fila de revisão/aprovação de localização será uma entrega posterior.
- Conferência sem rede/API paga: `npm run ops:navigation -- --json`. A migração deve preceder o novo importador. Não é necessário configurar uma API key para os links externos do Maps.

## Referências

- [Google: leitura de valores e escopos](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get).
- [Google: autenticação de conta de serviço](https://developers.google.com/identity/protocols/oauth2/service-account).
- [systemd: timers e persistência](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) e [calendário com fuso](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html).
- ADR 005, Story 3.13 e `Docs/runbooks/client-management-rollback.md`.
