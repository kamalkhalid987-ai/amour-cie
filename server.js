require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);
const stripe = require('stripe')(process.env.STRIPE_KEY);
const webpush = require('web-push');
webpush.setVapidDetails(
    'mailto:contact@estimbtppro.fr',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
);

const app = express();
const PORT = process.env.PORT || 3000;

const FREE_LIKES_PER_DAY = 10;      // limite pour les hommes sans abonnement
const PREMIUM_PRICE_EUR = 11;       // prix de l'abonnement mensuel
const TEST_PAYMENT = process.env.TEST_PAYMENT !== 'false'; // mode test : active Premium sans paiement
const LIKE_TYPES = ['restaurant', 'cinema', 'cafe', 'balade', 'voyage', 'cadeau'];

app.use(cors());
app.use(cors());

// Webhook Stripe : doit rester AVANT express.json()
app.post(
    '/api/stripe-webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const signature = req.headers['stripe-signature'];
console.log('WEBHOOK DEBUG:', {
    contentType: req.headers['content-type'],
    bodyIsBuffer: Buffer.isBuffer(req.body),
    bodyLength: req.body ? req.body.length : 0,
    signaturePresente: !!signature
});

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                signature,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error('Signature webhook Stripe invalide :', err.message);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        try {
            if (event.type === 'checkout.session.completed') {
                const session = event.data.object;
                const userId = Number(session.metadata?.user_id);

                if (!userId) {
                    console.error('Webhook Stripe : user_id absent.');
                    return res.status(400).json({
                        error: 'user_id absent des metadata Stripe'
                    });
                }

                let premiumUntil = new Date();
                premiumUntil.setDate(premiumUntil.getDate() + 31);

                if (session.subscription) {
                    const subscription = await stripe.subscriptions.retrieve(
                        session.subscription
                    );

                    if (subscription.current_period_end) {
                        premiumUntil = new Date(
                            subscription.current_period_end * 1000
                        );
                    }
                }

                await run(
                    'UPDATE users SET premium_until = ? WHERE id = ?',
                    [premiumUntil.toISOString(), userId]
                );

                console.log(
                    `Premium Stripe activé pour utilisateur ${userId} jusqu'au ${premiumUntil.toISOString()}`
                );
            }

            return res.json({ received: true });
        } catch (err) {
            console.error('Erreur traitement webhook Stripe :', err.message);
            return res.status(500).json({
                error: 'Erreur traitement webhook Stripe'
            });
        }
    }
);


app.use(express.json({ limit: '15mb' })); // photos et messages vocaux
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Utilitaires base de donnees ----------
const run = (sql, p = []) => new Promise((resolve, reject) => db.run(sql, p, function (e) { e ? reject(e) : resolve({ lastID: this.lastID, changes: this.changes }); }));
const get = (sql, p = []) => new Promise((resolve, reject) => db.get(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const all = (sql, p = []) => new Promise((resolve, reject) => db.all(sql, p, (e, r) => e ? reject(e) : resolve(r)));
const wrap = fn => (req, res) => fn(req, res).catch(e => { console.error('ERREUR :', e.message); res.status(500).json({ error: 'Erreur serveur' }); });

// ---------- Mots de passe (hachage scrypt, sans paquet supplementaire) ----------
function hashPassword(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    const h = crypto.scryptSync(pw, salt, 64).toString('hex');
    return `scrypt$${salt}$${h}`;
}
function verifyPassword(pw, stored) {
    if (!stored.startsWith('scrypt$')) return pw === stored; // ancien compte en clair
    const [, salt, h] = stored.split('$');
    const candidate = crypto.scryptSync(pw, salt, 64);
    const expected = Buffer.from(h, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Limitation des tentatives de connexion (10 echecs / 15 min)
const attempts = new Map();
function tooManyAttempts(key) {
    const now = Date.now();
    const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
    attempts.set(key, list);
    return list.length >= 10;
}
function noteFailure(key) { const l = attempts.get(key) || []; l.push(Date.now()); attempts.set(key, l); }

// ---------- Authentification par jeton ----------
async function auth(req, res, next) {
    try {
        const h = req.headers.authorization || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : '';

        if (!token) {
            return res.status(401).json({ error: 'Non connecté.' });
        }

        // 1. Recherche prioritaire dans Supabase
        const limite = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

        const { data: sessionSupabase, error: sessionError } = await supabase
            .from('ac_sessions')
            .select('user_id, created_at')
            .eq('token', token)
            .gte('created_at', limite)
            .maybeSingle();

        if (!sessionError && sessionSupabase) {
            const { data: userSupabase, error: userError } = await supabase
                .from('ac_users')
                .select('*')
                .eq('id', sessionSupabase.user_id)
                .maybeSingle();

            if (!userError && userSupabase) {
                req.user = userSupabase;
                req.token = token;
                return next();
            }
        }

        // 2. Secours SQLite pendant la migration
        const u = await get(`
            SELECT u.*
            FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ?
              AND s.created_at > datetime('now', '-30 days')
        `, [token]);

        if (!u) {
            return res.status(401).json({ error: 'Session expirée.' });
        }

        req.user = u;
        req.token = token;
        next();

    } catch (e) {
        console.error('ERREUR auth :', e.message);
        res.status(500).json({ error: 'Erreur serveur' });
    }
}
// ---------- Notifications PUSH ----------
app.get('/api/push/public-key', (req, res) => {
    res.json({
        publicKey: process.env.VAPID_PUBLIC_KEY
    });
});
app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
    const subscription = req.body;

    if (
        !subscription ||
        !subscription.endpoint ||
        !subscription.keys ||
        !subscription.keys.p256dh ||
        !subscription.keys.auth
    ) {
        return res.status(400).json({
            error: 'Abonnement push invalide.'
        });
    }

    await run(
        `INSERT INTO push_subscriptions
        (user_id, endpoint, p256dh, auth)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id,
            p256dh = excluded.p256dh,
            auth = excluded.auth`,
        [
            req.user.id,
            subscription.endpoint,
            subscription.keys.p256dh,
            subscription.keys.auth
        ]
    );

    res.json({ ok: true });
}));
// ---------- Profils passes ----------
app.post('/api/profiles/skip', auth, wrap(async (req, res) => {
    const skippedUserId = Number(req.body.skippedUserId);

    if (!Number.isInteger(skippedUserId) || skippedUserId <= 0) {
        return res.status(400).json({
            error: 'Profil invalide.'
        });
    }

    if (skippedUserId === req.user.id) {
        return res.status(400).json({
            error: 'Profil invalide.'
        });
    }

    await run(
        `INSERT OR IGNORE INTO skipped_profiles
         (user_id, skipped_user_id)
         VALUES (?, ?)`,
        [req.user.id, skippedUserId]
    );

    res.json({ ok: true });
}));
// ---------- Fonctions communes ----------
function parsePhotos(user) {
    let p = [];
    try { p = typeof user.photos === 'string' ? JSON.parse(user.photos) : user.photos; } catch (e) { p = []; }
    if (!Array.isArray(p) || p.length === 0 || !p[0]) {
        p = [`https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&size=512&background=random`];
    }
    return p;
}
function isPremium(u) { return !!u.premium_until && new Date(u.premium_until) > new Date(); }
function distKm(a, b) {
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
    const R = 6371, rad = x => x * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
async function likesToday(userId) {
    const r = await get(`SELECT COUNT(*) AS c FROM daily_likes WHERE user_id = ? AND day = date('now','localtime')`, [userId]);
    return r.c;
}
async function isMatch(a, b) {
    const r = await get(
        `SELECT (SELECT COUNT(*) FROM likes WHERE from_id = ? AND to_id = ?) AS ab,
                (SELECT COUNT(*) FROM likes WHERE from_id = ? AND to_id = ?) AS ba,
                (SELECT COUNT(*) FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)) AS bl`,
        [a, b, b, a, a, b, b, a]);
    return r.ab > 0 && r.ba > 0 && r.bl === 0;
}
async function publicMe(u) {
    const premium = isPremium(u);
    const limited = u.gender === 'Homme' && !premium;
    return {
        id: u.id, name: u.name, email: u.email, age: u.age, city: u.city, gender: u.gender, interest: u.interest,
        bio: u.bio, photos: parsePhotos(u), lat: u.lat, lng: u.lng,
        premium, premium_until: u.premium_until,
        likesLimit: limited ? FREE_LIKES_PER_DAY : null,
        likesUsed: limited ? await likesToday(u.id) : 0,
        price: PREMIUM_PRICE_EUR
    };
}

// ---------- Compte ----------
app.post('/api/register', wrap(async (req, res) => {
    const { name, password, age, city, gender, interest, bio, photos, lat, lng } = req.body;
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!name || !email || !password) return res.status(400).json({ error: 'Champs obligatoires manquants.' });
    if (String(password).length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères minimum).' });
    const a = parseInt(age, 10) || 18;
    if (a < 18 || a > 99) return res.status(400).json({ error: 'Vous devez avoir 18 ans ou plus.' });
    if (!['Homme', 'Femme'].includes(gender) || !['Homme', 'Femme'].includes(interest)) return res.status(400).json({ error: 'Genre invalide.' });
    const exists = await get('SELECT id FROM users WHERE lower(email) = ?', [email]);
    if (exists) return res.status(409).json({ error: 'Cet email est déjà utilisé.' });

    const photoList = Array.isArray(photos) ? photos.filter(p => typeof p === 'string' && p.length < 3000000).slice(0, 6) : [];
    const r = await run(
        `INSERT INTO users (name, email, password, age, city, gender, interest, bio, photos, lat, lng)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [String(name).trim().slice(0, 40), email, hashPassword(String(password)), a, String(city || '').slice(0, 80), gender, interest,
         String(bio || '').slice(0, 500), JSON.stringify(photoList), typeof lat === 'number' ? lat : null, typeof lng === 'number' ? lng : null]);
    res.status(201).json({ id: r.lastID });
}));

app.post('/api/login', wrap(async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
        return res.status(400).json({
            error: 'Email et mot de passe requis.'
        });
    }

    const key = req.ip + ':' + email;

    if (tooManyAttempts(key)) {
        return res.status(429).json({
            error: 'Trop de tentatives. Réessayez dans 15 minutes.'
        });
    }

    // 1. Recherche prioritaire dans Supabase
    const { data: userSupabase, error: userSupabaseError } = await supabase
        .from('ac_users')
        .select('*')
        .ilike('email', email)
        .maybeSingle();

    if (userSupabaseError) {
        console.error('ERREUR Supabase login :', userSupabaseError.message);
    }

    if (userSupabase) {
        if (!verifyPassword(password, userSupabase.password)) {
            noteFailure(key);

            return res.status(401).json({
                error: 'Email ou mot de passe incorrect.'
            });
        }

        // Chiffre les anciens mots de passe encore stockés en clair
        if (!userSupabase.password.startsWith('scrypt$')) {
            const { error: passwordUpdateError } = await supabase
                .from('ac_users')
                .update({
                    password: hashPassword(password)
                })
                .eq('id', userSupabase.id);

            if (passwordUpdateError) {
                console.error(
                    'ERREUR mise à jour mot de passe Supabase :',
                    passwordUpdateError.message
                );
            }
        }

        const token = crypto.randomBytes(24).toString('hex');

        const { error: sessionInsertError } = await supabase
            .from('ac_sessions')
            .insert({
                token,
                user_id: userSupabase.id
            });

        if (sessionInsertError) {
            console.error(
                'ERREUR création session Supabase :',
                sessionInsertError.message
            );

            return res.status(500).json({
                error: 'Impossible de créer la session.'
            });
        }

        attempts.delete(key);

        return res.json({
            token,
            id: userSupabase.id,
            name: userSupabase.name
        });
    }

    // 2. Secours SQLite pendant la migration
    const userSqlite = await get(
        'SELECT * FROM users WHERE lower(email) = ?',
        [email]
    );

    if (!userSqlite || !verifyPassword(password, userSqlite.password)) {
        noteFailure(key);

        return res.status(401).json({
            error: 'Email ou mot de passe incorrect.'
        });
    }

    if (!userSqlite.password.startsWith('scrypt$')) {
        await run(
            'UPDATE users SET password = ? WHERE id = ?',
            [hashPassword(password), userSqlite.id]
        );
    }

    const token = crypto.randomBytes(24).toString('hex');

    await run(
        'INSERT INTO sessions (token, user_id) VALUES (?, ?)',
        [token, userSqlite.id]
    );

    attempts.delete(key);

    res.json({
        token,
        id: userSqlite.id,
        name: userSqlite.name
    });
}));

app.post('/api/logout', auth, wrap(async (req, res) => {

    // Supprime d'abord la session dans Supabase
    const { error: supabaseError } = await supabase
        .from('ac_sessions')
        .delete()
        .eq('token', req.token);

    if (supabaseError) {
        console.error('ERREUR logout Supabase :', supabaseError.message);
    }

    // Secours SQLite pendant la migration
    await run(
        'DELETE FROM sessions WHERE token = ?',
        [req.token]
    );

    res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => {
    res.json(await publicMe(req.user));
}));

app.put('/api/profile', auth, wrap(async (req, res) => {
    const { name, age, city, bio, photos, lat, lng, gender, interest } = req.body;
    if (age != null && (age < 18 || age > 99)) return res.status(400).json({ error: 'Âge invalide (18 ans minimum).' });
    if (gender && !['Homme', 'Femme'].includes(gender)) return res.status(400).json({ error: 'Genre invalide.' });
    if (interest && !['Homme', 'Femme'].includes(interest)) return res.status(400).json({ error: 'Recherche invalide.' });
    let photoJson = null;
    if (Array.isArray(photos)) photoJson = JSON.stringify(photos.filter(p => typeof p === 'string' && p.length < 3000000).slice(0, 6));

    await run(
        `UPDATE users SET name = COALESCE(?, name), age = COALESCE(?, age), city = COALESCE(?, city), bio = COALESCE(?, bio),
         photos = COALESCE(?, photos), lat = COALESCE(?, lat), lng = COALESCE(?, lng),
         gender = COALESCE(?, gender), interest = COALESCE(?, interest) WHERE id = ?`,
        [name ? String(name).slice(0, 40) : null, age ?? null, city != null ? String(city).slice(0, 80) : null,
         bio != null ? String(bio).slice(0, 500) : null, photoJson,
         typeof lat === 'number' ? lat : null, typeof lng === 'number' ? lng : null,
         gender || null, interest || null, req.user.id]);
    res.json({ ok: true });
}));

// ---------- Decouvrir : seulement le genre recherche ----------
app.get('/api/users', auth, wrap(async (req, res) => {
    const me = req.user;

    // Profils bloques dans Supabase
    const { data: blocksData, error: blocksError } = await supabase
        .from('ac_blocks')
        .select('blocker_id, blocked_id')
        .or(`blocker_id.eq.${me.id},blocked_id.eq.${me.id}`);

    if (blocksError) {
        console.error('ERREUR blocks Supabase :', blocksError.message);
    }

    const blockedIds = new Set();

    for (const b of (blocksData || [])) {
        if (Number(b.blocker_id) === Number(me.id)) {
            blockedIds.add(Number(b.blocked_id));
        }

        if (Number(b.blocked_id) === Number(me.id)) {
            blockedIds.add(Number(b.blocker_id));
        }
    }

    // Profils deja passes par swipe gauche
    const { data: skippedData, error: skippedError } = await supabase
        .from('ac_skipped_profiles')
        .select('skipped_user_id')
        .eq('user_id', me.id);

    if (skippedError) {
        console.error('ERREUR skipped Supabase :', skippedError.message);
    }

    const skippedIds = new Set(
        (skippedData || []).map(x => Number(x.skipped_user_id))
    );

    // Profils disponibles
    let query = supabase
        .from('ac_users')
        .select('id, name, age, city, bio, photos, gender, interest, lat, lng')
        .neq('id', me.id);

    // Conserve la regle actuelle : seulement le genre recherche
    if (me.interest) {
        query = query.eq('gender', me.interest);
    }

    const { data: usersData, error: usersError } = await query;

    if (usersError) {
        console.error('ERREUR users Supabase :', usersError.message);
        return res.status(500).json({
            error: 'Impossible de charger les profils.'
        });
    }

    const rows = (usersData || []).filter(u =>
        !blockedIds.has(Number(u.id)) &&
        !skippedIds.has(Number(u.id))
    );

    res.json(rows.map(u => {
        const distance = distKm(me, u);

        const {
            lat,
            lng,
            ...safe
        } = u;

        return {
            ...safe,
            photos: parsePhotos(u),
            distance
        };
    }));
}));

// ---------- Likes ----------
app.post('/api/like', auth, wrap(async (req, res) => {
    const me = req.user;
    const toId = parseInt(req.body.toId, 10);
    const type = req.body.type;
    if (!toId || toId === me.id || !LIKE_TYPES.includes(type)) return res.status(400).json({ error: 'Requête invalide.' });
    const target = await get('SELECT id FROM users WHERE id = ?', [toId]);
    if (!target) return res.status(404).json({ error: 'Profil introuvable.' });
    const blocked = await get(
        `SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)`,
        [me.id, toId, toId, me.id]);
    if (blocked) return res.status(403).json({ error: 'Action impossible.' });

const existing = await get(
    'SELECT id FROM likes WHERE from_id = ? AND to_id = ?',
    [me.id, toId]
);

if (existing) {
    return res.json({
        liked: true,
        alreadyLiked: true
    });
}

    // Limite quotidienne : hommes sans abonnement uniquement
    if (me.gender === 'Homme' && !isPremium(me)) {
        const already = await get(`SELECT 1 AS x FROM daily_likes WHERE user_id = ? AND to_id = ? AND day = date('now','localtime')`, [me.id, toId]);
        if (!already && (await likesToday(me.id)) >= FREE_LIKES_PER_DAY) {
            return res.status(402).json({
                code: 'LIMIT',
                error: `Limite de ${FREE_LIKES_PER_DAY} likes par jour atteinte. Passez Premium (${PREMIUM_PRICE_EUR} €/mois) pour des likes illimités.`
            });
        }
    }

    await run('INSERT INTO likes (from_id, to_id, type) VALUES (?, ?, ?)', [me.id, toId, type]);
    await run(`INSERT OR IGNORE INTO daily_likes (user_id, to_id, day) VALUES (?, ?, date('now','localtime'))`, [me.id, toId]);
// Notification PUSH : nouveau like reçu
const pushSubs = await all(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    [toId]
);

for (const sub of pushSubs) {
    try {
        await webpush.sendNotification(
            {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth
                }
            },
            JSON.stringify({
                title: '❤️ Nouveau like',
                body: `${me.name} vous a envoyé un like.`,
                url: '/#likes'
            })
        );
    } catch (err) {
        console.error('Erreur notification PUSH like :', err.message);
    }
}
    const back = await get('SELECT 1 AS m FROM likes WHERE from_id = ? AND to_id = ?', [toId, me.id]);
    res.json({ liked: true, match: !!back });
}));

app.get('/api/activity', auth, wrap(async (req, res) => {
    const me = req.user.id;
    const sent = await all('SELECT to_id, type FROM likes WHERE from_id = ?', [me]);
    const received = await all(
        `SELECT l.type, l.from_id, u.name, u.photos FROM likes l JOIN users u ON u.id = l.from_id
         WHERE l.to_id = ? AND l.from_id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
         ORDER BY l.id DESC`, [me, me]);
    const matches = await all(
        `SELECT id, name, city, photos FROM users
         WHERE id IN (SELECT to_id FROM likes WHERE from_id = ?) AND id IN (SELECT from_id FROM likes WHERE to_id = ?)
         AND id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
         AND id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)`, [me, me, me, me]);
    res.json({
        sent,
        received: received.map(r => ({ ...r, photos: parsePhotos(r) })),
        matches: matches.map(m => ({ ...m, photos: parsePhotos(m) }))
    });
}));

// ---------- Messagerie (entre personnes qui se sont likees) ----------
app.get('/api/conversations', auth, wrap(async (req, res) => {
    const me = req.user.id;
    const rows = await all(
        `SELECT u.id, u.name, u.city, u.photos,
            (SELECT kind FROM messages m WHERE (m.from_id = u.id AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = u.id) ORDER BY m.id DESC LIMIT 1) AS last_kind,
            (SELECT CASE WHEN kind = 'audio' THEN '' ELSE substr(content, 1, 80) END FROM messages m WHERE (m.from_id = u.id AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = u.id) ORDER BY m.id DESC LIMIT 1) AS last_text,
            (SELECT COUNT(*) FROM messages m WHERE m.from_id = u.id AND m.to_id = ? AND m.read_at IS NULL) AS unread
         FROM users u
         WHERE u.id IN (SELECT to_id FROM likes WHERE from_id = ?) AND u.id IN (SELECT from_id FROM likes WHERE to_id = ?)
         AND u.id NOT IN (SELECT blocked_id FROM blocks WHERE blocker_id = ?)
         AND u.id NOT IN (SELECT blocker_id FROM blocks WHERE blocked_id = ?)`,
        [me, me, me, me, me, me, me, me, me]);
    res.json(rows.map(r => ({ ...r, photos: parsePhotos(r) })));
}));

app.get('/api/messages', auth, wrap(async (req, res) => {
    const me = req.user.id;
    const other = parseInt(req.query.with, 10);
    const after = parseInt(req.query.after, 10) || 0;
    if (!other || !(await isMatch(me, other))) return res.status(403).json({ error: 'Vous devez vous être likés mutuellement.' });
    const rows = await all(
        `SELECT id, from_id, to_id, kind, content, created_at FROM messages
         WHERE id > ? AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) ORDER BY id ASC LIMIT 200`,
        [after, me, other, other, me]);
    await run('UPDATE messages SET read_at = CURRENT_TIMESTAMP WHERE to_id = ? AND from_id = ? AND read_at IS NULL', [me, other]);
    res.json(rows);
}));

app.post('/api/messages', auth, wrap(async (req, res) => {
    const me = req.user.id;
    const toId = parseInt(req.body.toId, 10);
    const kind = req.body.kind;
    const content = String(req.body.content || '');
    if (!toId || !(await isMatch(me, toId))) return res.status(403).json({ error: 'Vous devez vous être likés mutuellement.' });
    if (kind === 'text') {
        if (!content.trim() || content.length > 2000) return res.status(400).json({ error: 'Message invalide.' });
    } else if (kind === 'audio') {
        if (!content.startsWith('data:audio/') || content.length > 8000000) return res.status(400).json({ error: 'Message vocal invalide ou trop long.' });
   } else if (['image', 'video', 'pdf', 'file'].includes(kind)) {
    if (!content || content.length > 14000000) {
        return res.status(400).json({ error: 'Fichier invalide ou trop volumineux.' });
    }
} else {
    return res.status(400).json({ error: 'Type de message invalide.' });
}
    const r = await run('INSERT INTO messages (from_id, to_id, kind, content) VALUES (?, ?, ?, ?)', [me, toId, kind, kind === 'text' ? content.trim() : content]);
// Notification PUSH : nouveau message reçu
const sender = await get(
    'SELECT name FROM users WHERE id = ?',
    [me]
);

const pushSubs = await all(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    [toId]
);


for (const sub of pushSubs) {
    try {
        await webpush.sendNotification(
            {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth
                }
            },
            JSON.stringify({
                title: '💬 Nouveau message',
                body: `${sender?.name || 'Quelqu’un'} vous a envoyé un message.`,
                url: '/#messages'
            })
        );
    } catch (err) {
        console.error(
            'Erreur notification PUSH message :',
            err.message
        );
    }
}
    res.status(201).json({ id: r.lastID });
}));

// ---------- Appels vocaux / video (signalisation WebRTC) ----------
app.post('/api/signal', auth, wrap(async (req, res) => {
    const me = req.user.id;
    const toId = parseInt(req.body.toId, 10);
    const type = req.body.type;
    if (!['offer', 'answer', 'ice', 'hangup', 'decline'].includes(type)) return res.status(400).json({ error: 'Signal invalide.' });
    if (!toId || !(await isMatch(me, toId))) return res.status(403).json({ error: 'Appel impossible.' });
    const data = JSON.stringify(req.body.data ?? null);
    if (data.length > 100000) return res.status(400).json({ error: 'Signal trop gros.' });
    await run('INSERT INTO signals (from_id, to_id, type, data) VALUES (?, ?, ?, ?)', [me, toId, type, data]);
// Notification PUSH : appel entrant
if (type === 'offer') {
    const offerData = req.body.data || {};
    const caller = await get(
        'SELECT name FROM users WHERE id = ?',
        [me]
    );

    const pushSubs = await all(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
        [toId]
    );

    const isVideo = offerData.kind === 'video';

    for (const sub of pushSubs) {
        try {
            await webpush.sendNotification(
                {
                    endpoint: sub.endpoint,
                    keys: {
                        p256dh: sub.p256dh,
                        auth: sub.auth
                    }
                },
                JSON.stringify({
                    title: isVideo ? '🎥 Appel vidéo entrant' : '📞 Appel entrant',
                    body: `${caller?.name || 'Quelqu’un'} vous appelle.`,
                    url: '/#messages'
                })
            );
        } catch (err) {
            console.error(
                'Erreur notification PUSH appel :',
                err.message
            );
        }
    }
}
    res.json({ ok: true });
}));

app.get('/api/signal', auth, wrap(async (req, res) => {
    const me = req.user.id;
    await run(`DELETE FROM signals WHERE created_at < datetime('now', '-2 minutes')`);
    const rows = await all('SELECT id, from_id, type, data FROM signals WHERE to_id = ? ORDER BY id ASC', [me]);
    if (rows.length) await run(`DELETE FROM signals WHERE to_id = ? AND id <= ?`, [me, rows[rows.length - 1].id]);
    res.json(rows.map(r => ({ id: r.id, from_id: r.from_id, type: r.type, data: r.data ? JSON.parse(r.data) : null })));
}));

// ---------- Blocage ----------
app.post('/api/block', auth, wrap(async (req, res) => {
    const toId = parseInt(req.body.userId, 10);
    if (!toId || toId === req.user.id) return res.status(400).json({ error: 'Requête invalide.' });
    await run('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)', [req.user.id, toId]);
    res.json({ ok: true });
}));

// ---------- Abonnement Premium ----------
app.post('/api/subscribe', auth, wrap(async (req, res) => {
    // MODE TEST LOCAL : active Premium 30 jours sans paiement
    if (TEST_PAYMENT) {
        const base = isPremium(req.user)
            ? new Date(req.user.premium_until)
            : new Date();

        base.setDate(base.getDate() + 30);

        await run(
            'UPDATE users SET premium_until = ? WHERE id = ?',
            [base.toISOString(), req.user.id]
        );

        return res.json({
            ok: true,
            premium_until: base.toISOString(),
            test: true
        });
    }

    // MODE PRODUCTION : création du paiement Stripe Checkout
    if (!process.env.STRIPE_PRICE_ID) {
        return res.status(500).json({
            error: 'Le tarif Stripe Premium n’est pas configuré.'
        });
    }

    const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',

        line_items: [
            {
                price: process.env.STRIPE_PRICE_ID,
                quantity: 1
            }
        ],

        customer_email: req.user.email,

        metadata: {
            user_id: String(req.user.id)
        },

        subscription_data: {
            metadata: {
                user_id: String(req.user.id)
            }
        },

        success_url: `${origin}/?premium=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?premium=cancel`
    });

    return res.json({
        ok: true,
        test: false,
        url: session.url
    });
}));
const server = app.listen(PORT, () => {
    console.log(`Serveur demarre sur http://localhost:${PORT}`);
    if (TEST_PAYMENT) console.log('Attention : abonnement Premium en MODE TEST (aucun paiement reel).');
});

server.on('error', (err) => { console.error('ERREUR SERVEUR :', err.message); });
process.on('uncaughtException', (err) => { console.error('ERREUR NON GEREE :', err); });
process.on('unhandledRejection', (err) => { console.error('PROMESSE REJETEE :', err); });
