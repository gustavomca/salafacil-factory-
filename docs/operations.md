# Operação

## Instalação local e saúde

Siga README: `.env.example` → `.env`, escolha porta livre e execute
`docker compose up -d --build --wait`. `init` aplica migrations automaticamente somente no primeiro boot de banco
local/test novo, sem histórico de migrations. A guarda usa esse histórico como
pré-condição de inicialização; não recupera ledger removido ou corrompido. Em instalação existente com plano pendente, recusa iniciar
com LOCAL_MIGRATIONS_PENDING: faça backup, examine migrate --plan e execute
migrate manualmente antes de subir. O seed tem marcador transacional por banco
e não recria salas renomeadas nem depende de nomes únicos. Backend depende do sucesso de init; web depende da saúde da API.
A repetição do plano já aplicado não altera dados. Web/API rodam como10001,
filesystem somente leitura e tmpfs temporário. PostgreSQL usa volume nomeado.

A rede `app` é interna, compartilhada por banco, API e proxy. Somente o proxy
local participa também de `edge`, bridge que permite publicar o loopback.
Docker não publica efetivamente a porta de um container ligado apenas à rede
internal neste ambiente. Essa separação segue o padrão documentado pelo
[Docker](https://docs.docker.com/engine/network/). Test runners e backend ficam
na rede interna; frontend-test fica sem rede. Não há dependência de serviços
externos durante os fluxos/testes após o build.

`GET /health/live` e `/health/ready` não exigem sessão e não retornam detalhes do
banco. Logs são estruturados e sanitizados: `docker compose logs --tail=100 backend
web`. Não use debug em produção nem capture `docker compose config` sem `--quiet`
em logs compartilhados, pois a configuração resolvida inclui segredos.

`docker compose restart` e `down` preservam volumes. `down -v` destrói os dados do
projeto escolhido. Não confundir essa ação com manutenção normal.

## Atualização local com migrations pendentes

Faça o backup descrito abaixo antes de atualizar. Construa a nova versão e examine
seu plano sem depender de um backend já iniciado:

```bash
docker compose build init backend web
docker compose up -d --wait db
docker compose run --rm --no-deps init python manage.py migrate --plan
```

Após revisar o plano e confirmar o backup, aplique explicitamente as migrations
previstas e inicie os serviços. Mudanças destrutivas exigem decisão própria sobre
os dados afetados; não execute esse passo sem revisar o plano.

```bash
docker compose run --rm --no-deps init python manage.py migrate --noinput
docker compose up -d --wait
```

O comando explícito passa pelo entrypoint sem acionar o bootstrap automático.
A sentinela de seed reconhece instalações da versão anterior e preserva suas salas.

## Backup e restauração

Exemplo local, execute no diretório correto do projeto. O dump inclui usuários,
sessões e auditoria: trate-o como dado confidencial, fora do Git e dos logs.

```bash
mkdir -p backups
chmod 700 backups
umask 077
docker compose exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d "$APP_DB_NAME" -Fc' > backups/salafacil.dump
```

Restaure primeiro em uma instalação separada, com mesmo usuário/nome de banco e
mesma SECRET_KEY se quiser validar sessões. Um projeto Compose diferente cria
volume independente. Parar a origem permite usar a mesma porta; não é necessário
apagar seu volume. Os comandos abaixo não sobrescrevem o banco da origem:

```bash
docker compose stop web backend
docker compose -p salafacil-restore up -d --wait db
docker compose -p salafacil-restore exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U postgres -d "$APP_DB_NAME" --exit-on-error --clean --if-exists' < backups/salafacil.dump
docker compose -p salafacil-restore up -d --wait
```

Verifique login, reservas, estados e auditoria antes de decidir uma recuperação
real. `scripts/test-operations.sh` faz esse exercício em volumes próprios e testa
por HTTP a reserva e o cookie originais após restart e restauração. Backups
regulares/off-site e sua retenção são responsabilidade operacional da instalação;
o MVP não agenda cópias nem envia dados a terceiros.

## Perfil HTTPS/socket

Este perfil é uma validação de segurança, em Linux com Docker rootful. Requer
host dedicado sem serviços sensíveis sem autenticação em loopback/sockets
abstratos: Nginx usa host network, portanto compartilha essa conectividade.
Backend só atende socket Unix, DB não publica portas, e web não recebe credenciais
backend. O bind IPv4 é unicast específico na porta8443; wildcard, multicast, broadcast limitado
e escrita com zeros ambíguos são recusados. Não é implantação pública nem
lifecycle de usuários de produção.

Crie `.env.production` privado (`chmod600`), sem usar as senhas/chave de demo:
APP_ENV=production, DEBUG=false, SECRET_KEY aleatória com pelo menos50 caracteres,
DB_PASSWORD e DB_ADMIN_PASSWORD independentes fortes, DB_NAME/DB_USER,
ALLOWED_HOSTS explícito (sem wildcard), CSRF_TRUSTED_ORIGINS com HTTPS,
WEB_BIND_IPV4 literal e TLS_DIRECTORY absoluto. O diretório TLS deve conter
server.crt/server.key legíveis pelo grupo10001; diretório0750, chave0640.
Use certificado apropriado ao host e vigente, com cadeia confiável nos clientes.
Nginx recusa um par chave/certificado incompatível ao iniciar. A vigência e a
renovação são responsabilidade do operador; o perfil não emite nem renova
certificados. O probe HTTPS verifica cadeia, hostname e validade temporal.
Não versionar esses materiais.

Defina uma função Bash no terminal de operação para reduzir erro de perfil:

```bash
prod() { docker compose --env-file .env.production -p salafacil-secure -f compose.yaml -f compose.production.yaml "$@"; }
prod config --quiet
prod build db backend web
prod up -d --wait db
prod run --rm --no-deps init python manage.py migrate --plan
prod run --rm --no-deps init python manage.py migrate --noinput
# Solicita senha de forma interativa (não coloque senha em argumento):
prod run --rm --no-deps init python manage.py provision_initial_admin --email admin@seu-dominio.example --name 'Administrador'
prod up -d --wait
```

Migrations em production são manuais; init faz `migrate --check` e recusa subir
com alterações pendentes. `seed_local` é proibido. Provisionamento só inicia uma
instalação vazia; repetir com o mesmo administrador preserva senha/dados. Não
cria outras contas nem troca senhas em uma instalação já provisionada. Não há
API de administração de usuários ou operação multiusuário production neste MVP.

Antes de atualizar com dados úteis, faça backup e examine o plano de migrations.
Para backup no perfil seguro, use a função prod acima e diretório privado:

```bash
mkdir -p backups
chmod 700 backups
umask 077
prod exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -U postgres -d "$APP_DB_NAME" -Fc' > backups/salafacil-secure.dump
```

Restauração deve ser validada em outro projeto/volume com o perfil production e
os mesmos DB_NAME/DB_USER. Aponte uma função `recover` ao arquivo privado de
configuração e ao projeto de recuperação, suba somente db e use:

```bash
recover exec -T db sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore -U postgres -d "$APP_DB_NAME" --exit-on-error --clean --if-exists' < backups/salafacil-secure.dump
```

`--clean` substitui tabelas no destino: use apenas o banco de recuperação escolhido.
O bootstrap/seed não deve criar contas locais nesse perfil. Valide o plano,
health, login, reservas e auditoria antes de qualquer troca de instalação real.
Não automatize migrations destrutivas. Verifique health e logs após atualização.
O teste operacional gera certificado efêmero e verifica confiança TLS por CA,
Secure/HttpOnly/Lax, CSRF, socket0660/diretório0770 e IPs locais diferentes com
XFF forjado; não mede tráfego real de clientes externos ou capacidade de produção.

## Manutenção e recuperação de login

Execute periodicamente, por operação externa autorizada, em lotes limitados:

```bash
docker compose exec backend python manage.py maintenance --batch-size 1000
```

Remove apenas sessões expiradas e buckets de login vencidos há mais24h; não
remove auditoria. Não há scheduler novo no produto. Para liberar um alvo após
diagnóstico, o comando exige confirmação e motivo, preserva trilha e outros alvos:

```bash
docker compose exec backend python manage.py unlock_login --identity membro@salafacil.local --reason SUPPORT_RECOVERY --confirm
# Alternativa: --network 192.0.2.10 ou prefixo IPv6 /64 explícito.
```

No perfil seguro substitua o prefixo por `prod exec backend`. Isso é uma ação
operacional, não uma forma de desativar limites globalmente. Um usuário atrás
da mesma rede/NAT compartilha a cota de IP com outros; a interface exibe Retry-After.

## Diagnóstico

- Porta ocupada: altere WEB_PORT e origins do `.env`, então recrie web/backend.
- 403 no login: use URL/origin configurada e cookie CSRF atual; confirme que todas
  as mutações passam pelo proxy. Não desative CSRF para contornar o problema.
- 503 PROXY_IDENTITY_INVALID: acesso direto ao backend ou proxy mal configurado;
  restaure o caminho oficial que sobrescreve XFF com um único endereço literal.
- 429: aguarde Retry-After ou use o desbloqueio específico após diagnóstico.
- Init falhou: leia `docker compose logs init`; production e atualizações de
  instalações locais existentes exigem migrate manual após backup/plano.
- Socket/TLS ilegível: verifique modos e grupo10001, sem liberar permissões globais.
- Resultado incerto após reserva/cancelamento: consulte a agenda antes de repetir.
- Build offline falhou: prepare imagens e pacotes com rede; depois execute testes.

Os scripts de QA integrados são validados em Linux/rootful e executam os probes
Python dentro das imagens preparadas. A reprodução de checkout usa Git no host.
Cada run usa IMAGE_TAG próprio; não compartilha tags com a demo nem com outra run.
