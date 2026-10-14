# ADR 002 — evidência de visita, estoque ponderado e fronteira do saldo de sucata

Data: 2026-10-01. Estado: aceito em 2026-10-02, com publicação real ainda condicionada aos controles de privacidade e Storage privado.

## Contexto

O solicitante determinou que cada loja tenha fotografia de fachada e um ponto GPS no início e no encerramento da visita. Também forneceu uma nova versão de `Docs/Base produtos Clarios.xlsx`, com atributos adicionais e peso unitário, para calcular o peso do estoque próprio observado no cliente. No futuro, esse dado deverá apoiar a conciliação do saldo de sucata com os débitos originados pelo sistema de vendas.

## Requisitos confirmados

- Ao tocar em **Iniciar visita**, capturar uma fotografia da fachada e um ponto GPS com horário e precisão.
- Ao **encerrar a visita**, repetir a fotografia da fachada e o ponto GPS.
- A coleta é pontual; não existe rastreamento contínuo entre entrada e saída.
- Calcular o peso do estoque próprio por linha, por marca e no total do cliente.
- Quando um produto não possuir peso válido, usar provisoriamente **15 kg por unidade** e criar um alerta explícito para correção pelo Gestor.
- Preservar o peso unitário e a versão do catálogo usados na visita para que uma atualização posterior da base não reescreva o histórico.
- Preparar uma ferramenta de manutenção do catálogo para o perfil Gestor, com validação, prévia das diferenças, publicação versionada e auditoria.
- Registrar como requisito futuro uma ferramenta de saldo de sucata do cliente.

## Inspeção da base Clarios de 2026-10-01

- 156 linhas de produto: 109 Heliar, 19 América, 6 Durex/Strada e 22 ACDelco.
- Colunas disponíveis: código de fábrica, categoria, descrição, item original, SKU/base, marca, tecnologia, amperagem, CCA, voltagem, polo, peso, dimensões, preço médio e aplicações.
- Todos os 156 registros atuais possuem peso numérico, entre 1,8 kg e 57,4 kg.
- Os modelos `H75LD 18-530` e `H90LE 18-710` aparecem com pesos diferentes. Portanto, o identificador do produto não pode ser apenas marca + nome do modelo; a importação e a coleta devem usar código de fábrica/SKU e conservar a descrição para exibição.

## Decisão arquitetural proposta

### Evidência de entrada e saída

Cada evento terá tipo `start` ou `completion`, fotografia privada, coordenadas, precisão, distância calculada contra a coordenada versionada do cliente, horário do aparelho, horário do servidor e eventual justificativa. GPS ausente, impreciso ou fora do raio gera exceção revisável, nunca acusação automática. Clientes sem coordenadas recebem sinalização própria, pois não é possível calcular distância confiável.

A fotografia deve ser capturada diretamente pela câmera traseira do dispositivo quando suportada. O fluxo não oferece seleção de arquivo ou galeria. O raio operacional é 100 m e a precisão desejada é de até 50 m. Falhas de câmera/GPS e medições fora desses limites podem prosseguir somente com justificativa e revisão gerencial. A retenção aprovada é de 180 dias.

### Catálogo e cálculo do estoque

O catálogo de produtos passa a ser versionado por item estável. Cada linha de estoque referencia o item publicado e grava um snapshot mínimo com peso unitário, fonte do peso (`catalog` ou `fallback_15kg`) e versão. O total é calculado com decimal exato:

`peso da linha = quantidade × peso unitário`

Somam-se as linhas para obter total por marca e total geral das marcas próprias. O fallback de 15 kg mantém a coleta utilizável, mas produz alerta de qualidade associado ao item e à visita até o Gestor corrigir e publicar uma nova versão. A correção não altera visitas históricas.

### Atualização pelo Gestor

Seguir `CLI First`: primeiro criar comando de validação/importação/publicação da planilha; depois expor a mesma operação em tela gerencial. O fluxo deve gerar lote auditável, validar cabeçalhos, identificadores, duplicidades, pesos e tipos, mostrar inclusões/alterações/rejeições e exigir confirmação antes de ativar a versão. A planilha nunca atualiza silenciosamente um catálogo já publicado.

### Fronteira com o saldo de sucata

O peso de estoque observado não é sucata coletada nem deve lançar automaticamente um crédito/débito no razão. Ele é um fato de conciliação: representa baterias ainda disponíveis no cliente. A ferramenta futura de saldo deverá manter eventos separados, no mínimo venda/débito, coleta/crédito, ajuste autorizado e observação de estoque, conciliando-os sem transformar uma fotografia de estoque em movimentação contábil.

## Decisões fechadas em 2026-10-02

1. Raio aceito: 100 m; precisão desejada: até 50 m.
2. Câmera/GPS negados ou indisponíveis: permitir somente com justificativa e sinalização para revisão.
3. Retenção das evidências: 180 dias; acesso restrito ao vendedor proprietário e aos gestores autorizados.
4. A interface de fachada não permite galeria ou upload de foto existente; captura somente pela câmera.

## Decisões futuras

4. Fonte, frequência e chave de idempotência da integração futura com vendas.
5. Semântica inicial do saldo de sucata, inclusive ajustes, migração do saldo de abertura e responsável por aprová-los.

## Consequências

- Evidências de entrada/saída e catálogo ponderado devem ser stories separadas para reduzir risco e permitir testes offline específicos.
- A conclusão da visita precisa existir antes de exigir a evidência de saída.
- O cálculo de peso pode ser entregue antes da integração com vendas e antes do razão de sucata.
- Dados reais de fotografia e localização permanecem bloqueados até a política de privacidade, retenção e acesso ser aprovada.
