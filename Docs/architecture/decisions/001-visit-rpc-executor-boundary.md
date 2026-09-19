# ADR 001 — fronteira dos executores RPC de visita

Data: 2026-09-18. Estado: aceito no recorte local das Stories 3.1–3.2, após revisão Aria/Codex. Não autoriza piloto ou implantação.

## Contexto

O desenho inicial de `Docs/architecture.md` §9.12 usa wrapper invoker, USAGE privado para authenticated e executor separado do owner das tabelas. A implementação existente das capabilities utiliza wrappers definer e roles executoras que também possuem suas tabelas. É necessário registrar a variante efetiva e suas provas, sem presumir a RLS do chamador.

## Decisão

Manter os wrappers estreitos `api.start_visit`, `api.save_visit_stock` e `api.sync_event` como SECURITY DEFINER com search_path vazio. `anon`/`authenticated` continuam sem USAGE em `private` e sem DML direto. Somente authenticated executa os wrappers públicos; helpers possuem grants explícitos entre executores.

Executores são NOLOGIN/NOSUPERUSER/NOBYPASSRLS. Suas tabelas de capability em `api` usam FORCE RLS e políticas específicas. As funções derivam a identidade do JWT e validam perfil ativo, papel/capacidade e ownership em toda chamada, incluindo replay. O papel executor não é a identidade do vendedor.

## Consequências e limites

- Reduz a superfície privada acessível ao usuário, mas torna indispensável a autorização explícita das funções.
- Uma regressão em grants, ownership ou validação pode ampliar acesso; mudanças exigem repetir testes negativos da Data API/RPC e inspeção do catálogo.
- Tabelas internas de auditoria/idempotência permanecem protegidas por schema/ACL, não por uma afirmação genérica de RLS em todo o banco.
- Não se introduz service role no fluxo normal, nem se declara equivalência automática com o desenho inicial.

## Evidência

`Docs/qa/evidence/3.1-3.2-specialized-review.md`, `supabase/tests/visit_start.test.sql`, `supabase/tests/visit_stock.test.sql`, `tests/integration/health.test.ts` e as migrações incrementais de ACL/contrato/replay de 18/09/2026.
