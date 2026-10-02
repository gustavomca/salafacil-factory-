# Frontend SalaFácil

React/TypeScript/Vite, direção B — Agenda. API `/api` na mesma origem, com sessão por cookie e CSRF somente em memória. Fontes são a pilha local Arial/Segoe UI/sans-serif; nenhum recurso de CDN. O CSS é compilado em arquivo externo, compatível com CSP `style-src 'self'`.

`npm ci`, `npm run build`, `npm run typecheck`, `npm run lint` e `npm test` são os comandos de verificação. `npm run dev` inicia o Vite e usa o proxy local `/api` para `127.0.0.1:8000`; a entrega oficial é o build servido pelo Nginx da stack integrada.

## Dependências

React 19.3.0 e Vite 8.3.2 seguem a baseline. TypeScript foi fixado em 6.0.3 após a resolução real recusar TypeScript 7.0.2: typescript-eslint 8.71.0 declara peer `>=4.8.4 <6.1.0`. Nenhum `force` ou `legacy-peer-deps` foi usado. O lockfile é obrigatório.

## Verificação

Vitest/Testing Library cobrem estados de UI e API isolados; axe verifica semântica de formulários. Esses testes não demonstram autenticação, banco, disponibilidade ou concorrência integrados. A suíte Playwright em `tests/e2e` e a inspeção desktop/mobile da aplicação real são de integração/QA.
