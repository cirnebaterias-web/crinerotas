# ADR 009 — Propostas semanais de rotas comerciais com aprovação do gestor

## Estado

Desenho preparado em 04/11/2026 e atualizado em 09/11/2026 pela Story 4.33. A proposta determinística por regras, a revisão versionada e o mapa inteligente estão implementados; integração externa de IA e otimização rodoviária continuam futuras. Complementa o planejamento manual da Story 4.8 e os sinais comerciais da Story 4.14; amplia o escopo anterior da arquitetura §7.5 sem indicar que um fornecedor de IA já esteja configurado.

## Requisitos confirmados

- Propor a semana de segunda a sexta para cada vendedor, com até 10 clientes por dia.
- Considerar situação do cliente, tempo sem compra, periodicidade/oportunidade comercial, localização de clientes e vendedor e débito de sucata.
- O gestor revisa, ajusta e aprova antes de publicar a semana para os vendedores.
- O vendedor pode incluir um cliente na sua rota durante o dia. Acima de 10, somente após aprovação do gestor (resposta expressa do usuário).
- Usar a cidade onde o vendedor mora como origem da sugestão semanal (regra atualizada em 05/11/2026). Usar a localização atual do celular apenas ao reorganizar a rota durante o dia.
- Cidades-base informadas: Eugenio — Natal; Lays — Parnamirim; Marcelo — Apodi; Felipe — São Pedro. São contexto de operação, não coordenadas residenciais nem substituto automático do GPS.
- Felipe será desligado futuramente; o substituto, sua identidade e sua cidade-base ainda são desconhecidos. A carteira precisa suportar transição temporária sem titular, sem atribuição ou geolocalização presumida.
- Refinamento confirmado: usar Q (`Endereço encontrado Google`) e U (`Google Place ID`) da aba Base clientes, preservando P/R como qualidade da fonte; lat/lng podem ser imprecisas. GPS observado nas visitas deve permanecer disponível para confronto/revisão posterior, sem sobrescrita automática do cadastro.
- Regra comercial confirmada: mais de 180 dias desde a última compra positiva classifica o cliente como inativo/perdido para a proposta automática. Exatamente 180 dias ainda é elegível. Ausência de compra positiva é estado distinto e requer revisão; não recebe dias fictícios. A classificação não altera nem arquiva o cadastro-fonte.

## Evidência do aplicativo atual

- `route-planning-dashboard.tsx` monta rotas manualmente por data/vendedor e ordena a página carregada por recência ou volume médio. Não produz um plano semanal.
- `api.get_sales_route_signals` lê lotes de até 50 clientes elegíveis, com escopo do vendedor e geração de vendas fixada.
- `get_client_scrap_summary` e a geração corrente do ledger oficial fornecem saldo, débitos e último crédito; registros operacionais de coleta não são crédito oficial até conciliação na fonte.
- Contratos atuais aceitam até 50 paradas por rota; limitar somente a tela não satisfaria a nova regra de 10.
- A publicação existente é versionada; mudanças de composição usam versão sucessora e preservam execuções anteriores.
- Banco local de prévia: 712 clientes; 573 ativos vinculados às quatro carteiras. Desses, 356 têm coordenadas e 217 não têm. Distribuição de ativos com coordenadas: Eugenio 85/133, Felipe 60/141, Lays 114/147, Marcelo 97/152.
- Não foi encontrada integração de fornecedor de IA ou de cálculo rodoviário nos contratos/configurações de exemplo inspecionados.

## Desenho

### 1. Origem e qualidade geográfica

Para a sugestão semanal, usar a cidade-base vigente cadastrada no perfil operacional do vendedor e registrar cidade, UF, código IBGE, sede municipal como referência e versão da configuração. A referência representa o município de partida, não o endereço residencial do colaborador. Cidades atualmente confirmadas: Eugenio — Natal/RN (2408102); Lays — Parnamirim/RN (2403251); Marcelo — Apodi/RN (2401008); Felipe — São Pedro/RN (2412708). A associação deve ser persistida como configuração administrável e versionada, e não permanecer fixada no código-fonte. A tela do gestor nunca usa o GPS do aparelho do gestor como origem do vendedor.

Uma proposta semanal exibe a cidade-base como hipótese de partida. Ela não prevê o endereço exato ou onde o vendedor estará em todas as manhãs. Na execução diária, uma captura pontual no celular do próprio vendedor permite reorganizar as paradas ainda pendentes. Persistir instante, precisão, autor e versão dessa captura diária. Visitas iniciadas/concluídas e sua evidência permanecem preservadas.

Cidade-base ausente ou sem referência municipal configurada gera pendência visível e impede alegar otimização semanal. GPS diário negado, indisponível, impreciso ou antigo também gera pendência visível para reorganização. Coordenadas municipais devem vir de configuração versionada e identificada, não ser inventadas em tempo de execução pelo nome da cidade. O limite de idade/precisão do GPS diário permanece configuração explícita da política.

### 1.1. Transição de vendedor e carteira sem titular

Desligamento e substituição são eventos distintos e possuem data de vigência. Registrar um desligamento futuro não bloqueia o vendedor antes da data efetiva. A partir da vigência, o usuário deixa de receber novas propostas e rotas; autenticação e sessões seguem as regras de desativação da identidade. Rotas e visitas históricas continuam vinculadas ao vendedor que realmente as executou.

A carteira comercial pode permanecer temporariamente `sem_titular`. Nesse estado, clientes, vendas, conta-corrente de sucata e histórico permanecem consultáveis pelo gestor, mas o motor não gera proposta semanal e não escolhe outro vendedor automaticamente. A pendência deve informar que falta atribuir um titular ativo.

Quando o substituto for contratado, o gestor cadastra sua identidade, configura a cidade-base e atribui a carteira com vigência. Somente propostas posteriores usam o novo vendedor e sua própria cidade-base. Não copiar automaticamente a cidade de Felipe, não transferir autoria histórica e não reutilizar sessões ou dispositivos. Alterações de titularidade e cidade-base registram valor anterior, novo valor, autor, motivo e instante/vigência.

Clientes com Place ID ou endereço Google útil continuam elegíveis na proposta mesmo sem latitude/longitude. Navegação usa Place ID prioritariamente e endereço Google como fallback; a falta de par lat/lng é pendência para cálculo geográfico, não exclusão comercial. Não recebem distância/tempo fictícios. Somente clientes sem qualquer destino útil precisam de revisão de localização para navegação. Status Geo (P) e Precisão Google (R) expressam qualidade reportada pela fonte, não confirmação independente.

A Story 4.22 entrega importação/persistência Q/U/P/R, propagação ao snapshot de rota, navegação e preservação/inspeção autorizada da evidência GPS de visita. GPS, precisão, instante, autor e contexto da visita são fatos separados do destino importado. A sincronização não converte observação em atualização cadastral nem reescreve observações históricas. Um fluxo posterior de revisão e aprovação de localização canônica exige story própria; a fundação não declara essa tela implementada, não escreve na planilha e não resolve Place IDs por API paga.

### 2. Inteligência comercial e geográfica

O motor lê toda a carteira elegível, e não apenas a página exibida. Fixar versões/instantes das fontes de clientes, vendas, sucata e origem para tornar cada proposta explicável e reproduzível.

Elegibilidade e restrições são verificadas pelo servidor antes e depois da geração: usuário ativo, carteira autorizada, cliente ativo/não arquivado, dia útil, duplicidade no dia, visitas existentes e capacidade diária. Clientes com mais de 180 dias desde a última compra positiva são classificados como inativos/perdidos e excluídos da sugestão automática; a comparação é estrita, portanto 180 dias ainda é elegível. Clientes sem compra positiva, inativos cadastrais e status indefinido ficam em grupos explícitos para revisão, sem serem tratados automaticamente como oportunidade ativa ou como zero dias.

Sinais de prioridade:

- Atraso relativo ao ciclo de compra do cliente, com dias desde a última compra e a periodicidade observada.
- Volume histórico e tendência comercial como contexto, distinguindo ausência de histórico de baixa oportunidade.
- Débito oficial de sucata, evolução e última coleta, identificado como objetivo de negociação/coleta e não como probabilidade de venda.
- Proximidade da origem e agrupamento dos clientes do mesmo corredor/região para reduzir deslocamentos.

### 2.1. Rotina de cobertura e estratégia semanal

Oportunidade de compra e obrigação de visita são eixos independentes. Todo cliente ativo com compra positiva há até 180 dias permanece no universo automático, mesmo comprando dentro de seu ciclo. A política `weekly-route-rules-v3` usa cadência inicial de 28 dias a partir da última visita **concluída**. Rascunho, publicação, início, cancelamento, não visita e uma nova compra não quitam essa cobertura.

Estados de cobertura: sem visita concluída registrada, vencida, vencendo na semana, coberta e fonte indisponível. Fonte indisponível não equivale a primeira visita e não autoriza afirmar que a rotina está em dia. Coberturas vencidas são ordenadas pelo maior atraso antes do score comercial; clientes ainda comprando completam a capacidade disponível e permanecem visíveis para evitar que a rotina seja substituída apenas por oportunidades.

A semana escolhe uma estratégia coerente `local`, `trip` ou `pending`. Distância conhecida de 80 km ou mais da cidade-base caracteriza viagem; 30 km continua sendo o limite entre paradas consecutivas conhecidas, sem limitar o acesso da base ao primeiro cliente. A capacidade máxima é 50 visitas por semana, não uma promessa de cobertura integral; pendências por capacidade, distância, cluster ou localização são contabilizadas e explicadas.

O gestor pode regenerar explicitamente com preferência `auto`, `local` ou `trip`. `auto` mantém a inferência pelo cliente de maior prioridade de cobertura/comercial; `local` considera clientes posicionados abaixo de 80 km da cidade-base e `trip` considera um cluster posicionado a partir de 80 km. A preferência não contorna elegibilidade, limite diário, trechos de 30 km, versão ou aprovação. Quando não há cliente posicionado compatível, o resultado permanece `pending` em vez de fabricar uma região.

Pesos e critérios de desempate devem ser explícitos e versionados. Não apresentar ranking heurístico como previsão estatística calibrada de fechamento. Sem dados suficientes, emitir indicação de baixa confiança/revisão.

O motor distribui clientes em cinco dias, respeita rotas/compromissos existentes e não preenche 10 obrigatoriamente. Dez é teto normal, não meta que justifique viagens inviáveis. Evitar repetição automática do mesmo cliente na semana; retorno motivado pode ser incluído pelo gestor.

Distância geográfica, se utilizada, deve ser chamada de distância aproximada em linha reta. Tempo e distância rodoviários exigem serviço/matriz apropriada; não derivar ETA fictício por velocidade arbitrária. Jornada e duração de visitas ainda não foram informadas, portanto a primeira proposta não promete viabilidade por horário.

### 3. Papel da IA

A IA recebe somente candidatos autorizados e fatos estruturados necessários para sugerir distribuição e justificar visitas. A otimização e a validação de restrições ficam no motor do servidor. O resultado referencia IDs de candidatos; novos IDs, métricas inventadas e mudanças fora do escopo são rejeitados.

A IA não possui ferramenta de publicação, alteração de carteira ou criação de crédito de sucata. Motivos e valores exibidos são conferidos contra o snapshot da proposta. Texto da planilha é dado, nunca instrução para o agente.

Registrar modo (`rules` ou `ai_assisted`), versão da política, modelo quando utilizado, data, origem, gerações das fontes e justificativas. Falha do fornecedor pode permitir uma proposta por regras claramente identificada; nunca rotular essa saída como resultado de IA.

Fornecedor, credencial server-side e teto de gasto precisam ser definidos para ativar chamadas reais. Não há necessidade de transmitir endereço residencial, senha, e-mail de login ou CNPJ completo ao modelo quando IDs internos e métricas agregadas bastam. Nenhum fornecedor externo foi acionado neste desenho.

### 4. Revisão e publicação

Estados da proposta: rascunho → aguardando revisão → aprovada/publicada ou rejeitada/substituída. Uma aprovação se refere a uma versão exata; alterações posteriores invalidam aquela aprovação para a nova versão.

Solicitar a mesma semana abre a proposta ativa sem mutação. Regeneração é uma ação explícita com `expectedVersion`, idempotência e vínculo com a versão predecessora. Quando já existe publicação, a nova sugestão nasce em rascunho e a publicação anterior permanece disponível ao vendedor até a aprovação transacional da sucessora. Alterações locais não salvas bloqueiam publicação e troca silenciosa de contexto.

O gestor vê cinco dias por vendedor, clientes, objetivo/motivo, sinais de compra, débito de sucata, contagem diária, origem usada e pendências. Pode trocar o dia, remover/incluir cliente e reordenar antes de aprovar.

Reutilizar os comandos canônicos de criação/revisão/publicação de rotas e seus snapshots. A aprovação da semana deve ser transacional ou possuir um estado explícito de publicação parcial com retomada idempotente; nunca indicar semana publicada se parte falhou. Revalidar carteira, situação dos clientes, limites e versões no ato de aprovar.

### 5. Inclusão de cliente pelo vendedor durante o dia

Fluxo autorizado: escolher cliente elegível da própria carteira → informar motivo → verificar a versão e a capacidade no servidor → incluir na rota do dia, auditando a origem da inclusão. Até 10, a inclusão usa a autonomia solicitada; o gestor vê a alteração e sua autoria.

Acima de 10: criar solicitação pendente com contagem resultante, cliente, motivo e referência à versão. Somente aprovação do gestor efetiva a inclusão adicional. Recusa ou ausência de aprovação não adiciona visita operacional.

Uma exceção vale para a inclusão aprovada; não é autorização permanente para ultrapassar o limite. Operações simultâneas precisam bloquear/revalidar o agregado para impedir que duas inclusões consumam a mesma última vaga. Duplicação de envio deve retornar o resultado original.

Uma inclusão nunca altera os fatos das visitas já executadas. Se o aparelho estiver offline, a solicitação permanece pendente de confirmação; uma parada que depende de aprovação não aparece como aprovada localmente.

### 6. Ordem de implementação e verificação

1. Contratos e comandos CLI: políticas, captura de origem do próprio vendedor, proposta semanal e revisão por versão.
2. Banco/API: leitura agregada por carteira, persistência da proposta, aprovação, limite diário e solicitação de exceção; testes de autorização e concorrência.
3. Motor: ranking explicável, agrupamento geográfico, distribuição de segunda a sexta, snapshots e avisos por dados ausentes.
4. Telas: planejamento semanal do gestor, origem/inclusão no celular do vendedor e pendências de aprovação.
5. Adaptador de IA real após configuração de fornecedor/credencial/teto; sem acesso de publicação.
6. Testar com as quatro carteiras, origem ausente/negada, clientes sem coordenadas, fonte desatualizada, geração duplicada, limite 10, duas inclusões concorrentes, aprovação da 11ª e preservação de visitas existentes.

## Pendências objetivas

- Configuração de fornecedor de IA, credencial e orçamento para chamadas reais.
- Configurar e versionar as referências municipais das quatro cidades-base. A captura de GPS pelo celular continua necessária somente para reorganização durante o dia.
- Avaliar qualidade das coordenadas para cálculo geográfico, sem excluir clientes com Place ID/endereço útil; definir integração rodoviária somente se necessário estimar tempo de viagem. A correção canônica baseada em GPS observado requer fluxo de revisão próprio.
- Jornada e duração de visitas, se o plano precisar garantir horários em vez de apenas limite de clientes e aproximação geográfica.

As pendências de fornecedor não impedem construir as regras, o fluxo de aprovação e a interface de propostas.
