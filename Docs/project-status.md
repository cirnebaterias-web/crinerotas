# Estado atual do projeto Cirne Rotas

Atualizado em 13 de novembro de 2026, no fuso `America/Sao_Paulo`.

Este é o ponto de retomada do projeto após a publicação da Story 4.41. A aplicação está publicada e saudável, a `master` remota contém todas as entregas descritas abaixo e não há migração de banco pendente conhecida.

## Versão publicada

| Item | Estado |
| --- | --- |
| Aplicação | https://cirnerotas.5speiv.easypanel.host/ |
| Git `origin/master` | `6af6f7ec9ddfcc412fadc2888e88877354d04a22` |
| Último PR | [PR 36](https://github.com/cirnebaterias-web/crinerotas/pull/36) |
| Imagem em produção | `ghcr.io/cirnebaterias-web/crinerotas@sha256:562a638480bf7608dcb210a1f097b5d931d3fd00c25efacb6fb65a5195e8c447` |
| EasyPanel | Serviço `cirne-rotas/web`, zero downtime, uma réplica saudável |
| Supabase | Projeto de produção ativo, histórico reconciliado até `20261118120000_visit_sales_reports.sql` |

Na verificação pós-publicação, `/`, `/home` e `/api/v1/health/live` responderam HTTP 200, `ops:live` passou, o container estava saudável e sem reinícios, e as 24 variáveis de ambiente foram preservadas. Somente `CIRNE_RELEASE_SHA` foi atualizado. Não houve alteração de schema na Story 4.41.

O digest anterior `sha256:3427e463138fb48bffe86eae9a2fbb3e94562f981f9a6167ed894e3a62a3a088` permanece identificado como referência de rollback da versão imediatamente anterior.

## Entregas recentes

### Story 4.37 — Acessos administrativos

- Administração permite provisionar e redefinir o acesso dos vendedores por e-mail e senha.
- Perfis e papéis continuam protegidos pelas regras de autorização e auditoria do projeto.

### Story 4.38 — Sugestão semanal responsiva

- O mapa e os painéis da sugestão semanal foram contidos no layout.
- A revisão diária funciona em telas desktop e móveis sem sobreposição dos cartões e controles.

### Story 4.39 — Atalhos do vendedor

- A tela inicial do vendedor contém, no final da lista, os atalhos externos para o Catálogo Pioneiro e o Orbis.
- Os dois links abrem em nova aba com `noopener` e `noreferrer`.

### Story 4.40 — Informe de venda na visita

- A visita possui a tarefa obrigatória “Informe de venda na visita”.
- São registradas quantidades inteiras e não negativas de Heliar, América e Strada/Durex; zero é uma resposta válida.
- O informe funciona offline, sincroniza com idempotência, pode ser editado antes do encerramento e aparece no detalhe gerencial.
- O checkout exige o informe. Visitas legadas ainda pendentes possuem fluxo de recuperação sem perder evidências ou reescrever fatos já confirmados.
- A migração `20261118120000_visit_sales_reports.sql` está aplicada em produção.

### Story 4.41 — Análise móvel do estoque observado

- Depois de salvar o estoque da concorrência, o vendedor vê uma análise local antes das fotos.
- A tela mostra o share observado de marcas próprias contra concorrentes e os comparativos Heliar × Moura, América × Zetta e Durex/Strada × Pioneiro, Piobat e Eletran.
- A análise segmenta amperagem e famílias SLI, EFB e AGM, mostra lacunas observadas e sugere somente modelos com correspondência exata no catálogo publicado.
- Dados ausentes não são convertidos em zero. Linhas sem classificação ficam fora do corte detalhado e aparecem na cobertura parcial.
- A análise funciona offline, pode ser recalculada após edição e não substitui as 3–5 fotos obrigatórias.
- O catálogo offline foi enriquecido a partir da fonte aprovada sem alterar os oito campos históricos dos 156 produtos existentes.
- O gerador é determinístico, preserva proveniência, produz erros estruturados e limita o bootstrap legado ao mesmo destino canônico.

## Regras comerciais vigentes na análise de estoque

- “Nossas marcas” soma Heliar, América, Durex e ACDelco.
- “Concorrentes” soma todas as linhas concorrentes registradas.
- Share observado é calculado sobre unidades registradas na visita; total zero não produz percentual.
- Piobat e Eletran são reconhecidas somente como aliases exatos informados em “Outra marca”. Não há aproximação textual.
- `SLI/Frota` é agrupada em SLI; `EFB/Frota` em EFB; `AGM/Frota` e `AGM Moto` em AGM. Tecnologias desconhecidas permanecem não classificadas.
- A diferença de estoque é uma lacuna observada, não previsão de demanda nem quantidade recomendada de compra.
- Toda oferta deve confirmar aplicação, dimensões, polaridade e necessidade do cliente.

## Qualidade verificada

O gate final da Story 4.41 foi aprovado com 17 de 17 critérios atendidos. As evidências finais incluem:

- lint, typecheck e build aprovados;
- 1.003 testes unitários aprovados e um skip preexistente;
- 40 jornadas completas de navegador e sete jornadas finais focadas aprovadas;
- 14 cenários Python do gerador, com 13 aprovados e um skip de symlink por privilégio do Windows;
- validação de 156 de 156 produtos, sem diagnóstico de catálogo;
- CodeRabbit sem findings no patch final;
- nenhum XLSX, segredo, migration ou dado sintético de produção incluído na Story 4.41.

Os workflows de CI e release instalam `openpyxl==3.1.5` e `et_xmlfile==2.0.0` em ambiente virtual efêmero antes dos testes do catálogo. Os CIs de push, PR e `master`, além da release da imagem publicada, passaram.

## Limitações e pendências conhecidas

- Homologação em aparelho Android físico, TalkBack, câmera e GPS continua pendente. A automação cobriu larguras de 320, 360, 390 e 430 px, texto a 200% e axe sem violações.
- A consulta de logs pelo Loki do EasyPanel retornou HTTP 400 `fetch failed`; a publicação foi validada pelos logs do container, que não mostraram warnings, erros ou HTTP 5xx no período pós-deploy.
- Planilhas operacionais e credenciais permanecem locais e fora do Git. Não devem ser adicionadas ao repositório.
- O share exibido é participação no estoque observado na visita, não market share e não garantia de venda.

## Estado local e cuidados de retomada

- A pasta principal `C:\Projetos\Cirne_Rotas` está em uma branch local antiga e contém alterações do usuário em `AGENTS.md`, `.vscode/` e planilhas não rastreadas. Não resetar, limpar, mover ou sobrescrever esses arquivos.
- Para qualquer nova mudança, criar uma worktree limpa a partir de `origin/master` e trabalhar por nova story em `Docs/stories/`.
- Antes de publicar, executar `npm run lint`, `npm run typecheck`, `npm test` e `npm run build`, além dos testes focados, navegador, banco ou Python aplicáveis.
- Push, PR, merge e release são responsabilidade exclusiva do agente DevOps, conforme a Constitution do projeto.

## Próximo ponto de ação

O projeto pode ser retomado a partir da `origin/master` em `6af6f7ec9ddfcc412fadc2888e88877354d04a22`. O próximo trabalho deve começar com uma nova story e preservar os contratos offline, as regras de idempotência e as limitações comerciais registradas neste checkpoint.
