# Cirne Momentum — especificação do Design System

**Versão:** 0.1

**Data:** 11/11/2026

**Estado:** fundação aprovada; migração incremental

## 1. Propósito

Cirne Momentum é a linguagem visual e de interação do Cirne Rotas. O sistema combina:

- progresso visível, tarefas curtas e feedback positivo do Duolingo;
- papéis semânticos, componentes previsíveis e acessibilidade do Material Design;
- clareza, contenção, hierarquia e movimento intencional das plataformas Apple.

Essa combinação é uma referência de princípios, não uma cópia visual. Mascotes, ícones, assets, nomenclaturas, formas distintivas e trade dress das marcas de referência não pertencem ao Cirne Rotas.

O Design System continua subordinado ao PRD: uma ação principal por etapa, estado real sempre visível, operação tolerante a rede instável e experiência profissional que não pareça vigilância.

## 2. Princípios

1. **A próxima ação é evidente.** Cada contexto destaca uma ação dominante e mantém alternativas visualmente secundárias.
2. **Progresso encoraja, não pressiona.** A interface mostra avanço de visita e rota, sem ranking, streak, XP, moedas, vidas ou comparação pública.
3. **O estado é mais importante que o efeito.** Salvo no aparelho, sincronizando, sincronizado, conflito e erro permanecem textuais e não dependem de cor ou animação.
4. **Campo e gestão compartilham a fundação.** Campo é tátil, direto e espaçado; gestão é mais densa e analítica. Tokens, estados e linguagem permanecem comuns.
5. **Acessibilidade faz parte do componente.** WCAG 2.2 AA, teclado, foco, zoom, reflow e redução de movimento são critérios de aceite.
6. **Movimento confirma causa e efeito.** Transições são curtas, não bloqueantes e dispensáveis para compreensão.
7. **Compatibilidade antes de ruptura.** A migração preserva seletores operacionais e aliases até que cada feature tenha cobertura de regressão.

## 3. Linguagem por contexto

### Campo

- Mobile-first, leitura sob sol e uso com uma mão.
- Controles com no mínimo 44 px; campos com 48 px; CTA principal móvel com 52 px quando o layout permitir.
- Cartões com borda clara, pouca sombra e uma ação dominante.
- Progresso da visita e do dia sempre ligado a tarefas reais.
- Confirmação local imediata e confirmação remota somente após resposta canônica.

### Gestão

- Maior densidade informacional sem reduzir legibilidade ou alvos interativos.
- Tabelas somente quando a comparação linha/coluna for necessária; cartões e detalhes progressivos nos demais casos.
- Gamificação não se aplica aos dashboards.
- Elevação e cor não substituem agrupamento, rótulos e hierarquia tipográfica.

## 4. Tokens

A fonte executável dos tokens está em `apps/web/src/styles/tokens.css`.

### Cores semânticas

| Papel | Valor inicial | Uso |
| --- | --- | --- |
| `brand` | `#00A651` | Marca e elementos gráficos; não usar com texto branco pequeno |
| `primary` | `#00783B` | Seleção, confirmação e ação primária verde |
| `on-primary` | `#FFFFFF` | Conteúdo sobre `primary` |
| `primary-container` | `#E8F5ED` | Seleção e conclusão suave |
| `action` | `#FF7900` | CTA operacional destacado |
| `on-action` | `#121512` | Conteúdo sobre laranja |
| `surface-canvas` | `#F3F6F4` | Fundo do aplicativo |
| `surface` | `#FFFFFF` | Cartões e conteúdo |
| `on-surface` | `#121512` | Texto principal |
| `on-surface-muted` | `#5C6A61` | Texto secundário |
| `outline` | `#8FA399` | Controles e limites interativos |
| `outline-variant` | `#DCE5DF` | Divisores e cartões |
| `focus` | `#B45000` | Foco visível |

Sucesso, alerta, erro e informação possuem sempre um par texto/container. O verde de marca com branco e o laranja com branco não atingem contraste suficiente para texto pequeno; use os papéis `primary/on-primary` e `action/on-action`.

### Escalas

- Espaçamento: `4, 8, 12, 16, 24, 32, 40, 48, 64` px.
- Raios: `8` pequeno, `12` controle, `16` cartão, `20` destaque e `999` pill.
- Tipografia: body `16/24`, body-sm e label `14/20`, mínimo operacional `13/18`, títulos `18, 24, 32, 40`.
- Movimento: `120 ms` rápido, `180 ms` padrão e `240 ms` enfatizado.
- Elevação: nenhuma, cartão e modal.

Valores novos devem usar papéis semânticos. Valores hardcoded só são aceitáveis durante uma migração documentada ou quando representam dados externos, como cores distintas de rotas no mapa.

## 5. Componentes fundamentais

### Button

Variantes: `primary`, `action`, `secondary` e `quiet`. Tamanhos: padrão, campo e CTA. O componente mantém foco visível, estado desabilitado e `aria-busy` para carregamento.

- `primary`: ação principal verde e confirmação.
- `action`: ação operacional laranja com texto escuro.
- `secondary`: alternativa explícita em superfície branca.
- `quiet`: ação de baixa ênfase, nunca a única indicação de tarefa crítica.

### StatusChip

Resumo curto de estado com texto obrigatório. Tons: neutro, sucesso, alerta, erro e informação. Não usar como única explicação de conflito ou erro acionável.

### Progress

Usa o elemento nativo `progress`, rótulo acessível e valor limitado entre zero e o máximo. Progresso representa somente trabalho real; não é pontuação comportamental.

### StatusBanner

Feedback persistente com título textual, marcador visual e papéis de cor. Erro usa `alert`; os demais estados usam `status`, salvo quando o contexto exigir papel explícito diferente.

### Próximos componentes

`TextField`, `Select`, `Checkbox`, `Radio`, `IconButton`, `FormField`, `TaskCard`, `StopCard`, `SyncStatus`, `ContextBar`, `RouteProgress`, `Dialog/Sheet`, `ResponsiveDataView` e `OfflineQueue` serão migrados por stories específicas.

## 6. Estados obrigatórios

Componentes interativos devem definir, quando aplicável: repouso, hover, foco, pressionado, selecionado, desabilitado e carregando. Fluxos de dados devem distinguir: erro, sucesso, offline, salvo localmente, sincronizando, sincronizado e conflito.

Nenhuma informação crítica pode depender somente de toast, animação, ícone ou cor. Toasts podem complementar, nunca substituir o estado persistente.

## 7. Movimento e celebração

- Pressão e resposta de controle: 80–120 ms.
- Transição padrão: 180 ms.
- Mudança de progresso: até 240 ms.
- `prefers-reduced-motion` reduz as durações a um valor praticamente instantâneo.
- Celebração é curta, não bloqueante e restrita à conclusão canônica de uma visita ou rota.
- Falha técnica, perda de rede e fila offline nunca removem progresso visual já confirmado localmente.

## 8. Acessibilidade

- Meta formal: WCAG 2.2 AA.
- Alvos de toque de pelo menos 44 px.
- Texto, ícone ou legenda acompanham estados de cor.
- Foco visível e ordem de teclado coerente.
- Zoom de 200%, reflow a 320 px e fonte ampliada sem sobreposição do CTA.
- Nomes acessíveis e mensagens de erro próximas ao campo.
- `forced-colors` deve preservar estrutura e ações.
- Testes automatizados de contraste e semântica complementam, mas não substituem, leitor de tela e aparelho Android real.

## 9. Usos proibidos

- Ranking público ou comparação entre vendedores.
- XP, moedas, vidas, streak diária ou perda de progresso por falha técnica.
- Mensagem culpabilizante ou recompensa por volume que incentive dados incompletos.
- Dependência de gesto oculto, translucidez decorativa ou controle menor para simular outra plataforma.
- Cópia de mascote, ilustração, iconografia ou componente distintivo das referências.
- Tema escuro ou telemetria de comportamento sem story e definição de negócio próprias.

## 10. Migração

1. **Fundação:** tokens, primitivas, contraste e documentação sem mudança ampla de aparência.
2. **Núcleo móvel:** formulários, banners, tarefas, paradas, contexto e progresso do vendedor.
3. **Gestão:** navegação, filtros, métricas, tabelas responsivas, diálogos e planner.
4. **Long tail e governança:** logística, sucata, CRM, mapas, catálogo de componentes, regressão visual e lint contra novos hardcodes.

Durante a migração, classes `seller-*` e aliases `--cirne-*` podem coexistir com `cr-*`. A remoção exige cobertura equivalente e busca sem consumidores remanescentes.

## 11. Referências

- Produto: `Docs/prd.md`, seções 3.1–3.9.
- Arquitetura: `Docs/architecture.md`, seções 10, 12, 16 e 17.
- [Material Design Foundations](https://m3.material.io/foundations/)
- [Material Design Color Roles](https://m3.material.io/styles/color/the-color-system/)
- [Apple Design Principles](https://developer.apple.com/design/human-interface-guidelines/design-principles/)
- [Apple Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Duolingo: gamificação e hábito](https://blog.duolingo.com/duolingo-101-how-to-learn-a-language-on-duolingo/)
