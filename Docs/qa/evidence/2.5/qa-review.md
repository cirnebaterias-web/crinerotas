# Story 2.5 — Revisão formal de QA

Data: 2026-09-16. Revisor: Quinn (`@qa`, Codex). Revisão: `working-tree-sha256:a92a9f8ec9d5b5a49a0a382470791848d7748a61463b7e0311df32823213a05d`.

## Veredito

**PASS.** Os sete critérios de aceite estão atendidos no recorte local e sintético. Nenhum issue de severidade alta/crítica permanece conhecido. `AB-14` e `AB-15` continuam corretamente tratados como gates de homologação/uso real, não como lacunas escondidas desta implementação.

## Perfil de risco

Revisão profunda aplicada: a story toca autorização local, persistência privada e concorrência; possui sete ACs e delta superior a 500 linhas. Riscos principais avaliados: vazamento entre vendedores, reautorização após logout, snapshot antigo vencendo novo, falso anúncio de disponibilidade e perda de registros no upgrade.

## Rastreabilidade Given–When–Then

| AC | Cenário validado | Evidência |
| --- | --- | --- |
| 1 | Dada uma rota canônica autorizada, quando convertida para o snapshot local, então todos os campos operacionais são preservados, outra partição é rejeitada e nenhum parâmetro fictício aparece. | contratos/domínio/CLI unitários |
| 2 | Dado worker atual e IndexedDB disponível, quando o pacote é confirmado, então a UI anuncia offline; dada falha de quota/commit, então não há falso sucesso e o pacote anterior permanece. | repositório/serviço unitários, E2E offline |
| 3 | Dada rota previamente carregada, quando `/route` reabre sem rede, então o shell genérico aplica sessão/partição; dadas expiração, recuo, ausência ou identidade trocada, então a leitura é bloqueada. | domínio/serviço unitários, E2E hard refresh |
| 4 | Dada a rota local autorizada, quando consultada offline, então data, vendedor, progresso, versão, paradas e endereços aparecem; Maps/reordenação ficam indisponíveis e copiar endereço permanece. | E2E controlado/real, captura móvel |
| 5 | Dado logout ou troca de vendedor, quando a revogação ocorre, então ponteiro/sessão deixam de autorizar e rota/outbox não são apagadas; cache concorrente não reabre acesso. | serviço/repositório unitários, E2E logout |
| 6 | Dadas gravações concorrentes, quando a antiga termina depois, então versão/execução/sessão mais novas vencem atomicamente; após reordenação confirmada, a cópia é atualizada. | concorrência unitária, E2E real |
| 7 | Dado o checkout local, quando os gates são executados, então CLI, lint, tipos, testes, build, integração e jornadas passam com fixtures sintéticas. | `validation.md`, 372 PASS |

## Qualidade e arquitetura

- Contratos estritos e transformação pura permanecem em `packages/*`; UI não acessa Dexie diretamente.
- Dexie v4 segue expand-only e preserva stores/índices. Rota e sessão são tratadas na mesma transação.
- A seleção monotônica usa versão de composição, versão de execução e `cachedAt`; a sessão também não retrocede temporalmente.
- A revogação cria barreira síncrona, cancela cache ainda aguardando worker e remove o ponteiro antes de uma exclusão potencialmente falha.
- O Service Worker armazena somente shell/ativos; API e conteúdo privado não entram em Cache Storage.
- Sem dependências, segredos, dados pessoais ou mudanças de servidor.

## NFRs

- **Segurança — PASS:** fail-closed, partição usuário/dispositivo, nenhuma credencial local, troca/logout e corridas negativas testadas.
- **Confiabilidade — PASS:** upgrade preservador, atomicidade, quota, resposta fora de ordem, hard refresh e regressão real cobertos.
- **Desempenho — PASS no recorte:** no máximo 50 paradas, IndexedDB indexado e cache em segundo plano; nenhuma chamada/SDK externo adicional no render.
- **Manutenibilidade — PASS:** fronteiras claras, schemas runtime, testes em níveis adequados e README/evidência atualizados.
- **Acessibilidade/UX — PASS no automatizado/visual:** layout mobile sem overflow, ações desabilitadas com explicação e clipboard alternativo. Aparelho físico permanece pendente por `AB-14`.

## Revisão automatizada e regressão

CodeRabbit final: `review_completed`, 24 arquivos, zero findings. Rodadas anteriores encontraram quatro condições major válidas e todas foram corrigidas com testes. Gates finais reproduzidos pelo executor: 158 unitários, 182 pgTAP, 14 integrações, 17 E2E controlados e 1 E2E real; lint, TypeScript e build PASS.

## Issues e recomendações

Nenhum issue bloqueante ou dívida nova específica desta story. Antes do piloto, validar Android/Chrome físico, quota/limpeza real e política de privacidade/retenção conforme `AB-14`/`AB-15`.
