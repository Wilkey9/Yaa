// ============================================================
// BASE DE DONNÉES — SQLite (dev) / PostgreSQL (prod)
// ============================================================
const fs = require('fs');
if (!fs.existsSync('./data')) fs.mkdirSync('./data');

const usePostgres = !!process.env.DATABASE_URL;
let db;

if (usePostgres) {
    // === MODE POSTGRESQL (production) ===
    const { Pool } = require('pg');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    function toPgQuery(sql) { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); }

    function wrap(queryable) {
        const wrapped = {
            async get(sql, params = []) { const r = await queryable.query(toPgQuery(sql), params ?? []); return r.rows[0]; },
            async all(sql, params = []) { const r = await queryable.query(toPgQuery(sql), params ?? []); return r.rows; },
            async run(sql, params = []) {
                const r = await queryable.query(toPgQuery(sql), params ?? []);
                return { lastInsertRowid: r.rows[0]?.id, changes: r.rowCount };
            },
            transaction(fn) {
                return async (...args) => {
                    const client = await pool.connect();
                    const tx = wrap(client);
                    try { await client.query('BEGIN'); const result = await fn(tx, ...args); await client.query('COMMIT'); return result; }
                    catch (e) { await client.query('ROLLBACK'); throw e; }
                    finally { client.release(); }
                };
            },
            prepare(sql) {
                const toArray = (p) => p == null ? [] : Array.isArray(p) ? p : [p];
                return {
                    get: (p) => wrapped.get(sql, toArray(p)),
                    all: (p) => wrapped.all(sql, toArray(p)),
                    run: (p) => wrapped.run(sql, toArray(p))
                };
            }
        };
        return wrapped;
    }
    db = wrap(pool);

    async function initSchema() {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, is_owner INTEGER NOT NULL DEFAULT 0, balance DOUBLE PRECISION NOT NULL DEFAULT 1000, last_wheel_spin_at BIGINT, created_at BIGINT NOT NULL);
            CREATE TABLE IF NOT EXISTS groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL, image TEXT, code TEXT UNIQUE NOT NULL, created_by INTEGER NOT NULL, created_at BIGINT NOT NULL);
            CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER NOT NULL REFERENCES groups(id), user_id INTEGER NOT NULL REFERENCES users(id), joined_at BIGINT NOT NULL, PRIMARY KEY (group_id, user_id));
            CREATE TABLE IF NOT EXISTS markets (id SERIAL PRIMARY KEY, title TEXT NOT NULL, category TEXT, subtitle TEXT, image TEXT, market_type TEXT NOT NULL DEFAULT 'binary', group_id INTEGER REFERENCES groups(id), expiry TEXT, resolved INTEGER NOT NULL DEFAULT 0, display_volume_offset DOUBLE PRECISION NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, created_at BIGINT NOT NULL);
            CREATE TABLE IF NOT EXISTS options (id SERIAL PRIMARY KEY, market_id INTEGER NOT NULL REFERENCES markets(id), name TEXT NOT NULL, image TEXT, seed_yes DOUBLE PRECISION NOT NULL DEFAULT 0, seed_no DOUBLE PRECISION NOT NULL DEFAULT 0, real_yes DOUBLE PRECISION NOT NULL DEFAULT 0, real_no DOUBLE PRECISION NOT NULL DEFAULT 0, outcome INTEGER);
            CREATE TABLE IF NOT EXISTS bets (id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), market_id INTEGER NOT NULL REFERENCES markets(id), option_id INTEGER NOT NULL REFERENCES options(id), direction TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL, price_at_bet DOUBLE PRECISION NOT NULL, payout DOUBLE PRECISION NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', seen INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL);
            CREATE TABLE IF NOT EXISTS price_history (id SERIAL PRIMARY KEY, option_id INTEGER NOT NULL REFERENCES options(id), t BIGINT NOT NULL, value DOUBLE PRECISION NOT NULL);
        `);
        await pool.query(`ALTER TABLE markets ADD COLUMN IF NOT EXISTS display_volume_offset DOUBLE PRECISION NOT NULL DEFAULT 0`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_wheel_spin_at BIGINT`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_owner INTEGER NOT NULL DEFAULT 0`);
    }
    module.exports = db; module.exports.pool = pool; module.exports.initSchema = initSchema;

} else {
    // === MODE SQLITE (développement) ===
    const Database = require('better-sqlite3');
    const sqlite = new Database('./data/eirbmarket.db');
    sqlite.pragma('foreign_keys = ON');

    function initSchema() {
        sqlite.exec(`
            CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, is_owner INTEGER NOT NULL DEFAULT 0, balance REAL NOT NULL DEFAULT 1000, last_wheel_spin_at INTEGER, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, image TEXT, code TEXT UNIQUE NOT NULL, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS group_members (group_id INTEGER NOT NULL REFERENCES groups(id), user_id INTEGER NOT NULL REFERENCES users(id), joined_at INTEGER NOT NULL, PRIMARY KEY (group_id, user_id));
            CREATE TABLE IF NOT EXISTS markets (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, category TEXT, subtitle TEXT, image TEXT, market_type TEXT NOT NULL DEFAULT 'binary', group_id INTEGER REFERENCES groups(id), expiry TEXT, resolved INTEGER NOT NULL DEFAULT 0, display_volume_offset REAL NOT NULL DEFAULT 0, created_by INTEGER NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS options (id INTEGER PRIMARY KEY AUTOINCREMENT, market_id INTEGER NOT NULL REFERENCES markets(id), name TEXT NOT NULL, image TEXT, seed_yes REAL NOT NULL DEFAULT 0, seed_no REAL NOT NULL DEFAULT 0, real_yes REAL NOT NULL DEFAULT 0, real_no REAL NOT NULL DEFAULT 0, outcome INTEGER);
            CREATE TABLE IF NOT EXISTS bets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), market_id INTEGER NOT NULL REFERENCES markets(id), option_id INTEGER NOT NULL REFERENCES options(id), direction TEXT NOT NULL, amount REAL NOT NULL, price_at_bet REAL NOT NULL, payout REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', seen INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, option_id INTEGER NOT NULL REFERENCES options(id), t INTEGER NOT NULL, value REAL NOT NULL);
        `);
        try { sqlite.exec('ALTER TABLE markets ADD COLUMN display_volume_offset REAL NOT NULL DEFAULT 0'); } catch (e) {}
        try { sqlite.exec('ALTER TABLE users ADD COLUMN last_wheel_spin_at INTEGER'); } catch (e) {}
        try { sqlite.exec('ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
    }

    db = sqlite;
    module.exports = db;
    module.exports.initSchema = initSchema;
    module.exports.pool = null;
}
