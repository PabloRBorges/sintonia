// Sintonia — jogo de casais. Servidor único (Node >= 18).
// O estado vive em memória e é gravado a cada mudança no armazenamento
// configurado (ver store.js), de onde é recarregado quando o processo sobe.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createStore } = require('./store');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = (Number(process.env.ROOM_TTL_HOURS) || 168) * 60 * 60 * 1000;
const MAX_ROOMS = 500;
const MAX_PLAYERS = 200;
const rooms = new Map();
let store;

// ---------- persistência ----------
// Cada jogo é gravado inteiro, com um pequeno atraso para juntar mudanças
// seguidas, e nunca com duas gravações do mesmo jogo ao mesmo tempo.
const pending = new Map(); // code -> { timer, chain }
const snapshot = room => { const { clients, ...data } = room; return data; };
function persist(room, delay = 250) {
  if (store.kind === 'memory') return;
  const p = pending.get(room.code) || { timer: null, chain: Promise.resolve() };
  pending.set(room.code, p);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    p.timer = null;
    if (!rooms.has(room.code)) return;
    const data = JSON.parse(JSON.stringify(snapshot(room)));
    p.chain = p.chain.then(() => store.save(data)).catch(e => console.error(`Falha ao gravar o jogo ${room.code}:`, e.message));
  }, delay);
}
async function flushAll() {
  const jobs = [];
  for (const [code, p] of pending) {
    const room = rooms.get(code);
    if (p.timer && room) { clearTimeout(p.timer); p.timer = null; p.chain = p.chain.then(() => store.save(snapshot(room))).catch(e => console.error(e.message)); }
    jobs.push(p.chain);
  }
  await Promise.all(jobs);
}
function dropRoom(code) {
  const room = rooms.get(code);
  if (room) for (const c of room.clients) c.res.end();
  rooms.delete(code);
  const p = pending.get(code);
  if (p) clearTimeout(p.timer);
  pending.delete(code);
  store.remove(code).catch(e => console.error(`Falha ao apagar o jogo ${code}:`, e.message));
}

const DEFAULT_BANK = [
  ['A gente dividiria a sobremesa sem brigar?'],
  ['Nosso primeiro beijo foi no primeiro encontro?'],
  ['A gente toparia morar em outro país?'],
  ['Viagem dos sonhos do casal:', ['Praia', 'Montanha', 'Cidade grande']],
  ['Sexta à noite perfeita para nós:', ['Sair', 'Ficar em casa']],
  ['A gente adotaria mais um bicho de estimação?'],
  ['Nosso casal costuma chegar no horário?'],
  ['Na pizza do casal, vai abacaxi?'],
  ['A gente já brigou por causa do caminho no GPS?'],
  ['Conseguiríamos passar um fim de semana sem celular?'],
  ['A gente dançaria junto na frente de todo mundo?'],
  ['Nosso casal é mais:', ['Manhã', 'Noite']],
].map(([text, options]) => ({ text, options: options || ['Sim', 'Não'], points: 1, used: false }));

const id = (n = 8) => crypto.randomBytes(n).toString('hex');
function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from(crypto.randomBytes(4), b => abc[b % abc.length]).join(''); } while (rooms.has(c));
  return c;
}
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function parseQuestion(b) {
  const text = clean(b.text, 200);
  let options = Array.isArray(b.options) ? b.options.map(o => clean(o, 40)).filter(Boolean) : [];
  options = [...new Set(options)].slice(0, 6);
  if (options.length < 2) options = ['Sim', 'Não'];
  let points = Math.round(Number(b.points));
  if (!Number.isFinite(points) || points < 1) points = 1;
  if (points > 1000) points = 1000;
  return text ? { text, options, points, used: false } : null;
}

function view(room, c) {
  const reveal = room.phase === 'reveal';
  const players = Object.values(room.players);
  const couples = Object.values(room.couples).map(cp => ({
    id: cp.id, name: cp.name, score: cp.score,
    members: players.filter(p => p.coupleId === cp.id)
      .map(p => ({ id: p.id.slice(0, 8), name: p.name, answered: room.answers[p.id] != null })),
  }));
  const pub = {};
  if (reveal) for (const p of players) if (room.answers[p.id] != null) pub[p.id.slice(0, 8)] = room.answers[p.id];
  const v = { code: room.code, phase: room.phase, round: room.round, question: room.question,
    couples, answers: pub, awarded: reveal ? room.awarded : {} };
  if (c.admin) { v.admin = true; v.bank = room.bank; }
  else {
    const p = room.players[c.pid];
    v.me = p ? { id: p.id.slice(0, 8), name: p.name, coupleId: p.coupleId } : null;
    v.myAnswer = p && room.answers[p.id] != null ? room.answers[p.id] : null;
  }
  return v;
}

function broadcast(room) {
  room.touched = Date.now();
  persist(room);
  for (const c of room.clients) c.res.write(`data: ${JSON.stringify(view(room, c))}\n\n`);
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', ch => { d += ch; if (d.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function adminAction(room, b) {
  switch (b.action) {
    case 'ask': {
      let q = null;
      if (Number.isInteger(b.index) && room.bank[b.index]) { room.bank[b.index].used = true; q = room.bank[b.index]; }
      else q = parseQuestion(b);
      if (!q) return 'Pergunta inválida.';
      room.question = { text: q.text, options: q.options, points: q.points };
      room.phase = 'question'; room.round++; room.answers = {}; room.awarded = {};
      return;
    }
    case 'reveal': {
      if (room.phase !== 'question') return 'Não há pergunta aberta.';
      room.awarded = {};
      for (const cp of Object.values(room.couples)) {
        const m = Object.values(room.players).filter(p => p.coupleId === cp.id);
        if (m.length === 2 && room.answers[m[0].id] != null && room.answers[m[0].id] === room.answers[m[1].id]) {
          cp.score += room.question.points; room.awarded[cp.id] = room.question.points;
        }
      }
      room.phase = 'reveal';
      room.history.push({ round: room.round, at: new Date().toISOString(), question: room.question,
        answers: Object.values(room.players).map(p => ({ name: p.name, coupleId: p.coupleId, choice: room.answers[p.id] ?? null })),
        awarded: { ...room.awarded } });
      if (room.history.length > 500) room.history.shift();
      return;
    }
    case 'next': room.phase = 'lobby'; room.question = null; room.answers = {}; room.awarded = {}; return;
    case 'adjust': {
      const cp = room.couples[b.coupleId]; const d = Math.round(Number(b.delta));
      if (!cp || !Number.isFinite(d)) return 'Casal inválido.';
      cp.score += d; return;
    }
    case 'kick': {
      const p = Object.values(room.players).find(x => x.id.slice(0, 8) === b.playerId);
      if (!p) return 'Jogador não encontrado.';
      delete room.players[p.id]; delete room.answers[p.id];
      if (!Object.values(room.players).some(x => x.coupleId === p.coupleId)) delete room.couples[p.coupleId];
      return;
    }
    case 'resetScores': for (const cp of Object.values(room.couples)) cp.score = 0; return;
    case 'addQ': { const q = parseQuestion(b); if (!q) return 'Escreva a pergunta.'; if (room.bank.length >= 200) return 'Limite de perguntas.'; room.bank.push(q); return; }
    case 'delQ': if (!room.bank[b.index]) return 'Pergunta não encontrada.'; room.bank.splice(b.index, 1); return;
    default: return 'Ação desconhecida.';
  }
}

const STATIC = { '/qrcode.js': ['qrcode.js', 'text/javascript; charset=utf-8'] };
function serveFile(res, file, type) {
  fs.readFile(path.join(__dirname, 'public', file), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': file === 'index.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size, storage: store.kind });

    if (p === '/api/rooms' && req.method === 'POST') {
      if (rooms.size >= MAX_ROOMS) return send(res, 503, { error: 'Muitos jogos abertos. Tente mais tarde.' });
      const room = { code: newCode(), adminToken: id(16), touched: Date.now(), phase: 'lobby', round: 0,
        question: null, answers: {}, awarded: {}, couples: {}, players: {}, history: [], clients: new Set(),
        bank: DEFAULT_BANK.map(q => ({ ...q, options: [...q.options] })) };
      rooms.set(room.code, room);
      persist(room, 0);
      return send(res, 200, { code: room.code, adminToken: room.adminToken });
    }

    const m = p.match(/^\/api\/rooms\/([A-Za-z0-9]{4})(?:\/(events|join|answer|admin))?$/);
    if (m) {
      const room = rooms.get(m[1].toUpperCase());
      if (!room) return send(res, 404, { error: 'Jogo não encontrado.' });
      const op = m[2];

      if (!op && req.method === 'GET')
        return send(res, 200, { ok: true, admin: url.searchParams.get('token') === room.adminToken });

      if (op === 'events' && req.method === 'GET') {
        const token = url.searchParams.get('token');
        if (token != null && token !== room.adminToken) return send(res, 403, { error: 'Acesso de admin inválido.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const c = { res, admin: token != null, pid: url.searchParams.get('pid') || '' };
        room.clients.add(c);
        res.write(`retry: 2000\ndata: ${JSON.stringify(view(room, c))}\n\n`);
        const hb = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(hb); room.clients.delete(c); });
        return;
      }

      if (req.method !== 'POST') return send(res, 405, { error: 'Método inválido.' });
      const b = await readBody(req);

      if (op === 'join') {
        const name = clean(b.name, 24);
        if (!name) return send(res, 400, { error: 'Digite seu nome.' });
        if (Object.keys(room.players).length >= MAX_PLAYERS) return send(res, 400, { error: 'Jogo cheio.' });
        let cp = b.coupleId ? room.couples[b.coupleId] : null;
        if (b.coupleId && !cp) return send(res, 400, { error: 'Esse casal não existe mais.' });
        if (cp && Object.values(room.players).filter(x => x.coupleId === cp.id).length >= 2)
          return send(res, 400, { error: 'Esse casal já está completo.' });
        if (!cp) {
          const cname = clean(b.coupleName, 30);
          if (!cname) return send(res, 400, { error: 'Dê um nome ao casal.' });
          cp = { id: id(4), name: cname, score: 0 };
          room.couples[cp.id] = cp;
        }
        const pl = { id: id(12), name, coupleId: cp.id };
        room.players[pl.id] = pl;
        broadcast(room);
        return send(res, 200, { pid: pl.id });
      }

      if (op === 'answer') {
        const pl = room.players[b.pid];
        if (!pl) return send(res, 403, { error: 'Entre no jogo primeiro.' });
        if (room.phase !== 'question') return send(res, 400, { error: 'Nenhuma pergunta aberta.' });
        if (room.answers[pl.id] != null) return send(res, 400, { error: 'Você já respondeu.' });
        if (!Number.isInteger(b.choice) || !room.question.options[b.choice]) return send(res, 400, { error: 'Opção inválida.' });
        room.answers[pl.id] = b.choice;
        broadcast(room);
        return send(res, 200, { ok: true });
      }

      if (op === 'admin') {
        if (b.token !== room.adminToken) return send(res, 403, { error: 'Acesso de admin inválido.' });
        const err = adminAction(room, b);
        if (err) return send(res, 400, { error: err });
        broadcast(room);
        return send(res, 200, { ok: true });
      }
    }

    if (STATIC[p]) return serveFile(res, ...STATIC[p]);
    if (req.method === 'GET' && (p === '/' || /^\/(j|admin)\/[A-Za-z0-9]{4}\/?$/.test(p)))
      return serveFile(res, 'index.html', 'text/html; charset=utf-8');
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Erro interno.' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.touched > ROOM_TTL_MS) dropRoom(code);
}, 10 * 60 * 1000).unref();

async function shutdown() {
  server.close();
  for (const room of rooms.values()) for (const c of room.clients) c.res.end();
  try { await flushAll(); await store.close(); } catch (e) { console.error(e.message); }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

(async () => {
  store = await createStore();
  const now = Date.now();
  for (const data of await store.loadAll().catch(e => { console.error('Falha ao carregar jogos:', e.message); return []; })) {
    if (!data || !data.code || !data.adminToken) continue;
    if (now - (data.touched || 0) > ROOM_TTL_MS) { store.remove(data.code).catch(() => {}); continue; }
    rooms.set(data.code, { answers: {}, awarded: {}, couples: {}, players: {}, history: [], bank: [], ...data, clients: new Set() });
  }
  server.listen(PORT, () => console.log(`Sintonia na porta ${PORT} · armazenamento: ${store.kind} · jogos carregados: ${rooms.size}`));
})();
