# Story 2.3 — experiência visual do vendedor

Ambiente: Windows, Node 24.19.0, Next 16.3.4, Supabase local isolado, somente atores/clientes sintéticos. Sem migração, dependência nova, push, deploy ou alteração de autenticação GitHub.

## Fluxo entregue

- `/login` e `/`: formulário de vendedor, mostrar/ocultar senha, erro genérico e orientação honesta de recuperação.
- `POST /api/v1/auth/session`: corpo limitado, Origin/CSRF, rejeição de Bearer, identidade atual ativa e capacidade `route.read_self`. Cookies provisórios só são enviados após autorização.
- `DELETE /api/v1/auth/session`: sign-out local e remoção dos cookies do navegador, inclusive na falha do provedor; indisponibilidade continua explícita.
- `/route`: `/me` antes da rota de hoje; data operacional, vendedor, progresso por visitas concluídas, estados, prioridades, endereços e ordem do servidor.
- Reordenação: rascunho transitório, apenas pendências, posições não pendentes preservadas, cancelar/salvar, recarga canônica e 409 sem sobrescrita automática.
- `/demo/offline`: laboratório anterior, com fallback independente. `/route` offline pede reconexão e não usa fixtures.

## Evidências automatizadas

| Camada | Resultado registrado |
| --- | --- |
| Lint / TypeScript | PASS |
| Unitários | 124 testes / 28 arquivos — PASS |
| PostgreSQL / pgTAP | 182 testes — PASS |
| HTTP, CLI e Supabase reais | 14 testes — PASS |
| E2E com respostas controladas + regressão offline | 11 testes — PASS |
| E2E com Supabase real | 1 teste — PASS |
| Build após ajustes finais | PASS |

O ensaio real faz login com `seller_a`, mostra duas paradas publicadas, altera a ordem, recarrega a página para comprovar persistência, sai e comprova acesso negado sem sessão. Credenciais são lidas somente do manifesto ignorado pelo Git. Traces estão desativados neste ensaio; capturas de login são feitas antes de preencher os campos.

Os primeiros testes visuais revelaram problemas nos próprios testes (seletor de alerta também capturava o anunciador do Next; incremento de índice dentro de `find` na fixture; `goBack` após `replace` retornava à página anterior ao aplicativo). Foram corrigidos sem enfraquecer os critérios de sucesso: salvamento continua exigindo resposta e recarga canônicas, e retorno após logout não mostra dados privados.

## Revisão automatizada

CodeRabbit via WSL, comando suportado pela versão instalada: `coderabbit review --uncommitted --include-untracked --agent`.

1. Duas observações major, verificadas e corrigidas: remover cookies da sessão anterior quando uma troca de conta é negada; `Secure` por padrão quando não há comprovação de origem HTTP local.
2. Segunda execução concluída: **zero apontamentos**.

Após essa execução, a regra de login foi extraída para `server/auth/session.ts`, conforme a fronteira de aplicação da arquitetura, mantendo o handler responsável por transporte/cookies. Ajustes visuais finais: espaço entre as linhas do título no celular e contraste do símbolo da marca sobre fundo verde. Esses diffs são inspecionados manualmente e revalidados pelos gates.

## Inspeção visual

Capturas a 390×844 e 1440×1000. Hierarquia e paleta derivadas da referência; nenhum número ilustrativo é apresentado como dado do vendedor. Sem overflow horizontal; botões têm pelo menos 44px, rótulos acessíveis e foco CSS explícito. Não é certificação WCAG nem ensaio em aparelho físico.

- `login-mobile.png`, `login-desktop.png`: entrada vazia, sem credenciais.
- `route-real-mobile.png`, `route-real-desktop.png`: dados sintéticos vindos do Supabase local.
- `route-390.png`, `route-1440.png`: fixture de teste com uma parada concluída para demonstrar progresso e preservação da posição não pendente.

O navegador integrado estava indisponível (nenhum navegador descoberto). A inspeção foi feita nas imagens geradas pela suíte Playwright do repositório, sem automação alternativa da sessão pessoal do usuário.

## Limites mantidos

Esta é uma primeira visualização funcional, não a aprovação do MVP completo para piloto. Visita, mapas, gestão, recuperação SMTP, dados reais, instalação em celular físico e rota canônica offline permanecem para seus incrementos próprios. O rascunho de reordenação só permanece em memória até salvar; nenhuma confirmação offline é simulada.
