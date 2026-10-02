# QA integrado do SalaFácil

Suíte Playwright 1.63.0 contra uma stack Docker descartável com PostgreSQL real.
Não inicia serviços, redefine banco, troca limites de segurança ou usa reservas de
seed como expectativa. Contas públicas de demonstração são somente locais. Cada
sala/título de teste recebe sufixo aleatório; use volume próprio da stack QA.

Na raiz do repositório, o caminho oficial cria, verifica e remove somente a
stack descartável da execução; requer Docker Compose e não requer Node no host:

```sh
bash scripts/test-e2e.sh
```

Para desenvolvimento nativo, prepare uma stack QA própria e as dependências
do Chromium e do Xvfb no host Linux. A URL abaixo é apenas exemplo da porta
publicada dessa stack; não execute a suíte contra uma instalação com dados reais.

```sh
cd tests/e2e
npm ci --ignore-scripts
npx playwright install chromium
BASE_URL=http://127.0.0.1:18081 xvfb-run -a npm test -- --headed
```

O primeiro comando de instalação e o download do browser podem usar rede. Os
fluxos, após a stack/imagem pronta, usam apenas a aplicação local. O runner
Docker já contém Xvfb e usa `init: true` para recolher os processos filhos.
O cenário entre abas requer Chromium com janela: headless não reproduz seus
eventos nativos de foco. Nesse caso, o teste desativa a emulação de foco do
Playwright via CDP e exige `blur`/`focus` com `isTrusted=true`.

`BASE_URL` é obrigatório. `E2E_RUN_ID` é opcional e deve identificar uma execução
nova; não reutilize o mesmo valor. Screenshots, traces, vídeos, relatório HTML e
JSON vão exclusivamente para `.factory/artifacts/e2e/<run>/`. Não há retries nem
skips automáticos: falhas permanecem no relatório original.

- `xvfb-run -a npm test -- --headed`: desktop 1440×1000 e celular 390×844, fuso America/Sao_Paulo.
- `xvfb-run -a npm run test:desktop -- --headed` ou `xvfb-run -a npm run test:mobile -- --headed`: uma viewport.
- `xvfb-run -a npm run test:integrated -- --headed`: exclui apenas os testes explicitamente `@injected`; não substitui a suíte completa exigida pelo gate.
- `npm run typecheck`: valida os tipos da suíte sem iniciar browser.

Dados de arranjo são criados por login + token CSRF reais, em sessão independente
do browser. Os testes de fluxo interagem com controles rotulados por papel/nome.
Quando uma API escreve em paralelo ao formulário, trata-se de disputa real no
backend, não resposta simulada. Os casos `@injected` identificam as perturbações
de transporte:

- GET real do catálogo pausado para observar carregamento e, depois, resposta de
  POST abortada somente após `route.fetch()` concluir o commit real.
- Resposta JSON 503 substituindo a resposta após commit real de reserva, sala
  ou cancelamento, para exigir reconciliação sem reenvio automático.
- GET real `/session/me` pausado durante troca de conta entre abas e continuado
  sem alterar identidade ou payload, para observar o bloqueio pendente.
- Falha única de transporte em GET `/session/me`, com cada tipo de diálogo
  aberto ou com o formulário inline, para verificar fechamento por clique/toque,
  preservação de campos e recuperação explícita antes de qualquer mutação de
  negócio. No formulário, a recuperação usa Tab/Enter e verifica o retorno de foco.

Esses cenários não são apresentados como falhas espontâneas do servidor.
O mesmo fluxo inline também verifica o retorno passivo à aba, com resposta real
de sessão sem perturbação de transporte, preservando foco no corpo e rolagem.

Axe cobre WCAG A/AA automatizável; teclado/foco de diálogo e limites horizontais
são assertions separadas. Capturas apoiam a inspeção visual contra a direção B,
mas esta suíte não concede aprovação visual, O4/O5 ou aceite humano H4.

A limitação de login é real. A suíte usa workers=1 e reaproveita as sessões de
arranjo por worker, sem mascarar 429. Após repetidas execuções, recrie somente a
stack QA descartável ou use o comando operacional de desbloqueio documentado;
nunca desative o limitador para obter resultado verde.

Regressões O4 incluem 503 JSON após commit real (explicitamente `@injected`),
expiração por logout HTTP real com CSRF (sem troca de foco), retenção de drafts
por dono e intenção da URL, troca de conta por logout/login real em outra aba,
estado concorrente,
foco após sucesso sem reparo artificial pelo teste, contadores visíveis em
360/390/768/1024/1440 px e histórico de URL. DST usa contexto IANA New York com
dobra/lacuna futuras descobertas do relógio real da API e dia da agenda escolhido
pela UI; não altera relógio/payload do servidor e não aceita reservas passadas.
O teste DST cancela somente suas reservas ao encerrar, preservando histórico.
