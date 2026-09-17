# Cirne Rotas

Primeira experiência visual do vendedor (Stories 1.1–2.3): login, consulta da rota publicada e reordenação de pendências, com Supabase Auth, permissões/RLS e auditoria. Há também um laboratório separado para IndexedDB e sincronização idempotente. O ambiente local usa exclusivamente dados sintéticos; visita completa e uso offline da rota canônica ainda não estão disponíveis. Desenvolvimento no computador; migração para VPS em incremento futuro, sem publicação automática.

O checkpoint da preparação do host e o resultado da retomada estão em `Docs/RETOMADA_APOS_REINICIO.md`.

## Preparar e executar no Windows

Na raiz do projeto, com Node **24.19.0** e npm **11.17.0**:

```powershell
npm ci
```

Crie `apps/web/.env.local` a partir de `apps/web/.env.example`, **somente se o arquivo local ainda não existir**. Neste computador ele já foi criado com valores sintéticos. Não copie nem altere o `.env` da raiz: pertence às ferramentas existentes.

```dotenv
APP_BASE_URL=http://127.0.0.1:3000
OPERATIONAL_TIME_ZONE=America/Sao_Paulo
LOG_LEVEL=info
SUPABASE_PUBLIC_URL=http://127.0.0.1:54321
SUPABASE_PUBLISHABLE_KEY=replace-with-local-publishable-key
```

`APP_BASE_URL` é obrigatório: origem HTTP(S), sem caminho, credenciais ou parâmetros. `OPERATIONAL_TIME_ZONE` também é obrigatório e aceita um fuso IANA válido; o valor local é explícito e o deploy deve confirmar o fuso operacional, sem depender de UTC ou do relógio do host. `LOG_LEVEL` aceita fatal/error/warn/info/debug/trace/silent. A aplicação recusa configuração inválida na inicialização. O canário não precisa de credenciais Supabase; `/api/v1/me` requer a URL e a chave **publicável** locais. `npm run db:reset` e `npm run identity:provision` atualizam esses dois valores públicos automaticamente e acrescentam o fuso local se estiver ausente, preservando uma configuração explícita existente. O script recusa origem remota e qualquer chave administrativa no arquivo da aplicação. Em automação, injete as variáveis no processo. Nunca use `SECRET_KEY` ou `SERVICE_ROLE_KEY` no web/CLI.

```powershell
npm run dev
```

Acesse `http://127.0.0.1:3000`. Em outro terminal:

```powershell
npm run ops:live -- --url http://127.0.0.1:3000 --json
```

Resultado esperado: `{"status":"ok"}`. Para somente JSON, sem o cabeçalho do npm, use `npm run --silent ops:live -- --json`. Erros retornam código 1; o teste `live` confirma o processo, **não** banco/Auth/Storage. Pare o servidor com `Ctrl+C`.

Para executar o build de produção local (sem containers):

```powershell
npm run build
npm run start
```

`dev` e `start` escutam apenas em loopback. Para outra porta em desenvolvimento, execute `npm run dev --workspace @cirne/web -- --port 3100`. Em produção nativa, defina `$env:PORT = '3100'` antes de `npm run start`. Ajuste também `APP_BASE_URL`. `CIRNE_WEB_PORT` configura a porta do Compose e do doctor, não altera automaticamente o servidor Next nativo. O build copia os assets para o standalone; `start` executa esse artefato e carrega somente o ambiente local da aplicação, sem depender de `next start`.

## Diagnóstico e Supabase local

```powershell
npm run local:doctor
npm run --silent local:doctor -- --json
```

O doctor não instala nada: verifica Node/npm, WSL2 no Windows, Docker em execução, Compose, Supabase CLI e portas. Código 1 indica requisito ausente ou porta ocupada. Execute antes de iniciar serviços; porta ocupada pode ser o próprio serviço já iniciado. Não encerre processos desconhecidos para liberar portas.

Neste computador, em 10/09/2026, o ambiente foi validado com WSL2, Rancher Desktop 1.24.0 usando Moby/dockerd, Docker Engine 29.5.3 e Compose 5.3.1. Kubernetes permanece desativado por não ser necessário. Em uma nova instalação:

1. Instale WSL conforme a [Microsoft](https://learn.microsoft.com/en-us/windows/wsl/install), em PowerShell administrativo, usando `wsl --install`. Salve o trabalho e reinicie quando solicitado.
2. Instale o [Rancher Desktop](https://docs.rancherdesktop.io/getting-started/installation/), selecione **Moby/dockerd** e desative Kubernetes, desnecessário para este projeto. Confira `wsl --list --verbose`, `docker version` e `docker compose version`.
3. Execute novamente o doctor antes de iniciar a stack.

```powershell
npm run db:start
npm run db:stop
```

O projeto `cirne-rotas-dev` usa a rede dedicada `cirne-rotas-dev-loopback`, bridge com binding `127.0.0.1`, conforme o [guia Supabase](https://supabase.com/docs/guides/local-development). Os scripts rejeitam contextos Docker remotos, identidade divergente e rede existente incompatível. Não usam `--all`, `--no-backup`, reset, prune ou credenciais do n8n. Parar preserva volumes e rede; não é backup externo. Usar somente dados sintéticos. A primeira inicialização baixa imagens e pode demorar; a saída do Supabase é omitida porque pode incluir credenciais geradas. O ensaio de 10/09/2026 confirmou portas somente em loopback e preservação de registro sintético após `db:stop`/`db:start`.

Portas em `supabase/config.toml`: API 54321, banco 54322, shadow 54320, Studio 54323 e e-mail de testes 54324. Pooler, edge runtime e analytics estão desabilitados. Não inicie Supabase diretamente sem a rede isolada. Não exponha esta stack à internet.

Para recriar a base, aplicar as migrações, restaurar a rede dedicada e provisionar cinco atores exclusivamente sintéticos:

```powershell
npm run db:reset
npm run db:test
```

Use o wrapper `db:reset`, não `supabase db reset` diretamente: o CLI do Supabase recria temporariamente o banco na rede padrão, e o wrapper confirma a migração antes de restaurar a rede loopback. O provisionamento também pode ser repetido isoladamente com `npm run identity:provision -- --json`; ele é idempotente e não exibe credenciais. E-mails, senhas e sessões aleatórias ficam somente em `.local/identity-actors.json`, que é ignorado pelo Git. Apague esse arquivo apenas se quiser gerar novos atores sintéticos no próximo reset.

## Verificar a identidade pela CLI

Com Supabase e aplicação iniciados, carregue um token sintético no ambiente sem colocá-lo nos argumentos nem imprimi-lo:

```powershell
$actors = Get-Content .local/identity-actors.json | ConvertFrom-Json
$env:CIRNE_ACCESS_TOKEN = $actors.actors.seller_a.accessToken
npm run --silent ops:identity -- --url http://127.0.0.1:3000 --json
Remove-Item Env:CIRNE_ACCESS_TOKEN
```

O resultado contém somente `id`, nome, papéis, capacidades, escopos e status. Também é possível fornecer o token por stdin, sem combiná-lo com a variável de ambiente. Vendedor A vê apenas seu próprio escopo; o Gestor A recebe somente o escopo do Vendedor A; o ator `blocked` é negado. Tokens ausentes, inválidos ou bloqueados retornam código diferente de zero sem revelar credenciais ou detalhes de conta. Esses atores existem apenas para desenvolvimento e testes locais.

## Verificar o núcleo offline

A interface técnica anterior está em `/demo/offline`. Ela não representa a rota autenticada do vendedor. O fallback de `/route` pede reconexão; não reutiliza os dados fictícios desse laboratório.

O diagnóstico CLI valida contratos, conteúdo sintético e os estados locais permitidos, sem abrir navegador nem afirmar sincronização com servidor:

```powershell
npm run --silent ops:offline -- --json
```

Resultado esperado: `status: "ok"` e `syntheticOnly: true`. Esse diagnóstico inspeciona a fundação local; a prova de sincronização servidor é o comando abaixo.

## Verificar a sincronização pela CLI

Com Supabase e aplicação iniciados, use o mesmo token sintético de `seller_a` por ambiente ou stdin:

```powershell
$actors = Get-Content .local/identity-actors.json | ConvertFrom-Json
$env:CIRNE_ACCESS_TOKEN = $actors.actors.seller_a.accessToken
npm run --silent ops:sync -- --url http://127.0.0.1:3000 --json
Remove-Item Env:CIRNE_ACCESS_TOKEN
```

O comando envia somente IDs e conteúdo sintéticos e comprova três passos: primeira confirmação, repetição com a mesma resposta canônica sem duplicidade e rejeição da mesma chave com conteúdo divergente. A saída esperada é `{"status":"ok","checks":{"firstConfirmation":true,"replayMatched":true,"divergentRejected":true}}`. Token, IDs do evento e payload não aparecem na saída; falha retorna código 1.

## Verificar a rota canônica sintética pela CLI

Com Supabase e aplicação iniciados, carregue os tokens sintéticos do Gestor A e do Vendedor A no ambiente. O comando cria ou reutiliza a rota publicada do dia, reordena as paradas pendentes por ordem planejada decrescente e confirma a leitura canônica do Vendedor:

```powershell
$actors = Get-Content .local/identity-actors.json | ConvertFrom-Json
$env:CIRNE_MANAGER_ACCESS_TOKEN = $actors.actors.manager_a.accessToken
$env:CIRNE_SELLER_ACCESS_TOKEN = $actors.actors.seller_a.accessToken
npm run --silent ops:routes -- --url http://127.0.0.1:3000 --json
Remove-Item Env:CIRNE_MANAGER_ACCESS_TOKEN
Remove-Item Env:CIRNE_SELLER_ACCESS_TOKEN
```

A saída contém o ID e a versão publicada da rota, `executionVersion`, status, quantidade de paradas e os checks do round-trip. `checks.reordered` informa `applied` quando houve mudança ou `already_canonical` na repetição, sem novo incremento nem auditoria. `created` e `published` confirmam que o agregado existe e está publicado, inclusive quando reutilizado. Tokens e snapshots de cliente não são exibidos. O diagnóstico usa exclusivamente os dois clientes sintéticos provisionados pelo reset local; não use dados reais. Como alternativa, forneça os dois tokens em um único JSON por stdin, sem combiná-los com as variáveis de ambiente.

As leituras canônicas usam `schemaVersion: 2`. A reordenação usa `PUT /api/v1/routes/{routeId}/execution-order`, com `schemaVersion: 1`, `expectedVersion` do agregado e `pendingStopIds` contendo exatamente todas as paradas pendentes na ordem desejada. A composição publicada e `plannedOrder` permanecem imutáveis; conflito de versão retorna `409`. Para verificar rollback/reaplicação sem persistir mudanças no banco local, execute `node --import tsx scripts/verify-route-execution-rollback.ts` após `db:reset` e novamente após a integração.

Para a prova no navegador, gere o build de produção e execute o Playwright:

```powershell
npm run test:e2e:build
```

O teste instala o Service Worker, confirma sua revisão, carrega uma rota sintética, grava rascunho e outbox atomicamente e reabre o shell por hard refresh sem rede. Também valida migração do IndexedDB, isolamento dos dados em cache e recuperação após falha de quota. O navegador pode recusar persistência reforçada; isso é exibido como “não garantida” e não transforma o commit local em sincronização.

## Primeira visualização do MVP

1. Com Supabase local ativo, execute `npm run identity:provision -- --json`.
2. Inicie o aplicativo (`npm run build` e depois `npm run start`, ou `npm run dev`).
3. Execute o diagnóstico `ops:routes` acima para publicar/reutilizar a rota sintética do dia.
4. Abra `http://127.0.0.1:3000/login`. Use o e-mail e a senha de `actors.seller_a` no arquivo local ignorado `.local/identity-actors.json`; não copie credenciais para documentação, Git ou capturas.
5. Em `/route`, escolha **Reordenar**, use as setas e **Salvar ordem**. **Cancelar** descarta o rascunho visual. Um conflito exige **Recarregar rota**. **Sair** encerra a sessão deste navegador.

Login e operações exigem conexão. A sessão usa cookies HttpOnly/SameSite, sem tokens em localStorage. Origem e cabeçalho CSRF são obrigatórios em login, logout e mutações por cookie. `APP_BASE_URL` precisa corresponder exatamente à origem usada no navegador (prefira `127.0.0.1`, não alterne com `localhost`). HTTPS habilita `Secure` nos cookies. A recuperação de senha orienta contato com administrador: não há SMTP implementado nesta etapa.

A rota exibida vem do servidor, inclusive data operacional, estado das paradas e progresso. Esta entrega não inclui registrar visitas, abrir mapas ou painel gerencial. No celular, a mesma tela é responsiva; o servidor local continua restrito ao próprio computador, sem exposição na rede.

`npm run test:e2e` valida os estados de interface com respostas controladas e a regressão offline, sem exigir banco. Depois de `npm run test:integration` (que provisiona/publica a rota sintética), execute `npm run test:e2e:real` para provar login → rota → reordenação → reload → logout no navegador contra Supabase local. Esse ensaio usa apenas `seller_a`, altera sua ordem sintética e desativa traces para não guardar credenciais.

## Quality gates

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:integration
```

`typecheck` gera os tipos de rotas antes do TypeScript, inclusive em checkout limpo. Unitários cobrem contratos, autenticação, configuração/redaction, CLIs, IndexedDB, motor de sincronização, manifesto sintético, versões/portas e proteção dos comandos de infraestrutura. A integração provisiona atores, executa a suíte pgTAP e inicia/encerra seu próprio servidor de produção em porta livre; valida HTTP, RLS, isolamento, bloqueio, concorrência e CLIs como processos reais. Depende do Supabase local, mas não de internet. Rode `build` antes da integração.

CI em `.github/workflows/ci.yaml`: gates, navegador offline, integração e smoke da imagem com Actions por SHA, permissão de leitura, sem deploy. O remoto existe, mas nenhuma publicação desta story é automática. Evidências concluídas ficam em `Docs/qa/`.

## Imagem de produção local

Depois de instalar o runtime, pare o Next nativo ou escolha outra porta:

```powershell
$env:CIRNE_WEB_PORT = '3100'
docker compose -f infrastructure/compose/compose.local.yaml up --build --wait
npm run ops:live -- --url http://127.0.0.1:3100 --json
docker compose -f infrastructure/compose/compose.local.yaml exec -T web id
docker compose -f infrastructure/compose/compose.local.yaml down
```

A definição usa runtime não-root, standalone, assets, filesystem somente leitura, cache temporário e porta loopback. Não monta socket Docker ou dados de negócio. `.dockerignore` usa allowlist e exclui `.env` de qualquer diretório; `.gitignore` também protege ambientes locais. O `down` acima atua apenas na aplicação, não remove volumes Supabase. O build/smoke real foi validado em 10/09/2026 na porta 3100, incluindo health check, UID/GID 1000, raiz somente leitura, cache gravável e ausência do socket Docker.

## Versões efetivas e organização

Versões verificadas no registro npm e instaladas a partir do lockfile em 09–10/09/2026:

| Componente | Versão |
| --- | --- |
| Node / npm | 24.19.0 / 11.17.0 |
| Next.js / React / React DOM | 16.3.4 / 19.3.0 / 19.3.0 |
| TypeScript / typescript-eslint / ESLint | 6.0.3 / 8.70.0 / 10.10.0 |
| Zod / Pino | 4.5.4 / 10.3.1 |
| Supabase JS / Supabase SSR | 2.116.0 / 0.12.7 |
| Vitest / tsx | 5.0.0 / 4.23.13 |
| Dexie / fake-indexeddb | 4.4.5 / 6.2.5 |
| Serwist / Playwright | 9.5.12 / 1.63.0 |
| Supabase CLI | 2.117.0 |
| Tipos Node / React / React DOM | 24.13.4 / 19.3.0 / 19.3.0 |

Divergências justificadas da arquitetura: TypeScript 7.0.2 não é aceito pelo peer de typescript-eslint 8.70.0 (`<6.1.0`); usamos 6.0.3, sem `--force`/`--legacy-peer-deps`. React 19.3.0 foi a versão verificada e compatível com Next. Não foram instaladas dependências de funcionalidades futuras. TypeScript usa Apache-2.0; os demais pacotes diretos listados usam MIT. Registre nova auditoria com `npm audit` ao atualizar o lockfile. Auditoria npm não garante ausência de todas as vulnerabilidades.

No npm 11.17.0, `npm ci` pode avisar que o postinstall de esbuild não tem política `allowScripts` explícita. Não foi feita aprovação global nem instalação forçada; build e testes foram executados com a instalação resultante. Reavalie scripts de instalação antes de aprová-los em futuras atualizações.

`apps/cli` consome os contratos de `packages/contracts`; `apps/web` expõe `/api/v1/health/live`, `/api/v1/me`, `POST /api/v1/sync/batches` e os endpoints autenticados de criação, publicação e leitura de rotas. `packages/config/public` contém somente identificação pública; `/server` valida configurações e não é importável em componentes pela regra de lint. Logs de aplicação usam JSON, ID de correlação próprio e allowlist: rota-modelo, método, status e duração; não registrar URL bruta, token, cookie, e-mail, GPS ou corpo. Mensagens internas do Next podem usar formato próprio.

`scripts/` contém infraestrutura local; `supabase/` sua configuração; `infrastructure/` contém Docker/Compose; `Docs/` mantém PRD/arquitetura monolíticos, stories e evidências. O repositório Git usa o remoto `origin` com a conta dedicada do projeto; push e publicação continuam operações explícitas de `@devops`. Preserve os arquivos existentes das ferramentas AIOX.
