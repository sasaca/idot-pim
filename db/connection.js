// Database connection singleton
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'idot.sqlite');
const schemaPath = path.join(__dirname, 'schema.sql');

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
