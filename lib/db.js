'use strict';
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');

function createPool(env = process.env) {
  return mysql.createPool({
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    dateStrings: false,
    timezone: 'Z', // datetime columns are utc
  });
}

// one statement at a time, split on ";" at end of line
function loadStatements() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((part) => part.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
}

async function ensureSchema(pool) {
  for (const statement of loadStatements()) {
    await pool.query(statement);
  }
}

module.exports = { createPool, ensureSchema };
