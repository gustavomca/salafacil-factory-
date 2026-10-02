# Verificação reproduzível

Os cinco comandos do README verificam a cópia do produto diretamente, sem ler a
Factory privada. Requisitos: Bash, Git para reprodução e Docker Engine rootful
Linux com Compose >= 2.24.4. Builds baixam pacotes/imagens; as suítes verificam
aplicação/banco reais e testes isolados de UI conforme a categoria identificada.

| Script | Verificação |
|---|---|
| test-backend.sh | Django + PostgreSQL, autorização/concorrência/auditoria, migrations e Ruff |
| test-frontend.sh | ESLint, TypeScript, Vitest e build Vite |
| test-e2e.sh | Chromium headed/Xvfb desktop/mobile, jornadas e negativos, axe/foco |
| test-operations.sh | Setup, migrations, seed, restart, backup/restore sintético, TLS, CSRF, proxy/socket |
| test-reproduce.sh | README em clone limpo, health/HTML/CSRF/migrations/seed |

Cada execução cria seus containers, volumes e tags descartáveis e faz sua própria
limpeza. Rodar manualmente em sequência evita disputar portas. E2E usa 18081,
operações usam 18082 e 8443, reprodução usa 18084. `TEST_WEB_PORT` permite alterar
a porta da suíte pertinente; não lance duas instâncias da mesma suíte juntas.

Artefatos locais ficam em `.factory/`, inteiramente ignorada pelo Git. Não publicar
logs ou traces sem revisar dados; cookies, backups e certificados privados não
pertencem ao repositório. O CI roda cada script em runner separado com a fonte
do evento e sem segredos do produto. O status remoto só é válido para seu SHA.

Os resultados da fonte original exportada estão em
[release-evidence/verification.json](release-evidence/verification.json).
Eles não devem ser atribuídos automaticamente a uma revisão posterior ou ao CI
remoto. A revisão independente textual, seus achados e o registro humano de aceite
são retidos privadamente; este documento não concede aceite nem certificação.

O CI chama `python3 scripts/verify-check.py CHECK` (CHECK é backend, frontend,
e2e, operations ou reproduce). Além do exit code, exige os marcadores completos,
contagens exatas 59/78/44 e nenhuma suíte omitida. E2E exige um JSON novo com
44 expected e zero skipped/unexpected/flaky. O guard é verificado com casos
negativos em `tests/verification/`. Python 3 é necessário para esse wrapper.
