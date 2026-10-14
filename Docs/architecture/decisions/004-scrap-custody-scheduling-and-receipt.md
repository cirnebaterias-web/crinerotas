# ADR 004 — Coleta de sucata, agenda e confirmação de recebimento

## Status

Accepted — 2026-10-06. Associada à Story 3.10.

## Contexto e origem

O PRD, FR-027 a FR-035, exige resposta de sucata na visita, separação entre peso real e estimado, responsável, recibo e histórico da agenda. A arquitetura base já previa `ScrapReport`, `ScrapCollection`, `PickupSchedule` e revisões imutáveis; a Story 3.10 implementou esse recorte e as extensões de custódia descritas abaixo. O ADR registra a decisão e os limites da implementação, não substitui a validação operacional em produção.

Os pedidos de 2026-10-06 acrescentam:

- coleta feita pelo vendedor, com termo físico de duas vias assinado pelo cliente e pelo vendedor e fotografias dos comprovantes;
- identificação do ponto onde a sucata fica concentrada no interior ou entrega diretamente na matriz em Natal;
- agendamento futuro para a logística, também fora da rota/visita, com cliente da base, endereço, peso estimado, data, manhã/tarde e observação;
- confirmação autenticada de recebimento pelo perfil de Logística, consultável pela gestão/administração, fechando o ciclo cliente → vendedor → empresa;
- perfil próprio de Logística para o aceite e cadastro de pontos de concentração no sistema, confirmados na revisão do requisito;
- guarda operacional dos registros e comprovantes por cinco anos.

A confirmação de recebimento define um responsável operacional para o encerramento da custódia. Ela não estabelece SLA de agendamento nem autoriza inventar limites de peso, urgência ou regras de unicidade do recibo que continuam abertas em FR-035. A foto e as assinaturas são registro operacional; esta decisão não afirma conformidade jurídica nem suficiência probatória.

## Decisão

### Um domínio de sucata com dois fatos distintos

Coleta realizada e agendamento são entidades distintas. O peso estimado de um agendamento não gera uma coleta nem entra em kg realizados. Nesta story, o agendamento gera uma pendência consultável; sua execução futura pela logística não está incluída. O aceite de recebimento refere-se exclusivamente à sucata já coletada pelo vendedor.

Na visita, a resposta inicial é discriminada: `collected`, `scheduled` ou `none`. Mantém-se a possibilidade estrutural de múltiplos eventos, sem habilitar coleta e agendamento simultâneos na mesma resposta até decisão explícita para FR-028. A visita exige uma resposta; `none` não produz peso nem pendência.

O agendamento independente referencia cliente e vendedor autenticado, com `visitId` ausente e origem `standalone`. O agendamento feito na visita usa origem `visit` e referencia a visita real. Não se cria uma visita artificial para representar contato por telefone.

Para um agendamento criado offline, a data desejada deve ser posterior ao dia de `requestedAt` no fuso `America/Sao_Paulo`. A validação usa o momento da solicitação preservado na fila, permitindo sincronização depois da data desejada sem apagar ou rejeitar uma solicitação que era futura quando criada. `requestedAt` deve ser válido e não futuro em relação ao servidor. O horário de chegada (`serverSavedAt`) permanece separado para mostrar o atraso, e a sincronização não altera automaticamente o estado `pending`. A migração incremental `20261007114500_scrap_offline_schedule_and_verified_evidence.sql` registra essa regra sem reescrever migrações já aplicadas. Revisar um agendamento é uma nova operação e continua sujeito à validação de data futura no momento da revisão.

O agendamento avulso exige `scrap.schedule_self` e um vínculo ativo em `api.client_seller_scopes`. A busca por nome/código e a gravação do agendamento aplicam a mesma regra, de modo que conhecer o UUID de um cliente não contorna a carteira. Na visita, a cadeia rota → parada → visita continua sendo a fonte de autorização. Clientes sem vínculo explícito falham fechados no fluxo avulso. A importação controlada da base de clientes deve manter esses vínculos sem depender da rota do dia.

### Interfaces e responsabilidades

Os nomes abaixo definem o contrato de domínio; o modelo físico e as políticas SQL são responsabilidade da implementação de dados.

| Interface | Conteúdo mínimo |
| --- | --- |
| `VisitScrapReport` | Identidade da visita, resposta discriminada e vínculo ao evento gerado |
| `ScrapCollection` | Cliente, vendedor/coletor autenticado, visita quando existente, peso real decimal positivo, data/hora da coleta, número manual do recibo, confirmação de assinaturas cliente/vendedor, anexos do termo, destino de custódia e estado |
| `ScrapCustodyDestination` | Tipo `concentration_point` ou `headquarters` (matriz em Natal); referência ao ponto cadastrado quando de concentração; snapshot do nome/endereço do destino informado |
| `ScrapConcentrationPoint` | Identificador estável, nome, endereço e estado ativo/inativo; manutenção autorizada e auditada |
| `PickupSchedule` | Cliente, vendedor solicitante, visita opcional, origem, snapshot do endereço da base, peso estimado, data futura, período `morning`/`afternoon`, observação, data/hora da solicitação e estado |
| `ScrapReceipt` | Coleta do vendedor de origem, destinatário/responsável autenticado, peso efetivamente recebido, local, data/hora do aceite no servidor, observação de divergência quando necessária e vínculo ao encerramento |
| `ScrapAuditEvent` | Identidade do evento, entidade, ação, autor autenticado, origem, horário do servidor, valores anteriores/novos quando aplicável, motivo e chave idempotente |
| `ScrapAttachment` | Identidade offline/canônica, coleta vinculada, finalidade de comprovante do termo de sucata, checksum, tamanho, tipo, captura, verificação, caminho privado e prazo de retenção herdado do ciclo |

Data/hora informada pelo dispositivo e data/hora recebida pelo servidor são preservadas separadamente. O servidor deriva o autor da sessão, verifica acesso ao cliente/visita e não aceita substituir silenciosamente o coletor por um identificador arbitrário enviado pela tela.

O snapshot do endereço conserva onde a coleta foi solicitada mesmo que o cadastro do cliente mude depois. Alterações posteriores da agenda preservam valores originais e atuais, motivo, autor e horário (FR-033). Correções de coleta e recebimento são operações separadas da confirmação inicial e também exigem versão esperada, motivo e identidade autorizada, preservando histórico de antes/depois.

### Estados e encerramento

| Fluxo | Estados/transições |
| --- | --- |
| Coleta do vendedor | `awaiting_receipt` → `received`, exclusivamente por confirmação de usuário de Logística autorizado |
| Agenda da logística | `pending`, visível para acompanhamento; execução/conclusão futura exige definição operacional adicional |
| Sincronização local | Pendente de envio e confirmado no servidor são estados técnicos separados dos estados de custódia/agenda |

Destino informado como matriz não marca a coleta automaticamente como recebida. Enquanto não houver confirmação autenticada da empresa, ela continua pendente. Ponto de concentração significa localização declarada de custódia e não recebimento final pela empresa.

Os pontos são cadastrados no sistema e selecionados na coleta. Inativar um ponto impede novas seleções, mas conserva referências e snapshots das coletas históricas. A matriz em Natal é um destino próprio e não depende de texto livre para identificar o local.

O aceite grava quem recebeu, quando e quanto recebeu. Se houver diferença entre kg declarados pelo vendedor e kg recebidos, preservam-se ambos e registra-se a observação; não se sobrescreve o peso original. O painel distingue kg coletados pelo vendedor, kg recebidos pela empresa, kg sob custódia pendente e kg estimados agendados. Os indicadores representam etapas e não podem ser somados como se fossem volumes independentes.

Estados `confirmed`/`completed` da agenda e regras de SLA continuam fora desta decisão, pois dependem de política operacional adicional (FR-034). Caso a agenda receba alterações/cancelamentos em evolução posterior, FR-033 exige motivo, autor, horário e preservação dos valores originais. Um mesmo recebimento não pode encerrar duas vezes a mesma coleta. Tentativa idempotente repete o resultado; conteúdo divergente com a mesma chave é conflito.

### Ciência e comprovantes

O termo permanece físico, em duas vias, assinado pelo cliente e vendedor. O sistema registra a confirmação dessas assinaturas e exige fotografia do comprovante assinado para o fluxo de coleta realizada. Podem ser anexadas fotografias das vias necessárias para documentar a entrega. Não se presume assinatura eletrônica do cliente: a identidade autenticada do vendedor e as imagens do termo são as evidências deste estágio.

Rascunho e captura funcionam offline. A interface distingue “salvo no aparelho” de “comprovante verificado no servidor”. O aceite da Logística só é concluído com as evidências obrigatórias verificadas, evitando encerrar o ciclo antes de os bytes terem sido persistidos.

O painel de comprovantes apresenta somente anexos com estado `verified`. Reservas e arquivos enviados ainda não verificados não recebem URL de consulta nessa listagem; seus estados continuam disponíveis no acompanhamento da sincronização. A reserva permanece acessível ao vendedor autorizado e ao fluxo de verificação para baixar e conferir os bytes. A migração `20261007114500_scrap_offline_schedule_and_verified_evidence.sql` aplica esse filtro à consulta de evidências, sem remover o acesso necessário à verificação.

Reutiliza-se o protocolo existente de reserva → upload privado → confirmação com checksum, mas a finalidade de sucata possui autorização e retenção próprias. O bucket `scrap-evidence` é privado e separado do bucket de evidências de visita, sujeito ao prazo menor. A confirmação BFF baixa os bytes, confere tamanho, assinatura JPEG/WebP e SHA-256 antes de chamar a função de verificação restrita à credencial `service_role`; token de vendedor sozinho não pode marcar o termo como verificado. A credencial privilegiada é segredo exclusivo do servidor: em produção, deve vir de gerenciador de segredos/variável de ambiente protegida (`CIRNE_SUPABASE_VERIFIER_KEY`), não de `.env.local` nem de bundle cliente. O arquivo fixo `.local/supabase-verifier.json` é apenas fallback local, bloqueado em produção.

### Retenção operacional de cinco anos

Registros de coleta, recebimento, agenda, revisões, auditoria e fotografias de termos de sucata seguem a política operacional de cinco anos. Para a custódia encerrada, o marco mínimo é o último evento relevante, nunca anterior ao recebimento; correções posteriores e verificação tardia de anexo estendem `retention_until` por mais cinco anos, sem reduzi-lo. Coletas e agendamentos pendentes permanecem preservados sem prazo de expurgo calculado; o marco de encerramento da agenda ainda depende do fluxo operacional futuro.

O servidor calcula o marco mínimo de retenção; o cliente não escolhe expiração menor. As migrações bloqueiam exclusão de registros, anexos e objetos no bucket próprio e impedem atualização direta das linhas históricas. **Não há expurgo automático implementado**, nem decisão de que a elegibilidade futura implique exclusão obrigatória. Uma eventual rotina de descarte exigirá desenho e autorização próprios, com trilha de auditoria e respeito a vínculos, revisões e fotografias.

Os guards de banco/Storage não comprovam, por si, conservação ou recuperabilidade dos bytes por cinco anos. Antes do uso produtivo, a Cirne precisa validar a configuração efetiva de backups, retenção de cópias/exportações, teste de restauração, controle de acesso e custos/capacidade: cada termo pode ter de uma a quatro imagens (limite atual de 2 MiB por arquivo), multiplicadas por visitas e pelo período de guarda. Políticas do provedor e custos podem impor limites operacionais; estes pontos devem ser medidos no ambiente de produção, não presumidos a partir dos testes locais.

A política de sucata não altera os 180 dias aprovados para fotografias de fachada. O pedido de cinco anos é uma decisão operacional do produto, a ser incorporada à documentação de privacidade e validada pela Cirne para uso real; não é apresentado como prazo legal universal.

### Acesso e trilha

Vendedor cria e consulta os registros sob seu escopo. Gestor/administrador autorizados consultam o ciclo, mantêm os pontos de concentração e, mediante a capacidade específica `scrap.manage_operations`, corrigem dados de coleta ou recebimento com motivo, versão esperada e histórico de antes/depois. Isso não equivale a confirmar o recebimento inicial: somente o perfil próprio `logistics` com `scrap.receive` pode executar o aceite final, com checagem no BFF e no banco. O perfil foi incorporado aos contratos de identidade, atribuições, sessão e autorização; vendedor e gestor/administrador não recebem `scrap.receive` implicitamente. Um administrador pode atribuir o perfil conforme a manutenção de identidades existente; o autor do aceite permanece o usuário de Logística autenticado.

Fotografias permanecem em Storage privado, acessadas por autorização do servidor e URL assinada de curta duração. Listagens não expõem caminhos públicos. Toda mudança operacional é autorizada no servidor, com acesso negado por padrão e isolamento entre vendedores/escopos gerenciais.

Auditoria e histórico de correções são append-only: sem edição/destruição direta por usuários comuns. Os valores correntes de coleta ou recebimento podem ser corrigidos apenas pelas funções autorizadas, que registram estado anterior e novo, autor, motivo e chave idempotente; não sobrescrevem silenciosamente o fato original. Imutabilidade aqui é controle de aplicação e banco; não implica armazenamento WORM nem garantia contra um administrador de infraestrutura.

### CLI First e apresentação

Primeiro disponibilizar os comandos de domínio para informar sucata na visita, criar/listar agenda independente, cadastrar/listar/inativar pontos de concentração, consultar custódia e confirmar recebimento. CLI e API usam os mesmos contratos, validações, autorização e operações idempotentes. Observabilidade acompanha pendências, falhas de anexos e confirmações. A UI apresenta as mesmas operações, sem concentrar regras exclusivas.

A tela inicial do vendedor oferece Rota e Agendar sucata. A tarefa de sucata na visita apresenta os dois fluxos e a resposta sem sucata. A visão administrativa apresenta agenda futura, custódia pendente, recebimentos encerrados e comprovantes autorizados. A confirmação é uma operação explícita do domínio acionada pelo usuário autenticado, não uma decisão automática de um gráfico/painel.

As consultas operacionais atuais agregam as coletas e agendas visíveis sem um corte arbitrário de 500 registros; um corte silencioso distorceria os totais e esconderia pendências. Essa escolha não é paginação escalável: resposta, renderização e URLs temporárias de evidências precisam ser monitoradas com dados reais. Paginação por cursor, filtros e agregados independentes deverão ser desenhados em evolução posterior, preservando totais completos e escopo de acesso.

## Verificação necessária na Story 3.10

- Roundtrip CLI: coleta com termo → envio/verificação → recebimento administrativo, incluindo repetição idempotente.
- Roundtrip CLI: agendamento dentro e fora de visita permanece pendente e visível, sem criar peso real nem recebimento.
- Validar agendamento offline cuja data desejada já chegou no momento da sincronização, usando o dia de `requestedAt` em São Paulo; preservar chegada ao servidor e testar datas iguais/anteriores, timestamp futuro e replay.
- Consultar comprovantes antes do upload, após upload reservado e após verificação: somente o último estado aparece no painel, mantendo acesso autorizado à reserva para o verificador.
- Negar conclusão de visita sem resposta e negar encerramento de custódia sem termo verificado.
- Negar recebimento por vendedor e acesso a registros/anexos fora do escopo.
- Negar busca e agendamento avulso de cliente fora de `client_seller_scopes`, inclusive quando o chamador conhece seu UUID; permitir o cliente explicitamente atribuído.
- Distinguir aceite inicial exclusivo de `logistics`/`scrap.receive` de correções exclusivas de Gestor/Administração/`scrap.manage_operations`, com motivo, versão, idempotência e histórico antes/depois.
- Preservar pesos originais em divergência e separar indicadores reais/estimados.
- Demonstrar que limpeza de anexos de visita não remove termo de sucata antes da retenção própria, e que o BFF confere os bytes antes da função privilegiada de verificação.
- Validar offline, reconexão, conflito de chave/versão e ausência de duplicação.
- Em produção, verificar segredo do verificador fora de `.env.local`, política de backup/exportação, restauração e capacidade/custo de cinco anos; registrar a ausência de expurgo automático e medir listagens sem paginação.

## Consequências

A coleta não termina no registro feito pelo vendedor: termina no aceite da empresa, com os fatos anteriores preservados e correções auditáveis sem refazer o aceite. Agenda independente deixa de depender da composição da rota. Evidências de sucata exigem armazenamento e retenção próprios; o volume de fotos por cinco anos, backups e restauração precisam de validação operacional antes da produção. Listagens completas evitam omissão por limite fixo, mas podem exigir paginação à medida que crescem. Integração com vendas, saldo financeiro de sucata e geração de termo eletrônico permanecem fora deste fluxo, conforme a fronteira registrada na ADR 002.
