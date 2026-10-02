# Segurança — controles e contrato de implementação

Contrato do produto implementado. Verificações reproduzíveis em [verification.md](verification.md).
Mudanças materiais precisam preservar os controles e testes descritos aqui.


Sessão Django em banco, cookie HttpOnly, SameSite=Lax, path=/, sem Domain e Secure
em produção. Expiração absoluta 8 h: no login, set_expiry recebe datetime timezone-aware
absoluto (instante do login + 8 h), não número de segundos. Qualquer save posterior
preserva esse prazo. Login cria/rotaciona chave e CSRF; logout flush invalida no
servidor. SESSION_SAVE_EVERY_REQUEST=false, CSRF_USE_SESSIONS=false; token CSRF
é tratado por cookie/middleware, não dentro da sessão. Testar save posterior ao
login e confirmar expire_date original, além de negar cookie depois desse instante.
Senha usa hasher padrão PBKDF2 da versão fixada; nunca implementar criptografia própria.

GET /api/session/csrf fornece token CSRF mascarado, no-store, mesma origem; frontend
mantém em memória. Cookie CSRF também pode ser HttpOnly porque token vem do endpoint.
Reobter token após login/rotação. Login é view Django com csrf_protect explícito,
não confiar na validação de SessionAuthentication para usuário anônimo. Todos os
métodos inseguros, inclusive login/logout, verificam CSRF/Origin; falha é 403
CSRF_FAILED em envelope JSON. Não relaxar proteção para tornar testes verdes.

SessionAuthentication é adaptada para distinguir sem sessão (401 com challenge
Session) de papel insuficiente (403); customização só da resposta/challenge, não
da verificação de cookie/CSRF. Login inválido/inativo retorna 401 INVALID_CREDENTIALS
sem distinguir existência da conta; caminho desconhecido também executa hash lento.
Sessões e eventos de login/logout são explicitamente persistidos pelo serviço em
transação antes de retornar sucesso, sem depender apenas do save tardio de middleware.
Falha no commit devolve 503 e não promete sessão criada/invalidação concluída.

Allowlist de escrita ignora nenhum campo privilegiado silenciosamente: enviar owner,
role/status de reserva ou actor gera 400; CSRF válido não concede permissão.
Selectors restringem listas antes de paginação/contagem. Objetos checam propriedade
no serviço; admin/member carregados do banco a cada requisição. PATCH de sala só
campos comuns; transições por endpoints dedicados. Deleções/alterações de usuários,
reservas e auditoria não são expostas.

Limites login: janelas fixas de 15 min, inicialmente 60 tentativas/IP; 10 falhas
por par (identidade normalizada, IP); 100 falhas globais/identidade. Sucessos só
consomem cota IP. Identidades/IP são HMAC com chave derivada separada do segredo
de sessão, nunca texto bruto. Canonicalizar IPv4 como endereço e IPv6 como prefixo
/64 antes do HMAC, tanto em ip quanto pair, evitando alternância de /128 no mesmo
prefixo. O teto global mais alto limita ataques distribuídos;
a chave por par evita que um IP com 10 falhas esgote a conta em outros IPs.

Concorrência do limitador: uma transaction.atomic cria/carrega por UPSERT os
buckets em ordem determinística (kind/key/window), com lock de linha. Consome a
cota IP; verifica cotas de falha do par e da identidade. Se houver saldo, executa
o hash ainda sob esses locks, incrementando somente as cotas de falha quando a
credencial for inválida. Em sucesso, não apaga falhas anteriores. Contagens,
sessão/evento do resultado são commitados antes da resposta. Resultado negado é
valor do serviço tratado após commit, não exceção que reverta os contadores.
IP sem saldo recebe 429 sem hash. Sem hash paralelo para mesmo IP/identidade,
sem contadores de memória, leases ou tentativa em andamento separada. Limitar
password de entrada a 128 caracteres evita trabalho arbitrariamente grande.

Esse protocolo segura locks durante o hash lento e serializa logins do mesmo IP,
trade-off deliberado para o escritório pequeno e 2 workers. Nenhum I/O de rede
externo acontece sob lock. Lock timeout de 5 s produz 503 RETRY_LATER; a suíte
mede o comportamento e prova que concorrência não ultrapassa as cotas. Se tempos
observados tornarem login impraticável, ajustar implementação com nova evidência,
sem remover limites ou afirmar capacidade não medida.

Excesso gera 429 com Retry-After até fim da janela. Janelas fixas aceitam burst
nas bordas; não é defesa DDoS. Um limitador pode atrasar usuário legítimo sob ataque
distribuído; a mitigação operacional faz parte da entrega: comando CLI restrito
unlock_login fora da API, com motivo enumerado e evento de auditoria. Há dois
alvos explícitos: identidade (par/global) ou IP/prefixo (ip e pares desse prefixo).
Sem reset global implícito; o operador confirma o alvo e não apaga auditoria.
Audit actor_id=null, resource=login_limit e resource_id=null, reason_code enumerado,
sem nome digitado tratado como identidade autenticada ou IP/e-mail bruto no evento.
Metadata inclui target_kind enumerado identity/network, sem o valor do alvo.
O acesso exige permissão de operador no container, não do usuário web. Manutenção remove buckets
vencidos há mais de 24 h por comando limitado, sem scheduler. Falha no banco gera
503, sem fallback permissivo. Testes dedicados usam limites reais; demais casos
E2E isolam dados/buckets na stack de teste, sem relaxar os limites de produção.

Topologia do perfil de validação de produção: web Nginx termina TLS, não-root,
com network_mode:host apenas no Linux suportado. Ele escuta em endereço IPv4 literal
explícito WEB_BIND_IPV4 e porta 8443 não privilegiada, sem diretiva de listen IPv6;
não usa ports do Docker nem docker-proxy. IPv6 de entrada não é suportado nesse
perfil v1; o domínio/endereço de acesso deve resolver para o IPv4 configurado.
Nginx sobrescreve X-Forwarded-For com remote_addr, X-Forwarded-Proto com seu scheme
e preserva Host com porta ($http_host). Nunca confia em forwarded headers públicos.
Certificado/chave entram por mount read-only, validados no entrypoint. Configuração
local continua Docker bridge/HTTP loopback e não é declarada resistente à agregação
de IP de clientes passando pelo proxy/NAT do Docker.

Nesse perfil, Gunicorn escuta somente em socket Unix num volume compartilhado
entre backend e web; não há listener TCP ou porta publicada para contornar o proxy.
Socket/diretório usam grupo dedicado comum e permissões 660/770, sem world-write,
com propriedade preparada na imagem/volume; nome conhecido dentro de /run/salafacil.
Health backend usa esse socket, não uma porta aberta adicional. Somente web/backend
montam esse volume. Headers de proxy são confiáveis nessa fronteira privada;
SECURE_PROXY_SSL_HEADER reconhece esquema substituído pelo Nginx. Em ambas as
topologias, limitação e auditoria obtêm IP exclusivamente de X-Forwarded-For
sobrescrito pelo Nginx: exatamente um literal IPv4/IPv6, nunca cadeia de valores.
Não usar REMOTE_ADDR (peer vazio/constante no socket ou IP do web em TCP) para
buckets/auditoria. Header ausente, múltiplo ou inválido gera 503 PROXY_IDENTITY_INVALID
e log sanitizado, antes da operação; não criar bucket unknown/vazio nem aceitar
IP enviado no payload. A configuração de proxy aplica esse header a todas as
rotas API; health interno sem identidade é isento apenas para diagnóstico mínimo.
Canonicalização converte IPv4-mapped IPv6 em IPv4 antes de aplicar /64 aos demais
IPv6. Testar ausência, formato inválido, múltiplos IPs, mapped IPv4 e duas origens
através do socket. XFF forjado na borda deve ser sobrescrito, não repassado. Host/operator
com controle do Docker não é adversário isolado pelo aplicativo.

Trade-off: web em host network pode alcançar serviços em loopback, IPs de
containers nas bridges (inclusive PostgreSQL) e sockets Unix abstratos associados
ao namespace de rede do host. Não se promete isolamento de conectividade desse
processo; não-root/cap_drop/read-only não bloqueiam esses acessos. Mitigar com usuário não-root, cap_drop=ALL,
no-new-privileges, filesystem read-only com tmpfs apenas para runtime, nenhum socket
Docker/host filesystem montado e upstream fixo no socket da aplicação, sem URL de
proxy controlada por usuário. Web não recebe credencial do banco nem SECRET_KEY
Django; PostgreSQL exige autenticação por senha inclusive na rede interna, sem
trust por origem. O perfil pressupõe host dedicado ou sem serviços sensíveis não
autenticados em loopback/socket abstrato, com Docker/containerd suportados e sem
shim/serviço privilegiado exposto em socket abstrato. Essas precondições precisam
ser conferidas antes de uso operacional; o RC local e os probes não certificam
esta estação como host de produção. A mudança é de configuração de um proxy existente,
sem mudança da stack, paradigma ou autorização de dados; seu trade-off integra H2.
O probe bridge reproduziu colapso somente no caminho de clientes do próprio host
via gateway/hairpin. Não mediu IPv4 externo por DNAT e não prova que bridge sempre
perca origem. Escolher host network elimina a camada de tradução e permite E2E de
origem em um único host sem alterar daemon global ou criar harness de roteamento
privilegiado; é uma escolha de simplicidade de verificação, não necessidade universal.
O trade-off de conectividade acima integra expressamente a decisão H2.

Perfil de produção suportado: Docker Engine rootful Linux com a configuração host
acima. Docker Desktop/rootless não são declarados validados para esse perfil. O
teste de IP usa dois clientes isolados como processos/containers host-network com
source_address explícito 127.0.0.2 e 127.0.0.3 contra listen IPv4 loopback do web;
como não há port publishing/proxy/NAT, devem chegar distintos ao Nginx e aos buckets
através do socket. Não simular origem por XFF. O experimento isolado reproduziu esse
comportamento no ambiente atual; ainda não prova TLS, Django, buckets ou o produto.
Teste integrado posterior cobre TLS/CSRF/Secure, cabeçalhos forjados e origem no
Nginx e backend. IPv6 /64 é validado no serviço de canonicalização/buckets/agregação,
não apresentado como E2E de entrada IPv6. Futuro suporte dual-stack exige outra
configuração/revisão, fora da v1.

Produção exige DEBUG=false, secrets próprios, host/origin explícitos, cookie Secure
e certificado montado válido. Testes usam certificado/segredo efêmeros sem versionar.
NAT externo legítimo ainda agrupa usuários por origem, como em qualquer limite por
IP; o desbloqueio explícito por rede continua disponível. Não confundir IP com
identidade humana ou prometer resistência DDoS. Nenhuma implantação pública é feita.

## Auditoria e observabilidade

Eventos de login success/denied, logout, login.limit_unlocked, account.provisioned, room.created/updated/blocked/unblocked/
deactivated/reactivated, reservation.created/cancelled e operation.denied.
Allowlist por tipo: request_id gerado pelo servidor, reason_code enumerado,
changed_fields como nomes enumerados e estados anterior/novo. Não guardar bodies,
headers, query strings integrais, senha/hash, session/cookie/token, email de tentativa,
título/descrição/motivo livre. Ator identificado por ID quando conhecido; recurso/ID
próprio ou alvo da tentativa quando válido. Payload arbitrário nunca é copiado.

Eventos de mutação success estão na mesma transação da operação: falha de auditoria
reverte tudo. Denied por 401/403/CSRF/limite/operação recusada é registrado depois de
rollback, em transação distinta; não lançar exceção que reverta o próprio evento.
ATOMIC_REQUESTS=False impede transação externa implícita; todos os testes desse
comportamento usam TransactionTestCase com commits reais e verificação por conexão
independente. GET /session/me é uma consulta pública de estado, retorna user:null
quando anônimo, sem gerar negação falsa; demais recursos protegidos mantêm 401.

Para evitar uma linha nova por repetição automática, negações repetidas de login,
CSRF anônimo e todos os 401 anônimos (GET/POST de salas/reservas, logout sem sessão
e demais recursos protegidos) são agregadas por janela de 15 min, tipo/reason_code,
nome canônico da rota, ator conhecido ou null e IP HMAC. A agregação usa exatamente
a mesma canonicalização do limitador: IPv4 endereço, IPv6 prefixo /64 antes do HMAC.
Teste de serviço exige uma única linha para dois /128 do mesmo /64. Identificadores fornecidos
por anônimo não são resolvidos como recurso antes da autenticação nem usados para
criar chaves ilimitadas. Resource=session/http e resource_id=null nesses casos; não
armazenar IDs de sessão. Cada tentativa incrementa atomicamente count e atualiza last_at com GREATEST
(last_at, instante_da_tentativa), sem regressão por commit tardio;
first_at, last_at, count e o ator são preservados. Nenhuma amostragem ou perda de
contagem: uma tentativa é sempre representada. Chave interna de agregação não é
exposta na API. Falhas acima do limite usam apenas ator já conhecido, sem consulta
de identidade adicional arbitrária. Eventos de mutação, autorização de objeto,
login bem-sucedido e logout continuam individuais. AuditEvent ganha first_at,
last_at e count (1 para individuais) e uma chave opcional única de agregação.
Para agregados, aggregation_key é obrigatoriamente não nula e resulta do hash de
uma representação canônica dos campos de grupo, usando sentinela explícita para
ator desconhecido. UNIQUE nessa coluna e UPSERT impedem duplicatas inclusive com
actor_id=null. Eventos individuais deixam aggregation_key=null. Não usar UNIQUE
composta com coluna nullable como mecanismo de deduplicação.
A UI identifica repetições e seus horários; filtro from/to é intervalo [from,to),
e inclui o grupo quando first_at < to e last_at ≥ from. A contagem é do grupo inteiro
e pode incluir tentativas fora do recorte: mostrar essa indicação, sem inventar
horários individuais entre primeiro/último. Auditoria usa cursor por id DESC
imutável (id<cursor), mostrando last_at sem reordenar atualizações. Novos grupos
aparecem ao atualizar a busca; valores de contagem são vivos, não snapshot congelado. Isso limita
crescimento por repetição da mesma origem; não promete volume ilimitado nem evita
todas as escritas, necessárias para contar negações exigidas pela demanda. A API
continua somente leitura; atualização interna do agregado só muda count/last_at.
Se banco indisponível não é possível garantir evento persistido: responder 503,
log operacional sanitizado e não alegar auditoria gravada. Rejeições sintáticas
sem operação reconhecida não exigem copiar payload para auditar.

Logs JSON em stdout com timestamp, nível, request_id, método, nome da rota (não URL
bruta com query), status, duração e código de erro. Sem bodies/headers/identidades
brutas. Exceção inesperada recebe ID e resposta genérica 500; detalhes SQL/valores
não vão ao cliente nem a logs inseguros. Nginx não registra query/cookie/header.
Gunicorn começa com 2 workers síncronos configuráveis, sem estado de segurança
por worker. Liveness /health/live só processo; readiness /health/ready confirma conexão/query
no banco e migrações aplicadas, sem expor DSN/versões. Gunicorn recebe SIGTERM e
conclui pedidos em prazo limitado; stop_grace_period excede graceful_timeout.
