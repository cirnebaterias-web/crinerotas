# Rollback da manutenção manual de clientes

Esta capacidade usa migração aditiva e preserva clientes, vínculos e auditoria. O rollback operacional deve ser feito por uma nova migração, nunca editando ou revertendo destrutivamente a migração aplicada.

1. Revogar `EXECUTE` de `api.create_client`, `api.update_client`, `api.get_client` e `api.list_client_management_sellers` para `authenticated`.
2. Reimplantar a versão anterior da aplicação, mantendo `lock_version`, a proveniência dos vínculos e `private.client_management_commands`.
3. Confirmar que `GET /clients` e a importação oficial continuam disponíveis.
4. Não excluir clientes, auditorias ou vínculos criados durante a vigência. A remoção de funções/colunas somente pode ocorrer em mudança posterior, após prova de que nenhum cliente implantado depende delas.

Para reativar, reaplique os grants em uma nova migração e execute os testes pgTAP, integração e CLI da Story 3.12.
