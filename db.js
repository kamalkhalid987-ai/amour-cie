const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            age INTEGER DEFAULT 18,
            city TEXT DEFAULT '',
            gender TEXT DEFAULT '',
            interest TEXT DEFAULT '',
            bio TEXT DEFAULT '',
            photos TEXT DEFAULT '[]'
        )
    `);

    // Colonnes ajoutees apres coup (l'erreur est ignoree si elles existent deja)
    db.run('ALTER TABLE users ADD COLUMN lat REAL', () => {});
    db.run('ALTER TABLE users ADD COLUMN lng REAL', () => {});
    db.run('ALTER TABLE users ADD COLUMN premium_until TEXT', () => {});

    db.run(`
        CREATE TABLE IF NOT EXISTS likes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(from_id, to_id, type)
        )
    `);

    // Journal des profils likes par jour (pour la limite quotidienne)
    db.run(`
        CREATE TABLE IF NOT EXISTS daily_likes (
            user_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL,
            day TEXT NOT NULL,
            UNIQUE(user_id, to_id, day)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL,
            kind TEXT NOT NULL DEFAULT 'text',
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            read_at TEXT
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL,
            type TEXT NOT NULL,
            data TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS blocks (
            blocker_id INTEGER NOT NULL,
            blocked_id INTEGER NOT NULL,
            UNIQUE(blocker_id, blocked_id)
        )
    `);
db.run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

db.run(`
    CREATE TABLE IF NOT EXISTS skipped_profiles (
        user_id INTEGER NOT NULL,
        skipped_user_id INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, skipped_user_id)
    )
`);

});

module.exports = db;
