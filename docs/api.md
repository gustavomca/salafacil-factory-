# API — contrato implementado

Contrato do produto implementado. Verificações reproduzíveis em [verification.md](verification.md).
Mudanças materiais precisam preservar os controles e testes descritos aqui.


Base /api, JSON UTF-8. Corpo limitado a 32 KiB, Content-Type application/json.
Paginação geral count/next/previous/results, page_size padrão 20/máximo 100;
ordenação determinística inclui id. Auditoria é a exceção: results/next_cursor/
has_more com cursor sobre id imutável, mesmo limite de página. Query/cursor
inválido (inclusive enum/fuso/página/tipo) retorna 400.
Datas sempre ISO 8601 com offset; saída UTC Z. Nenhuma resposta inclui password.

| Método / rota | Papel | Contrato principal |
|---|---|---|
| GET /session/csrf | Público | 200 {csrf_token,server_now}; UTC com offset; Cache-Control no-store |
| POST /session/login | Público + CSRF | {email,password}; 200 {user}; 400/401/403/429 |
| POST /session/logout | Autenticado + CSRF | 204, sessão invalidada; repetição sem sessão 401 |
| GET /session/me | Público, sem dados de terceiros | 200 {user:{id,name,email,role}} ou {user:null}; no-store |
| GET /rooms | Autenticado | Busca/filtros capacity/resources/status autorizados; membro só active/blocked |
| POST /rooms | Admin + CSRF | Campos comuns; criada active; 201 |
| GET /rooms/{id} | Autenticado | Detalhe; membro não lê inactive (403), inexistente 404 |
| PATCH /rooms/{id} | Admin + CSRF | Campos comuns; erro capacidade vigente 409 |
| POST /rooms/{id}/block | Admin + CSRF | {reason}; 200 Room + affected_reservations_count |
| POST /rooms/{id}/unblock,/deactivate,/reactivate | Admin + CSRF | Transição explícita; 200 recurso, 409 inválida |
| GET /availability | Autenticado | starts_at,ends_at e participants opcional; lista paginada de Rooms livres |
| GET /reservations | Autenticado | scope=mine padrão; scope=all só admin; room_id,status,from,to,not_ended e paginação |
| POST /reservations | Autenticado + CSRF | room_id,title,description,starts_at,ends_at,participants; 201 recurso |
| GET /reservations/{id} | Dono/admin | 200 recurso; ?scope=all só admin inclui responsável; 403 alheia, 404 inexistente |
| POST /reservations/{id}/cancel | Dono/admin + CSRF | 200 cancelled (idempotente); 403 alheia |
| GET /dashboard | Autenticado | date=YYYY-MM-DD e tz=IANA; server_now UTC, listas próprias limitadas + counts por papel |
| GET /audit-events | Admin | type,actor_id,result,from,to,cursor; id DESC imutável; inclui count/first_at/last_at |

Sala em reserva é resumo com nome/estado/capacidade atuais, mesmo se inativa, pois
o dono precisa consultar histórico. Snapshot de nome antigo não é requisito;
identidade da sala e campos imutáveis da reserva preservam vínculo. Admin recebe
dono (id,nome,email) apenas na visão administrativa; membro só possui seu contexto.

Envelope: {error:{code,message,details}}; details de validação mapeia nomes de campos
para mensagens, nunca valores submetidos. 400 VALIDATION_ERROR; 401 AUTH_REQUIRED/
INVALID_CREDENTIALS; 403 FORBIDDEN/CSRF_FAILED; 404 NOT_FOUND; 405 METHOD_NOT_ALLOWED; 409 ROOM_UNAVAILABLE/
ROOM_CAPACITY_CONFLICT/INVALID_ROOM_STATE; 429 LOGIN_RATE_LIMITED; 503 RETRY_LATER/
SERVICE_UNAVAILABLE; 500 INTERNAL_ERROR; 503 PROXY_IDENTITY_INVALID para configuração/encaminhamento inválido. Mesmo envelope em middlewares e JSON parse.

Mapeamento normativo da criação (após autenticação/CSRF):

| Regra | HTTP / código |
|---|---|
| Payload/tipo/data sem offset, início no passado, duração ou participantes fora dos limites absolutos | 400 VALIDATION_ERROR, details por campo |
| Room inexistente | 404 NOT_FOUND |
| Room inativa submetida por membro | 403 FORBIDDEN, coerente com detalhe restrito, sem dados da sala |
| Room inativa submetida por admin ou Room bloqueada para qualquer papel | 409 ROOM_UNAVAILABLE |
| Participantes válidos mas superiores à capacidade atual após lock | 409 ROOM_CAPACITY_CONFLICT |
| Overlap com confirmada, por consulta ou constraint nomeada | 409 ROOM_UNAVAILABLE |
| Timeout de lock ou banco indisponível | 503 RETRY_LATER / SERVICE_UNAVAILABLE |

Validação sintática ocorre antes do lock; estado/capacidade/overlap e relógio final
ocorrem depois. Ordem exata: autenticação/CSRF; sintaxe/tipos/limites estáticos
(400 mesmo que room_id não exista); existência e permissão da sala (404/403);
início ainda futuro pelo relógio após lock (400); estado; capacidade; overlap.
Duração/finito/offset já são checados na fase estática; não há precedência dupla. Toda resposta recusada de
criação preserva formulário; UI destaca campo no 400 e oferece atualizar busca em 409.

Filtros de reservas from/to usam instantes com offset e interseção de [from,to)
com [starts_at,ends_at), exigindo from<to quando ambos presentes. Uma fronteira
omitida é ilimitada. not_ended=true significa ends_at>agora do servidor; false significa ends_at<=agora;
parâmetro ausente não restringe por término. not_ended=true ordena por início/id
ascendente para mostrar primeiro o encontro mais próximo; histórico usa ordem
decrescente. A prévia
administrativa usa /reservations?scope=all&room_id=ID&status=confirmed&not_ended=true
com page_size=1 e lê count; somente admin. Após mutação, o total retornado sob lock
é autoritativo. Filtros não podem ampliar o conjunto autorizado.

Regra de início futuro é preservada sem tolerância. Dashboard/CSRF retornam
server_now fora do token. UI estima diferença de relógios usando server_now
menos ponto médio dos instantes de envio/recebimento locais, e avança a referência
com tempo monotônico decorrido; o servidor continua autoritativo. Sugestão é o
primeiro limite de 5 minutos que esteja pelo menos 2 minutos à frente da estimativa.
Nunca confiar só no relógio civil do cliente nem prometer ausência de erro por latência.
Ao demorar, orientar escolha de próximo horário.
“Disponível agora” é indicador instantâneo, não promessa de aceitar reserva retroativa
no minuto corrente. Ao detectar início vencido, manter campos e oferecer recalcular
horário futuro; não deslocar reserva silenciosamente. Testar minuto corrente,
relógio do cliente divergente e passagem de tempo entre formulário e lock.

Timezone: UI constrói ISO com offset a partir de campos locais e confirma conversão;
rejeita hora inexistente por transição de fuso e mostra offset em horário ambíguo,
permitindo escolha explícita antes de submit. Dashboard calcula [meia-noite local,
meia-noite seguinte) por ZoneInfo da zona informada, sem presumir dias de 24 h.
Critério do dia: confirmed que intersecta intervalo; próximas: starts_at ≥ agora,
confirmed. Reserva em andamento aparece no dia, sem ser próxima. Validação UTC
compara duração real; backend não aceita string local sem offset.
