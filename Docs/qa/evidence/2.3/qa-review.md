# Revisão de QA — Story 2.3

Revisor: Quinn / aiox-qa. Data local: 2026-09-16. Revisão de código identificada no gate e na seção QA Results da story.

Profundidade: alta, por autenticação, cookies, conteúdo privado, concorrência e novo fluxo visual. Critérios usados: PRD, arquitetura monolítica, ACs da story, `qa-review-story.md` e schema de `qa-gate.md`. O checklist `qa-master-checklist.md` não existe nesta instalação. O template encontrado em `product/templates` define gates genéricos, não resultados de story; foi usado o schema explícito da tarefa e o padrão das stories anteriores.

## Rastreabilidade

| AC | Dado / Quando / Então e evidência |
| --- | --- |
| 1 | Vendedor ativo fornece credenciais → login BFF → identidade autorizada sem tokens no JSON; credencial incorreta, bloqueado e gestor rejeitados. Integração real e E2E de formulário. |
| 2 | Sessão existente troca para conta bloqueada → 403 e deleção de cookies; login/logout sem Origin/CSRF ou com Bearer → rejeição. Cookie HttpOnly/SameSite, Secure fora de HTTP local, limite de corpo e redaction testados. Logout/refresh sem sessão não mostram rota anterior. |
| 3 | Identidade autorizada consulta hoje → renderiza data/cliente/estado/progresso canônicos; vazio, indisponibilidade e ausência de sessão distintos. E2E controlado e Supabase real. |
| 4 | Pendências entre posições encerradas → mover preserva posições fixas; Cancelar não envia comando; Salvar envia expectedVersion e ordem completa, seguido de recarga. 409 exige ação explícita; falha de rede mantém rascunho sem sucesso falso. Unitários, E2E e concorrência real do endpoint. |
| 5 | Viewports 390px/1440px → sem overflow, controles ≥44px, identidade/paleta/hierarquia da referência. Capturas inspecionadas; ícone invertido e espaço no título mobile corrigidos. |
| 6 | Laboratório sintético salvo → navegador offline → `/demo/offline` recupera registros; `/route` mostra reconexão e nenhuma fixture. Regressão de quota, IndexedDB e Cache Storage preservada. |
| 7 | Gates locais e dois níveis de E2E; o ensaio real usa credenciais ignoradas pelo Git, desativa traces e captura login antes do preenchimento. Resultados em `visual-mvp.md`. |

## Segurança e confiabilidade

- O servidor usa apenas chave publicável e sessão do chamador; não existe chave administrativa no fluxo.
- A sessão nova é mantida em buffer até a política de vendedor ativo aprovar. Erros do provedor não são devolvidos integralmente nem registrados com payload.
- O caso de uso em `server/auth/session.ts` concentra a autorização; handler compõe transporte e cookies. Nenhum componente chama Supabase/fetch/Dexie diretamente.
- Revalidação de escopo permanece nos endpoints existentes. O frontend confere também o dono da rota recebida, descarta respostas obsoletas, remove dados antes da recarga/logout e recebe aviso de troca de sessão entre abas.
- Não há persistência de token ou rota privada no localStorage/Cache Storage; o rascunho de ordem desta story é explicitamente transitório. Offline canônico não é alegado.
- Timeout de 15s no cliente evita espera ilimitada na UI. Sucesso exige resposta canônica; confirmação perdida não equivale a falha comprovada da mutação.
- SQL, migrações e contratos de execução v2 permanecem inalterados. A auditoria e o controle otimista da Story 2.2 são reaproveitados.

## Revisão automatizada e inspeção final

Duas execuções CodeRabbit concluídas. As duas observações iniciais sobre cookies foram corrigidas e receberam regressões; a segunda execução terminou sem apontamentos. A extração posterior do caso de uso e os dois ajustes cosméticos foram inspecionados manualmente e cobertos pela repetição dos gates.

## Limites da conclusão

Acessibilidade verificada por semântica, foco explícito, contraste da paleta e dimensões dos controles; não é certificação WCAG ou ensaio com leitor de tela/aparelho físico. Desempenho validado funcionalmente com o limite contratual existente (50 paradas), sem benchmark de produção. Proteções e limites locais não substituem revisão de implantação/HTTPS, operação, retenção e aceite de piloto.

Sem pendências bloqueantes identificadas neste recorte. O veredito e a transição da story são publicados separadamente no gate após confirmação de todos os resultados finais.
