require('dotenv').config();
const mysql = require('mysql2/promise');

// No default/fallback DB password — a hardcoded default here would mean
// every fresh install silently uses the same known password until someone
// thinks to change it. Fail loudly instead and make the operator set one.
if (!process.env.DB_PASSWORD && !process.env.DB_PASS) {
  console.error(
    '\n  ✗  DB_PASSWORD is not set in .env.\n' +
    '     Copy .env.example to .env and set a real password for your MariaDB user.\n'
  );
  process.exit(1);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || '192.0.2.4',
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  user: process.env.DB_USER || 'webssh',
  password: process.env.DB_PASSWORD || process.env.DB_PASS,
  database: process.env.DB_NAME || 'webssh',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function addColumnIfMissing(conn, table, column, definition) {
  try {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME') throw e; // 1060 — column already exists, fine
  }
}

async function init() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS ssh_devices (
        id INT AUTO_INCREMENT PRIMARY KEY,
        device_name VARCHAR(100) NOT NULL,
        ip_address VARCHAR(100) NOT NULL,
        username VARCHAR(100) NOT NULL,
        password VARCHAR(255) DEFAULT '',
        port INT DEFAULT 22,
        pinned TINYINT(1) NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migration for installs from before pinned/sort_order existed. Wrapped
    // per-column so it's safe to run on every boot — "column already
    // exists" (MySQL/MariaDB error 1060) is swallowed, anything else isn't.
    await addColumnIfMissing(conn, 'ssh_devices', 'pinned', 'TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing(conn, 'ssh_devices', 'sort_order', 'INT NOT NULL DEFAULT 0');

    // SSH key authentication (per host). Existing rows keep auth_type='password'.
    await addColumnIfMissing(conn, 'ssh_devices', 'auth_type', "VARCHAR(20) NOT NULL DEFAULT 'password'");
    await addColumnIfMissing(conn, 'ssh_devices', 'private_key', 'MEDIUMTEXT NULL');
    await addColumnIfMissing(conn, 'ssh_devices', 'key_passphrase', 'VARCHAR(1024) NULL');
    await addColumnIfMissing(conn, 'ssh_devices', 'public_key', 'TEXT NULL');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ssh_macros (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        command TEXT DEFAULT ''
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS ssh_buckets (
        id INT PRIMARY KEY,
        content TEXT DEFAULT ''
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const [existingMacros] = await conn.query('SELECT COUNT(*) as cnt FROM ssh_macros');
    if (existingMacros[0].cnt === 0) {
      await conn.query(`
        INSERT INTO ssh_macros (name, command) VALUES
          ('Macro 1', ''),
          ('Macro 2', ''),
          ('Macro 3', ''),
          ('Macro 4', ''),
          ('Macro 5', '')
      `);
    }

    const [existingBuckets] = await conn.query('SELECT COUNT(*) as cnt FROM ssh_buckets');
    if (existingBuckets[0].cnt === 0) {
      await conn.query(`
        INSERT INTO ssh_buckets (id, content) VALUES
          (1, ''), (2, ''), (3, ''), (4, ''), (5, '')
      `);
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, init };
