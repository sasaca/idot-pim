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

module.exports = db;
