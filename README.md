# Sintonia — jogo de casais

Casais respondem a mesma pergunta, cada um no seu celular. Resposta igual vale ponto.

## Rodar

    node server.js        # Node 18+, sem dependências
    # abre em http://localhost:3000

Ou com Docker:

    docker build -t sintonia . && docker run -p 3000:3000 sintonia

## Colocar online (Render, plano gratuito)

1. Suba esta pasta para um repositório no GitHub.
2. Em render.com: New > Web Service > escolha o repositório.
3. Runtime Node, Start Command `node server.js` (o `render.yaml` já traz isso).

Qualquer host que rode Node ou um contêiner serve (Railway, Fly.io, Cloud Run, Kubernetes).
Use **uma única instância**: o estado fica em memória e as atualizações chegam por SSE.

## Como funciona

- `/` cria o jogo e leva ao painel `/admin/CODIGO#token`. Guarde esse link: ele é a chave do admin.
- O painel mostra o QR Code de `/j/CODIGO`. Cada pessoa entra com o nome e cria o casal ou toca em "Sou o par".
- Admin dispara uma pergunta, acompanha quem já respondeu e toca em "Revelar respostas e pontuar".
- Só então as respostas aparecem para todos. Casal completo com respostas iguais ganha os pontos da pergunta.
- O admin pode ajustar pontos (+/−), remover jogadores, criar perguntas e zerar o placar.

## Limites desta versão de teste

- Reiniciar o servidor apaga os jogos (sem banco de dados). Jogos parados somem após 12 h.
- No plano gratuito do Render o serviço dorme sem tráfego e o primeiro acesso demora.
