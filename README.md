# SalaFácil

Agenda de salas para um pequeno escritório, com interface em português na direção
**B — Agenda**. Django/DRF, React/TypeScript e PostgreSQL. A direção visual e a
publicação em repositório separado foram aprovadas pelo proprietário. Esta cópia
mantém o runtime e os testes do candidato original; os registros de aceite e os
recibos de revisão são retidos privadamente. Nenhum deploy é incluído.

## Executar localmente

Requer Docker Engine, Docker Compose **2.24.4 ou superior** (suporte a `!override`
e `!reset`), Bash e portas livres. Os testes oficiais de integração/HTTPS usam
Linux com Docker rootful. O primeiro build baixa imagens/pacotes; depois os
testes usam containers isolados. Python e Node no host não são necessários para
executar a aplicação; a reprodução de checkout limpo requer Git.

```bash
cp .env.example .env
# Se 8080 estiver ocupada, altere WEB_PORT e as duas CSRF_TRUSTED_ORIGINS em .env.
docker compose up -d --build --wait
```

Abra http://127.0.0.1:8080, ou a porta escolhida em WEB_PORT. A porta é publicada
somente no loopback; banco e API não publicam portas. `/health/live` confirma o
processo; `/health/ready` consulta o banco e as migrations.

| Papel local | E-mail | Senha pública de demonstração |
|---|---|---|
| Administrador | admin@salafacil.local | AdminLocal!2026 |
| Membro | membro@salafacil.local | MembroLocal!2026 |

Essas contas são somente de demonstração `local`/`test`. O seed transacional é
inicializado uma vez por banco e preserva alterações posteriores de usuários,
senhas e salas. Há cinco salas fictícias, incluindo uma bloqueada e uma inativa.
Reservas são criadas nos fluxos reais. Não use as credenciais locais em produção.

Em banco novo, `init` aplica migrations e seed antes da API. Em instalação
existente, migrations pendentes exigem backup, revisão do plano e execução
manual; `init` não as aplica automaticamente. Siga [o runbook](docs/operations.md).

```bash
docker compose ps
docker compose logs --tail=100 backend web
docker compose restart
docker compose down
# Voltar mantendo os dados:
docker compose up -d --wait
```

`docker compose down -v` apaga os dados deste projeto. Use somente para reset
intencional de uma instalação descartável.

## Verificações e CI

```bash
bash scripts/test-backend.sh
bash scripts/test-frontend.sh
bash scripts/test-e2e.sh
bash scripts/test-operations.sh
# Com fonte commitada e limpa:
bash scripts/test-reproduce.sh
```

Os scripts usam projetos, imagens e volumes descartáveis próprios, preservando
a instalação local. E2E usa 18081; operação usa 18082/8443; reprodução usa 18084.
Consulte [verification.md](docs/verification.md) antes de rodar em paralelo.
O CI executa os cinco scripts em runners separados, com permissões somente de
leitura, sem segredos do produto e sem checkout da Factory privada.

## Escopo e limites

Login/logout, agenda, busca por horário/capacidade/recursos, criação/consulta/
cancelamento de reservas, administração de salas/estados e auditoria. O backend
aplica autorização por dono e papel, CSRF, limites de tempo/capacidade e proteção
de conflitos/concorrência no PostgreSQL. Cancelar e inativar preservam históricos.

- Escritório único; sem multitenancy.
- Perfil `production` verifica HTTPS, cookies seguros, proxy por socket e
  administrador inicial em Linux rootful. Não inclui deploy, gestão multiusuário
  de produção nem recuperação de contas.
- Chromium desktop/mobile exercitado; sem certificação integral de tecnologia
  assistiva, outros navegadores ou ensaio de carga de produção.
- IP externo/IPv6 de entrada e Docker Desktop/rootless não são certificados para
  o perfil HTTPS. Pacotes do sistema/imagens base não têm auditoria CVE neste pacote.

## Documentação e proveniência

- [Operação, backup, restauração e TLS](docs/operations.md)
- [API](docs/api.md), [segurança](docs/security.md), [desenvolvimento](docs/development.md)
- [Verificação reproduzível](docs/verification.md), [evidências selecionadas](docs/release-evidence/README.md)
- [Proveniência e hashes](provenance.json), [inventário de licenças de dependências](docs/dependency-licenses.json)

Esta exportação inicia um histórico separado. O repositório original e seus
registros privados permanecem preservados. `provenance.json` vincula os bytes
exportados ao candidato e ao fingerprint originais; a revisão da Factory continua
fixada no original e não foi alterada por esta cópia. Metadados brutos de revisão,
inputs, cookies, traces, bancos, backups e `.env` não fazem parte da exportação.

Nenhuma licença permissiva foi adicionada ao produto. O inventário informa as
licenças declaradas pelas dependências; não substitui os respectivos termos.
