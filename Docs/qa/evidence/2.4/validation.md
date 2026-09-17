# Story 2.4 — Validação de desenvolvimento

Data: 2026-09-16. Branch: `story/2.4-navegacao-externa`.

## Resultado

Desenvolvimento concluído e pronto para revisão formal (InReview). Não equivale a gate QA independente, publicação ou aprovação do MVP completo.

| Gate executado | Resultado |
| --- | --- |
| `npm run ops:navigation -- --json` | PASS: diagnóstico sintético sem rede |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` | 148 PASS, 31 arquivos |
| `npm run build` | PASS, standalone preparado |
| `npm run test:integration` | 182 pgTAP + 14 HTTP/CLI PASS |
| `npm run test:e2e` | 16 PASS |
| `npm run test:e2e:real` | 1 PASS, Supabase local |
| CodeRabbit | Concluído; 1 apontamento minor documental, corrigido |
| `git diff --check` | PASS |
| Health da prévia `127.0.0.1:3000` | HTTP 200 |

Total: 361 testes aprovados. A primeira integração HTTP foi iniciada antes do fim do build e os 14 casos não executaram por ausência temporária do standalone; após concluir o build, a suíte completa foi repetida e passou. Nenhuma correção de produto foi necessária para esse problema de sequência.

## Rastreabilidade dos critérios

1. URL de destino: testes unitários cobrem endereço acentuado, parâmetros reservados, coordenadas zero/extremos, pares inválidos/incompletos, destino vazio, limite 2048 e domínio fixo. CLI de processo real verifica regra e rejeita argumentos sem ecoar valores. E2E confere o endereço exato em um único parâmetro.
2. Navegação não mutante: popup interceptado localmente, `window.opener === null`, sem Referer e nenhuma chamada de mutação à API. Ao retornar, conteúdo das paradas, rascunho, progresso e versão permanecem iguais. Não há tráfego Google antes do clique nem durante o ensaio (resposta sintética interceptada).
3. Cópia: sucesso usando clipboard real do Chromium; fallback testado com API ausente e permissão negada; texto manual selecionável e sem falso sucesso. Unitário cobre permissão pendente por mais de 3s. Offline mantém cópia e remove link externo; reconexão restaura link.
4. Segurança/layout: nenhum endpoint, cookie, contrato de autenticação, migração, dependência ou segredo novo. Nenhuma solicitação de geolocalização ou SDK. Capturas 390/1440 verificadas visualmente; sem overflow, foco visível e alvos >=44px.
5. Regressão: login, logout, vazio, indisponibilidade, sessão expirada, conflito, reordenação e laboratório offline continuam passando. Ensaio Supabase usa apenas vendedor sintético e valida ações novas na rota real.

## Evidência visual

- `navigation-fallback-390.png`: celular, cópia negada, campo selecionado e foco visível.
- `navigation-fallback-1440.png`: desktop, mesmo estado, sem sobreposição/overflow.
- `route-real-mobile.png`: rota carregada via autenticação real no Supabase local, ações presentes.
- `route-real-desktop.png`: rota real após reordenação/reload, layout preservado.

Navegador integrado indisponível (nenhum browser conectado); inspeção feita nas imagens produzidas pela suíte Playwright do projeto. Não houve teste em aparelho físico ou abertura real do Google Maps: o contrato da URL foi verificado contra a [documentação oficial](https://developers.google.com/maps/documentation/urls/get-started) e o clique foi interceptado para não transmitir dados.

## CodeRabbit e revisão manual

Comando WSL: `coderabbit review --uncommitted --include-untracked --agent`.
Resultado: review_completed, 15 arquivos revisados, 1 finding minor na story pedindo atualização do estado de implementação e File List. Ambos atualizados. Nenhum apontamento de código, segurança ou severidade alta/crítica. Revisão manual final confirmou fronteiras domínio/adaptador/UI e ausência de chamadas mutantes na navegação. O teste adicional de clipboard nativo e a documentação final foram conferidos após a captura inicial da revisão.

## Definition of Done — autoavaliação @dev

- [x] Requisitos e AC 1–5 implementados e vinculados a testes acima.
- [x] Padrões/estrutura: domínio puro, adaptador de browser isolado, componente sem fetch de negócio; CSS reutiliza tokens existentes, sem redesenho.
- [x] Segurança: origem externa fixa, query codificada, sem token/Referer/opener, sem dependências novas.
- [x] Unitários, integração e E2E aprovados; cenários de erro explícitos. Sem meta percentual adicional de cobertura definida para esta story.
- [x] Verificação funcional: CLI real, clipboard real, clique interceptado, Supabase local, prévia com health 200 e capturas inspecionadas.
- [x] Administração: checklist, decisões, Change Log e File List atualizados.
- [x] Build, lint e tipos aprovados. Dependências, migrações, novas variáveis e configuração externa: N/A.
- [x] Documentação: README e limitações atualizados; função pura/adaptador documentados.
- [x] Todos os itens aplicáveis do DoD de desenvolvimento atendidos; pronta para revisão formal, não marcada Done.

## Limites e operação

Registro de visitas, offline canônico, painel gerencial e navegação interna continuam fora desta story. `navigator.onLine` é apenas sinal de conectividade; não detecta indisponibilidade do Google. Copiar endereço exige que os dados já estejam visíveis; não habilita acesso offline à rota após recarga. ClickUp não foi alterado, aguardando confirmação da lista/nome solicitada ao usuário. Sem push/deploy ou alteração de credenciais globais.
