# Ensaio integral local de recuperação de sucata — 2026-10-09

**Resultado: aprovado no ambiente local sintético.** O comando `npm run ops:scrap:restore-drill` gerou um pacote com dump, manifesto e bytes privados, restaurou-o em um banco PostgreSQL isolado no Supabase local, executou verificações funcionais e removeu somente o banco temporário com nome validado. Nenhum dado real foi usado.

## Evidência observada

- Schemas restaurados: `auth`, `api`, `private`, `storage` e `supabase_migrations`.
- Dump restaurado: `971.990` bytes, conferido por SHA-256 pelo mesmo verificador usado no runbook.
- Uma fotografia sintética verificada do bucket privado `scrap-evidence` foi recuperada byte a byte; tamanho, caminho e SHA-256 coincidiram com `api.scrap_attachments`.
- Dez identidades Auth, três clientes, nove vínculos explícitos cliente–vendedor, uma coleta, um recebimento, dois agendamentos, uma evidência e cinquenta eventos de auditoria tiveram contagens idênticas na origem e no alvo.
- O ator sintético `seller_a` foi resolvido no alvo sob `role authenticated` e claim JWT, comprovando restauração de identidade, grants, funções e RLS usados pela aplicação.
- A função pública de busca autorizada, o helper privado de carteira, `FORCE ROW LEVEL SECURITY` em `api.client_seller_scopes` e o bucket `scrap-evidence` privado foram verificados no alvo.
- O relatório persistido em `.local/scrap-full-restore-drill-20261009T132436Z/report.json` marcou `status: pass`. O diretório é ignorado pelo Git e contém somente fixtures sintéticas.

## Alcance e limite restante

O ensaio substitui a evidência local parcial de 2026-10-07 para banco, Auth, grants, funções, RLS, metadados do Storage e integridade dos bytes do pacote. Ele ainda não comprova operação contínua por cinco anos, cópia criptografada externa, alertas, credenciais de recuperação segregadas nem restauração em um projeto Supabase Cloud isolado. Esses itens continuam sendo gate de produção do AC 14 e exigem o destino e o responsável operacional escolhidos pela Cirne.

O alvo deste ensaio é um banco isolado dentro do cluster local. O login HTTP pelo GoTrue e a reimportação dos bytes por uma segunda instância do Storage não foram exercitados; a identidade foi validada diretamente sob o mesmo papel/claim usado pelas políticas, e os bytes foram recuperados do Storage API da origem e conferidos no pacote. O runbook produtivo continua exigindo login e leitura privada no alvo Supabase completo.
