# Sintonia — jogo de casais

Casais respondem a mesma pergunta, cada um no seu celular. Resposta igual vale ponto.

## Rodar

    npm install
    node server.js        # Node 18+
    # abre em http://localhost:3000

Ou com Docker:

    docker build -t sintonia . && docker run -p 3000:3000 sintonia

## Onde os jogos são gravados

O estado fica em memória e é gravado a cada mudança. Ao subir, o servidor recarrega os jogos.
A escolha é por variável de ambiente:

| Variável | Armazenamento |
| --- | --- |
| `DATABASE_URL` | PostgreSQL. Cria a tabela `sintonia_rooms` sozinho (uma linha por jogo, estado em JSONB). |
| `DATA_DIR` | Arquivos JSON em `DATA_DIR/rooms/CODIGO.json`. |
| nenhuma | Só memória: reiniciar apaga tudo. |

`GET /healthz` mostra o armazenamento em uso no campo `storage`. Se o banco não responder na
subida, o servidor avisa no log e segue em memória.

Cada jogo guarda placar, casais, jogadores, lista de perguntas, a pergunta aberta e um `history`
com todas as rodadas reveladas (pergunta, resposta de cada pessoa e pontos dados).

`ROOM_TTL_HOURS` define após quantas horas sem uso um jogo é apagado (padrão: 168, sete dias).

## Colocar online no Render

1. New > Web Service > escolha o repositório. Build Command `npm install`, Start Command `node server.js`.
2. Crie um PostgreSQL (no próprio Render ou em outro provedor) e copie a URL de conexão.
3. No serviço web: Environment > adicione `DATABASE_URL` com essa URL.

O disco de um Web Service do Render é apagado a cada deploy ou reinício, então `DATA_DIR` só
persiste ali com um Persistent Disk montado. Use **uma única instância**: as atualizações chegam por SSE.

## Como funciona

- `/` cria o jogo e leva ao painel `/admin/CODIGO#token`. Guarde esse link: ele é a chave do admin.
- O painel mostra o QR Code de `/j/CODIGO`. Cada pessoa entra com o nome e cria o casal ou toca em "Sou o par".
- Admin dispara uma pergunta, acompanha quem já respondeu e toca em "Revelar respostas e pontuar".
- Só então as respostas aparecem para todos. Casal completo com respostas iguais ganha os pontos da pergunta.
- O admin pode ajustar pontos (+/−), remover jogadores, criar perguntas e zerar o placar.

## Limites

- Uma única instância (o estado ativo fica na memória do processo).
- Uma gravação é feita até 250 ms depois de cada mudança; uma queda brusca nesse intervalo perde a última ação.
