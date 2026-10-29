# Prontidão do piloto — Contabo Linux

Esta matriz impede que um artefato local seja interpretado como ambiente remoto aprovado. Evidência ausente permanece bloqueio.

## Concluído pela Story 4.6

| Evidência | Resultado esperado |
| --- | --- |
| Decisão de hospedagem | `DEC-016`: aplicação/PWA+BFF em VPS Contabo Linux; Supabase Cloud permanece para dados/Auth/Storage. |
| Artefato | Dockerfile não-root e imagem única promovida por commit/digest. |
| Runtime declarativo | Compose com app sem porta pública, rede interna para Caddy, egress separado para Supabase Cloud, volumes próprios e sem socket Docker. |
| Configuração | Exemplo sem segredos e preflight humano/JSON com falha fechada. |
| Release | Workflow manual no `master`, gates antes do push e publicação GHCR por digest. |
| Operação | Runbooks de deploy e rollback sem reversão destrutiva automática. |
| Validação local | Compose, Caddy, container, health, privilégios, encerramento e retorno controlado testados com dados sintéticos. |

## Dependências externas — exigem evidência do ambiente

| Dependência | Evidência mínima | Estado inicial |
| --- | --- | --- |
| VPS Contabo | host exclusivo, distribuição/versão, plano, região, recursos medidos, SSH restrito | Pendente |
| Domínio/DNS/TLS | domínio aprovado, registros resolvidos, portas e certificado | Pendente |
| SMTP | conta/configuração aprovada e recuperação de acesso testada | Pendente |
| Segredos | arquivo `0600`, credenciais mínimas e rotação/guarda definidas | Pendente |
| Backup externo | destino/responsável, manifesto válido e restauração isolada aprovada | Pendente |
| Monitor externo | serviço, destinatários, canal e alertas testados fora da VPS | Pendente |
| Rollback remoto | digest anterior compatível e ensaio registrado na VPS | Pendente |
| Cotas/custos | Supabase, GitHub/GHCR e Contabo conferidos sem cobrança automática adicional | Pendente |

## Gates de negócio, privacidade e campo

| Gate | Condição para liberação |
| --- | --- |
| `AB-01` a `AB-09` aplicáveis | taxonomias, pesos, agenda e resultado aprovados ou funcionalidade explicitamente bloqueada conforme PRD |
| `AB-10`/`AB-11` | política de fotos e localização/exceções aprovada |
| `AB-14` | aparelhos, navegadores, PWA, offline, câmara/GPS e quota validados fisicamente |
| `AB-15` | finalidade, aviso, acesso, retenção, anonimização/descarte, logs e incidente aprovados |
| `AB-17` | região, participantes, suporte, janela e responsável/go-no-go nomeados |
| `AB-18` | mídia, capacidade, backup e recuperação aceitos |
| Dados reais | gates acima, perfis sensíveis, suporte e resposta a incidente aprovados |
| Início do piloto | P0 aplicáveis, restauração, cotas, observabilidade e go/no-go formal aprovados |

## Comando de decisão técnica

```bash
npm run ops:vps:preflight -- --env-file /opt/cirne-rotas/env/pilot.env --scope deploy --json
```

`ready` significa apenas que as evidências técnicas declaradas passaram pelo contrato. A decisão final de iniciar o piloto pertence ao responsável de negócio/operação e deve ser registrada separadamente.
