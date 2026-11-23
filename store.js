// Persistência dos jogos. Escolhida por variável de ambiente:
//   DATABASE_URL -> PostgreSQL (uma linha por jogo, estado em JSONB)
//   DATA_DIR     -> arquivos JSON em disco (um por jogo)
//   nenhuma      -> só memória (reiniciar apaga tudo)
const fs = require('fs');
const path = require('path');

function memoryStore() {
  return { kind: 'memory', async init() {}, async loadAll() { return []; }, async save() {}, async remove() {}, async close() {} };
}

function fileStore(dir) {
  const roomsDir = path.join(dir, 'rooms');
  const file = code => path.join(roomsDir, `${code}.json`);
  return {
    kind: 'file',
    async init() { await fs.promises.mkdir(roomsDir, { recursive: true }); },
    async loadAll() {
      const out = [];
      for (const f of await fs.promises.readdir(roomsDir)) {
        if (!f.endsWith('.json')) continue;
        try { out.push(JSON.parse(await fs.promises.readFile(path.join(roomsDir, f), 'utf8'))); }
        catch (e) { console.error(`Arquivo de jogo ilegível, ignorado: ${f}`, e.message); }
      }
      return out;
    },
    async save(data) {
      const tmp = file(data.code) + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(data));
      await fs.promises.rename(tmp, file(data.code)); // troca atômica: nunca fica um arquivo pela metade
    },
    async remove(code) { await fs.promises.rm(file(code), { force: true }); },
    async close() {},
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  let pool;
  const open = ssl => new Pool({ connectionString: url, ssl, max: 3, connectionTimeoutMillis: 8000 });
  return {
    kind: 'postgres',
    async init() {
      const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || process.env.PGSSLMODE === 'disable';
      pool = open(local ? false : { rejectUnauthorized: false });
      try { await pool.query('select 1'); }
      catch (e) {
        if (local) throw e;
        await pool.end().catch(() => {});
        pool = open(false); // banco que não aceita SSL
        await pool.query('select 1');
      }
      pool.on('error', e => console.error('Postgres:', e.message));
      await pool.query(`create table if not exists sintonia_rooms (
        code text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now())`);
    },
    async loadAll() { return (await pool.query('select data from sintonia_rooms')).rows.map(r => r.data); },
    async save(data) {
      await pool.query(`insert into sintonia_rooms (code, data, updated_at) values ($1, $2, now())
        on conflict (code) do update set data = excluded.data, updated_at = now()`, [data.code, JSON.stringify(data)]);
    },
    async remove(code) { await pool.query('delete from sintonia_rooms where code = $1', [code]); },
    async close() { await pool.end(); },
  };
}

async function createStore() {
  const wanted = process.env.DATABASE_URL ? pgStore(process.env.DATABASE_URL)
    : process.env.DATA_DIR ? fileStore(process.env.DATA_DIR) : memoryStore();
  try { await wanted.init(); return wanted; }
  catch (e) {
    console.error(`ATENÇÃO: armazenamento "${wanted.kind}" indisponível (${e.message}). Usando só memória.`);
    const m = memoryStore(); m.failed = wanted.kind; return m;
  }
}

module.exports = { createStore };
