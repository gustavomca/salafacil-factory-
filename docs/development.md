# Desenvolvimento

A execução oficial é Docker Compose. Os locks e Dockerfiles fixam versões e
digests: Python 3.12/Django 5.2, PostgreSQL 17, Node 22, React 19 e TypeScript 6.
TypeScript 6.0.3 foi resolvido dentro da stack aprovada porque typescript-eslint
8.71.0 ainda exige TypeScript <6.1; não foram usadas instalações forçadas.

`backend/` separa contas/sessões, salas, reservas, auditoria e infraestrutura HTTP.
`frontend/src/` contém rotas, API tipada, relógio estimado do servidor, conversão
explícita de fuso e componentes. `tests/e2e/` verifica a aplicação real;
`tests/operations/` reproduz persistência, restauração e TLS.

```bash
bash scripts/test-backend.sh  # PostgreSQL real, migrations e Ruff
bash scripts/test-frontend.sh # ESLint, TypeScript, Vitest e build
bash scripts/test-e2e.sh      # Chromium desktop/mobile em Xvfb + axe
bash scripts/test-operations.sh
```

Cada script usa projeto e IMAGE_TAG próprios, preservando as tags da demo.
Os testes integrados oficiais são verificados em Linux/rootful; probes Python
rodam em containers, e a reprodução de checkout requer Git no host.

O runner E2E usa Chromium com janela em Xvfb, já presente na imagem fixada.
O cenário entre abas desativa a emulação de foco do Playwright por CDP e exige
eventos nativos de foco; não sintetiza eventos DOM nem respostas de identidade.
O processo init do container recolhe os processos filhos do servidor gráfico.

Os testes de backend usam banco descartável e uma role sem superuser, com
CREATEDB somente no perfil test para o banco de testes Django. O runtime local e
production usam NOCREATEDB. A rede Docker `app` é interna; o frontend-test usa
`network_mode: none`. Os downloads ocorrem no build, antes das verificações.

Os contratos HTTP e de segurança estão em [api.md](api.md) e [security.md](security.md);
o escopo e os limites públicos estão no README. APIs não aceitam
campos desconhecidos e não usam barra final. Uma mudança deve preservar os testes
negativos de autorização, limites de tempo/capacidade e concorrência PostgreSQL.

Para trabalho rápido no frontend, `cd frontend && npm ci --ignore-scripts`,
`npm run typecheck`, `npm run lint`, `npm test` e `npm run build` usam os mesmos
locks do container. O servidor Vite sozinho não representa a integração oficial.
Não substitua a API/DB por mocks para comprovar fluxos de produto.

Não versionar `.env`, cookies, dumps, chaves TLS, node_modules, dist ou volumes.
Evidências locais derivadas ficam sob `.factory/`, ignoradas por este repositório.
Um teste antigo não comprova uma árvore alterada. Execute os cinco scripts de
[verification.md](verification.md); o CI usa os mesmos comandos e não precisa da Factory privada.
