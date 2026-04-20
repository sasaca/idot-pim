// Database connection singleton
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'idot.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');
// Make sure the DB's containing directory exists — important when DB_PATH
// points to a freshly-mounted persistent volume on the host.
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const firstRun = !fs.existsSync(dbPath);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

if (firstRun) {
  const schema = fs.readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  console.log('[db] schema initialized');
}

// ---------- Migration runner ----------
// Applies every *.sql file under migrations/ that hasn't been applied yet,
// tracking progress in a `schema_migrations` table. Errors that look like
// "duplicate column" / "already exists" are absorbed so dev boxes that ran
// the migrations manually (e.g. via `sqlite3 < migrations/00X.sql`) get their
// history stamped without double-applying the changes.
const migrationsDir = path.join(__dirname, '..', 'migrations');
if (fs.existsSync(migrationsDir)) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    db.prepare(`SELECT filename FROM schema_migrations`).all().map((r) => r.filename)
  );
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      db.exec(sql);
      db.prepare(`INSERT INTO schema_migrations (filename) VALUES (?)`).run(file);
      console.log(`[migrate] applied ${file}`);
    } catch (e) {
      // Failed mid-BEGIN leaves SQLite's implicit transaction open;
      // explicitly rollback before moving on so the next migration's BEGIN
      // doesn't trip "cannot start a transaction within a transaction".
      if (db.inTransaction) { try { db.exec('ROLLBACK'); } catch {} }
      const msg = String((e && e.message) || e);
      if (/duplicate column|already exists/i.test(msg)) {
        db.prepare(`INSERT OR IGNORE INTO schema_migrations (filename) VALUES (?)`).run(file);
        console.log(`[migrate] ${file} absorbed (${msg})`);
      } else {
        console.error(`[migrate] FAILED ${file}: ${msg}`);
        throw e;
      }
    }
  }
}

module.exports = db;
