# Runbook — Deploy do Cirne Rotas na VPS Contabo Linux

## Objetivo e autoridade

Promover uma imagem imutável já validada até a VPS exclusiva do Cirne Rotas. Este runbook não contrata nem provisiona recursos, não escolhe distribuição/plano/região e não autoriza dados reais. Somente operador autorizado executa a promoção.

## Gatilho

- release manual `Release pilot image` concluído no `master`;
- imagem `ghcr.io/...@sha256:...` registrada no resumo do workflow;
- janela de mudança aprovada pelo responsável operacional.

## Pré-condições bloqueantes

- VPS Contabo Linux exclusiva provisionada, atualizada e com acesso SSH por chave/origem restrita;
- domínio/DNS, portas 80/443 e contato ACME validados;
- Docker Engine e Compose v2 compatíveis instalados;
- credencial GHCR somente leitura instalada no host, fora do repositório;
- arquivo privado de ambiente com modo `0600`, fora do checkout e sem valores de exemplo;
- SMTP, segredos, backup externo, monitor externo e responsáveis operacionais confirmados;
- digest anterior e compatibilidade de schema conhecidos para rollback;
- `AB-15`, `AB-17`, `AB-18` e demais gates aplicáveis fechados antes de dados reais/piloto.

## Preflight obrigatório

No checkout correspondente ao commit aprovado:

```bash
npm ci
docker compose --env-file /opt/cirne-rotas/env/pilot.env \
  -f infrastructure/compose/compose.pilot.yaml pull
npm run ops:vps:preflight -- \
  --env-file /opt/cirne-rotas/env/pilot.env \
  --scope deploy \
  --json
```

O arquivo privado deve registrar também `CIRNE_RELEASE_SHA`, exatamente o commit completo aprovado no workflow. O preflight compara esse SHA com o checkout, com o rótulo OCI da imagem puxada e com o digest resolvido pelo Compose. Resultado diferente de `ready` ou exit code diferente de zero interrompe o deploy. Não copiar valores do ambiente para tickets, comentários ou logs.

## Procedimento

1. Registrar operador, data/hora, commit, digest novo, digest atual e migrações previstas.
2. Verificar o manifesto do backup externo mais recente e executar o backup pré-migração aplicável:

   ```bash
   npm run ops:backup:verify -- --manifest /caminho/privado/manifest.json
   ```

3. Confirmar que migrações seguem expand/contract e que o digest anterior continua compatível. Não aplicar reversão destrutiva automática.
4. Autenticar o host no GHCR com credencial somente leitura e puxar a imagem/digest aprovado:

   ```bash
   docker compose --env-file /opt/cirne-rotas/env/pilot.env \
     -f infrastructure/compose/compose.pilot.yaml pull
   ```

5. Aplicar migrações compatíveis pela CLI aprovada, registrar saída sanitizada e só então promover os containers:

   ```bash
   docker compose --env-file /opt/cirne-rotas/env/pilot.env \
     -f infrastructure/compose/compose.pilot.yaml up -d --wait --wait-timeout 120
   ```

6. Confirmar `live` pela URL pública e `ready` no contexto operacional. Em seguida executar com ator sintético autorizado os smokes de login/RLS, sincronização idempotente e Storage previstos para o ambiente.
7. Confirmar no monitor externo a URL pública, certificado e início da janela de disponibilidade.
8. Registrar início/fim, resultado, versão/digest, migrações, evidências, alertas e operador. Remover material temporário; não remover o digest anterior.

## Falhas e escalonamento

- preflight, backup ou compatibilidade falhou: não iniciar a troca;
- Caddy/app não ficam saudáveis em 120 s, canário falha ou surge OOM/reinício: executar `rollback-contabo.md`;
- login/RLS/sincronização/Storage falha: bloquear entrada em campo, preservar logs sanitizados e avaliar rollback;
- perda confirmada, acesso indevido, evidência exposta ou restauração inválida: interromper go-live e acionar resposta a incidente.

## Critério de encerramento

Deploy só termina quando digest executado, `live`, `ready`, smoke sintético, monitor externo e registro operacional estiverem aprovados. Ausência de qualquer evidência mantém o resultado como bloqueado, nunca como sucesso parcial.
