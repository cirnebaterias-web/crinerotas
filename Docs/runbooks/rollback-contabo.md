# Runbook — Rollback do Cirne Rotas na VPS Contabo Linux

## Objetivo

Restaurar o digest anterior conhecido e compatível quando uma implantação prejudicar saúde, autenticação, autorização, sincronização ou estabilidade. Recuperação de dados é procedimento separado; rollback de aplicação nunca executa reversão destrutiva automática de migração.

## Gatilhos

- aplicação/Caddy não saudáveis após a janela de promoção;
- canário, login/RLS, sincronização idempotente ou Storage falham;
- OOM ou três reinícios em 15 minutos associados ao release;
- aumento crítico de erros/timeout ou indisponibilidade confirmada pelo monitor externo.

## Pré-condições

- digest anterior preservado no GHCR e registrado como compatível com o schema atual;
- arquivo privado do ambiente, Compose e Caddyfile do commit aprovado disponíveis;
- operador e responsável operacional identificados;
- fatos posteriores ao backup avaliados antes de qualquer recuperação de dados.

## Procedimento

1. Registrar incidente, impacto, versão atual, digest anterior, migrações e horário.
2. Atualizar somente `CIRNE_APP_IMAGE` no arquivo privado para o digest anterior compatível; não usar tag móvel.
3. Atualizar `CIRNE_RELEASE_SHA` para o commit completo da imagem anterior, puxar esse digest e executar preflight de artefato; confirmar que o único bloqueio eventual é externo já conhecido:

   ```bash
   docker compose --env-file /opt/cirne-rotas/env/pilot.env \
     -f infrastructure/compose/compose.pilot.yaml pull
   npm run ops:vps:preflight -- \
     --env-file /opt/cirne-rotas/env/pilot.env \
     --scope artifact \
     --json
   ```

4. Puxar e promover o digest anterior:

   ```bash
   docker compose --env-file /opt/cirne-rotas/env/pilot.env \
     -f infrastructure/compose/compose.pilot.yaml pull app
   docker compose --env-file /opt/cirne-rotas/env/pilot.env \
     -f infrastructure/compose/compose.pilot.yaml up -d --wait --wait-timeout 120 app caddy
   ```

5. Verificar `live`, `ready`, login/RLS e reenvio idempotente com ator sintético. Confirmar monitor externo e ausência de loop de reinício.
6. Registrar início/fim, digest restaurado, schema vigente, resultado e evidências. Preservar ambos os digests e logs sanitizados para análise.

## Proibições

- não executar `down --volumes`, remover certificados ou limpar imagens genericamente durante incidente;
- não reverter migração destrutiva automaticamente;
- não restaurar backup por cima de dados posteriores sem decisão e reconciliação;
- não copiar segredos, cookies, autorização, URLs assinadas, coordenadas ou payloads para o registro do incidente.

## Encerramento

Rollback termina somente após aplicação estável, smokes aprovados, monitor externo verde e incidente registrado. Se o digest anterior não for compatível ou os smokes continuarem falhando, manter o piloto suspenso e seguir o runbook de restauração/continuidade.
