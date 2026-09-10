# Checkpoint de retomada — WSL2, Rancher Desktop e Story 1.1

Salvo em 10/09/2026 antes da preparação do ambiente de containers e atualizado depois da retomada. Este arquivo registra o checkpoint e seu resultado.

## Resultado da retomada em 10/09/2026

- Ubuntu e `rancher-desktop` confirmados em WSL2.
- Rancher Desktop 1.24.0 iniciado com Moby/dockerd e Kubernetes desativado; Docker Engine 29.5.3 e Compose 5.3.1 operacionais.
- PATH do usuário atualizado com o diretório de CLI do Rancher Desktop; abra um novo PowerShell para herdá-lo.
- `npm run local:doctor` passou em todos os requisitos antes da inicialização dos serviços.
- Supabase iniciou na rede dedicada e publicou portas somente em `127.0.0.1`. Um registro sintético persistiu após `db:stop`/`db:start` e a tabela de prova foi removida.
- A imagem da aplicação foi construída e validada em `127.0.0.1:3100`: health OK, UID/GID 1000, raiz somente leitura, cache temporário gravável, sem socket Docker e sem privilégios.
- Compose da aplicação e Supabase foram encerrados ao final. Os dois volumes Supabase e a rede dedicada permanecem preservados.
- Gates finais repetidos com sucesso: lint, typecheck, 20 testes unitários, build e 4 testes de integração.
- Revisão arquitetural interna concluída com PASS. Próximo ponto: preparar um commit-base seguro, instalar/autenticar o CodeRabbit no WSL e executar o gate formal de QA; sem push ou deploy.

## Estado original antes da retomada

- Story ativa: `Docs/stories/1.1.story.md`, status **InProgress**.
- Aplicação Next.js, endpoint de saúde, CLI, configuração, logs, diagnóstico, scripts do Supabase, Dockerfile, Compose e CI já estão implementados.
- Verificações concluídas: `npm ci`, lint, typecheck, 19 testes unitários, build standalone, 4 testes de integração, smoke em desenvolvimento e smoke do standalone.
- Node 24.19.0, npm 11.17.0 e Supabase CLI 2.117.0 estão funcionando.
- Pendências atuais: instalar WSL2 e Rancher Desktop, validar o Supabase em containers, persistência, bindings loopback, imagem Docker e revisão final.
- O repositório Git local existe, mas ainda não há commit, remoto, push ou deploy. Os arquivos persistem normalmente após reiniciar.
- Arquivos `.env` existentes foram preservados e estão ignorados pelo Git e pelo contexto Docker.

Evidências detalhadas: `Docs/qa/1.1-implementation-evidence.md`.

## Etapa 1 — antes de reiniciar

Salve outros trabalhos abertos. Abra **PowerShell como Administrador** e execute:

```powershell
wsl --install
```

O comando habilita WSL/Virtual Machine Platform, instala o kernel e o Ubuntu padrão. Reinicie o Windows quando solicitado. Não execute comandos destrutivos nem apague distribuições WSL existentes.

Se o comando apenas mostrar ajuda ou falhar no download, não improvise mudanças de BIOS/DISM. Anote a mensagem e retome comigo para diagnóstico.

## Etapa 2 — logo após reiniciar

Na primeira abertura do Ubuntu, aguarde a preparação e crie um usuário e uma senha Linux. Eles não precisam ser iguais às credenciais do Windows.

Depois, abra PowerShell normal e execute:

```powershell
wsl --update
wsl --set-default-version 2
wsl --list --verbose
wsl --status
```

O Ubuntu deve aparecer com versão `2`. O computador já detectava um hipervisor antes do checkpoint; não alterar BIOS salvo se os comandos acima apresentarem erro específico de virtualização.

## Etapa 3 — instalar e configurar Rancher Desktop

No PowerShell normal:

```powershell
winget install --exact --id SUSE.RancherDesktop --accept-package-agreements --accept-source-agreements
```

Pacote verificado no checkpoint: `SUSE.RancherDesktop` 1.24.0, fornecedor SUSE. Não instalar a opção `SUSE.RancherDesktop.2`, que era alpha.

Abra o Rancher Desktop e configure:

1. Container Engine: **Moby/dockerd**.
2. Kubernetes: **desativado**.
3. Exposição de serviços: somente `127.0.0.1`.
4. Se houver opção de serviço privilegiado para exposição em todas as interfaces, ele não é necessário neste ambiente restrito a loopback.
5. Aguarde a interface indicar que o runtime está pronto.

## Etapa 4 — verificação para retomar comigo

Abra um novo PowerShell:

```powershell
cd C:\Projetos\Cirne_Rotas
wsl --list --verbose
docker version
docker compose version
npm run local:doctor
```

Não execute `db:start` se o doctor ainda reportar WSL2, Docker ou Compose ausente. Não encerre processos desconhecidos para liberar portas.

Quando os requisitos aparecerem como `OK`, a próxima execução técnica será:

```powershell
npm run db:start
```

O agente deve então:

1. Confirmar rede `cirne-rotas-dev-loopback` com binding `127.0.0.1` e label do projeto.
2. Confirmar que as portas Supabase estão somente em loopback.
3. Criar um dado estritamente sintético para ensaio, parar e reiniciar a stack e confirmar persistência.
4. Executar `npm run db:stop` preservando volumes.
5. Construir e iniciar `infrastructure/compose/compose.local.yaml` em porta livre.
6. Validar usuário não-root, filesystem somente leitura, ausência de socket Docker e canário pela CLI.
7. Encerrar o Compose da aplicação sem apagar dados Supabase.
8. Repetir lint, typecheck, testes e build; registrar evidências e encaminhar revisão arquitetural/QA.

## Mensagem de retomada

Depois do reinício e das etapas acima, envie:

> Retome a Story 1.1 pelo arquivo `Docs/RETOMADA_APOS_REINICIO.md`. Já executei as etapas de WSL2 e Rancher Desktop; pode conferir o ambiente e prosseguir com autonomia.

Se algum comando falhar, envie a mesma mensagem acrescentando qual comando falhou. Não inclua senhas, tokens nem o conteúdo de arquivos `.env`.

## Referências oficiais

- Microsoft WSL: https://learn.microsoft.com/windows/wsl/install
- Comandos WSL: https://learn.microsoft.com/windows/wsl/basic-commands
- Rancher Desktop: https://docs.rancherdesktop.io/getting-started/installation/
- Supabase local: https://supabase.com/docs/guides/local-development
