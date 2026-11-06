# Atualização da conta-corrente de sucata

Fonte somente leitura: planilha `Sucatas`, abas `Sucatas` e `Saldo por Cliente`. A identidade de serviço precisa de acesso de leitura; a chave privada fica apenas no secret store/arquivo de ambiente da aplicação.

## Variáveis

Use as variáveis `GOOGLE_SCRAP_SYNC_*` documentadas em `apps/web/.env.example`, além de `CIRNE_BASE_URL`, `CIRNE_SCRAP_SYNC_EMAIL` e `CIRNE_SCRAP_SYNC_PASSWORD` no ambiente privado do timer. Nunca versionar a chave ou senha.

## Operação

- Manual: botão **Atualizar agora** no painel de sucata ou `npm run ops:scrap-ledger-sync`.
- Automática: instalar/habilitar `cirne-scrap-ledger-sync.timer`; dispara 08:00 e 18:00 em `America/Sao_Paulo`.
- Verificar: `systemctl list-timers cirne-scrap-ledger-sync.timer` e `journalctl -u cirne-scrap-ledger-sync.service`.

A publicação só troca a geração corrente depois de validar as duas abas duas vezes. Versões anteriores permanecem no banco para auditoria. Coletas e agendas do aplicativo não escrevem nesse ledger.
