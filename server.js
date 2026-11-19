require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const stripe = require('stripe')(process.env.STRIPE_KEY);
const webpush = require('web-push');
const admin = require('firebase-admin');
const fs = require('fs');
const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY'
];
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`Variable manquante : ${key}`);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);
let firebaseReady = false;

const firebaseServiceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  '/etc/secrets/firebase-service-account.json';

try {
  if (fs.existsSync(firebaseServiceAccountPath)) {
    const firebaseServiceAccount = JSON.parse(
      fs.readFileSync(firebaseServiceAccountPath, 'utf8')
    );

    admin.initializeApp({
      credential: admin.credential.cert(firebaseServiceAccount)
    });

    firebaseReady = true;
    console.log('Firebase Admin initialisé.');
  } else {
    console.warn('Clé Firebase absente :', firebaseServiceAccountPath);
  }
} catch (err) {
  console.error('Initialisation Firebase Admin impossible :', err.message);
}

webpush.setVapidDetails(
  'mailto:contact@estimbtppro.fr',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const app = express();
const PORT = process.env.PORT || 3000;
const FREE_LIKES_PER_DAY = 10;
const PREMIUM_PRICE_EUR = 11;
const TEST_PAYMENT = process.env.TEST_PAYMENT !== 'false';
const LIKE_TYPES = ['restaurant', 'cinema', 'cafe', 'balade', 'voyage', 'cadeau'];
const MESSAGE_KINDS = ['text', 'audio', 'image', 'video', 'pdf', 'file'];
const SIGNAL_TYPES = ['offer', 'answer', 'ice', 'hangup', 'decline'];

app.use(cors());

app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Doit rester avant express.json()


// Doit rester avant express.json()
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId = Number(session.metadata?.user_id);
      if (!userId) return res.status(400).json({ error: 'user_id absent' });

      let premiumUntil = new Date();
      premiumUntil.setDate(premiumUntil.getDate() + 31);

      if (session.subscription) {
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        if (subscription.current_period_end) {
          premiumUntil = new Date(subscription.current_period_end * 1000);
        }
      }

      const { error } = await supabase
        .from('ac_users')
        .update({ premium_until: premiumUntil.toISOString() })
        .eq('id', userId);
      if (error) throw error;
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook Stripe :', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(err => {
  console.error('ERREUR :', err);
  if (!res.headersSent) res.status(500).json({ error: 'Erreur serveur' });
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) return password === stored;
  const [, salt, hash] = stored.split('$');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const values = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, values);
  return values.length >= 10;
}
function noteFailure(key) {
  const values = attempts.get(key) || [];
  values.push(Date.now());
  attempts.set(key, values);
}

function parsePhotos(user) {
  let photos = [];
  try {
    photos = typeof user.photos === 'string' ? JSON.parse(user.photos) : user.photos;
  } catch (_) {
    photos = [];
  }
  if (!Array.isArray(photos) || !photos.length || !photos[0]) {
    photos = [`https://ui-avatars.com/api/?name=${encodeURIComponent(user.name || 'Profil')}&size=512&background=random`];
  }
  return photos;
}

function isPremium(user) {
  return Boolean(user.premium_until) && new Date(user.premium_until) > new Date();
}

function parisDay() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function distKm(a, b) {
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null;
  const R = 6371;
  const rad = x => x * Math.PI / 180;
  const dLat = rad(Number(b.lat) - Number(a.lat));
  const dLng = rad(Number(b.lng) - Number(a.lng));
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(Number(a.lat))) * Math.cos(rad(Number(b.lat))) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

async function getUser(id) {
  const { data, error } = await supabase.from('ac_users').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function likesToday(userId) {
  const { count, error } = await supabase
    .from('ac_daily_likes')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('day', parisDay());
  if (error) throw error;
  return count || 0;
}

async function publicMe(user) {
  const premium = isPremium(user);
  const limited = user.gender === 'Homme' && !premium;
  return {
    id: Number(user.id), name: user.name, email: user.email, age: user.age,
    city: user.city, gender: user.gender, interest: user.interest, bio: user.bio,
    photos: parsePhotos(user), lat: user.lat, lng: user.lng,
    premium, premium_until: user.premium_until,
    likesLimit: limited ? FREE_LIKES_PER_DAY : null,
    likesUsed: limited ? await likesToday(user.id) : 0,
    price: PREMIUM_PRICE_EUR
  };
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Non connecté.' });

    const limit = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: session, error } = await supabase
      .from('ac_sessions')
      .select('user_id, created_at')
      .eq('token', token)
      .gte('created_at', limit)
      .maybeSingle();
    if (error || !session) return res.status(401).json({ error: 'Session expirée.' });

    const user = await getUser(session.user_id);
    if (!user) return res.status(401).json({ error: 'Compte introuvable.' });

    req.user = user;
    req.token = token;
    next();
  } catch (err) {
    console.error('Auth :', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

async function getBlockedIds(userId) {
  const { data, error } = await supabase
    .from('ac_blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`);
  if (error) throw error;
  const ids = new Set();
  for (const row of data || []) {
    if (Number(row.blocker_id) === Number(userId)) ids.add(Number(row.blocked_id));
    if (Number(row.blocked_id) === Number(userId)) ids.add(Number(row.blocker_id));
  }
  return ids;
}

async function isMatch(a, b) {
  const blocked = await getBlockedIds(a);
  if (blocked.has(Number(b))) return false;

  const { data, error } = await supabase
    .from('ac_likes')
    .select('from_id,to_id')
    .or(`and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`);
  if (error) throw error;
  const ab = (data || []).some(x => Number(x.from_id) === Number(a) && Number(x.to_id) === Number(b));
  const ba = (data || []).some(x => Number(x.from_id) === Number(b) && Number(x.to_id) === Number(a));
  return ab && ba;
}

async function sendPush(userId, payload) {
  const { data, error } = await supabase
    .from('ac_push_subscriptions')
    .select('endpoint,p256dh,auth')
    .eq('user_id', userId);
  if (error) {
    console.error('Push subscriptions :', error.message);
    return;
  }

  for (const sub of data || []) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      }, JSON.stringify(payload));
    } catch (err) {
      console.error('Push :', err.message);
      if ([404, 410].includes(err.statusCode)) {
        await supabase.from('ac_push_subscriptions').delete().eq('endpoint', sub.endpoint);
      }
    }
  }
}
async function sendFcmPush(userId, payload) {
  if (!firebaseReady) {
    console.warn('FCM ignoré : Firebase Admin non initialisé.');
    return;
  }

  const { data, error } = await supabase
    .from('ac_fcm_tokens')
    .select('token')
    .eq('user_id', userId);

  if (error) {
    console.error('FCM tokens :', error.message);
    return;
  }

  for (const row of data || []) {
    try {
      await admin.messaging().send({
        token: row.token,
        notification: {
          title: String(payload.title || 'Amour & Cie'),
          body: String(payload.body || '')
        },
        data: {
          url: String(payload.url || '/')
        },
        android: {
          priority: 'high',
          notification: {
            channelId: 'calls',
            priority: 'high',
            sound: 'default'
          }
        }
      });

      console.log('FCM envoyé à user', userId);
    } catch (err) {
      console.error('FCM :', err.message);

      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token'
      ) {
        await supabase
          .from('ac_fcm_tokens')
          .delete()
          .eq('token', row.token);
      }
    }
  }
}
app.post('/api/fcm/register', auth, wrap(async (req, res) => {
  const fcmToken = String(req.body?.token || '').trim();

  if (!fcmToken) {
    return res.status(400).json({ error: 'Token FCM manquant.' });
  }

  const { error } = await supabase
    .from('ac_fcm_tokens')
    .upsert({
      user_id: req.user.id,
      token: fcmToken,
      updated_at: new Date().toISOString()
    }, { onConflict: 'token' });

  if (error) throw error;

  res.json({ ok: true });
}));


app.get('/api/push/public-key', (_req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }));

app.post('/api/push/subscribe', auth, wrap(async (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return res.status(400).json({ error: 'Abonnement push invalide.' });
  }
  const { error } = await supabase.from('ac_push_subscriptions').upsert({
    user_id: req.user.id,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth
  }, { onConflict: 'endpoint' });
  if (error) throw error;
  res.json({ ok: true });
}));

app.post('/api/register', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim().slice(0, 40);
  const age = parseInt(req.body.age, 10) || 18;
  const gender = req.body.gender;
  const interest = req.body.interest;

  if (!name || !email || !password) return res.status(400).json({ error: 'Champs obligatoires manquants.' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères minimum).' });
  if (age < 18 || age > 99) return res.status(400).json({ error: 'Vous devez avoir entre 18 et 99 ans.' });
  if (!['Homme', 'Femme'].includes(gender) || !['Homme', 'Femme'].includes(interest)) {
    return res.status(400).json({ error: 'Genre invalide.' });
  }

  const photos = Array.isArray(req.body.photos)
    ? req.body.photos.filter(x => typeof x === 'string' && x.length < 3000000).slice(0, 6)
    : [];
  const lat = Number(req.body.lat);
  const lng = Number(req.body.lng);

  const { data, error } = await supabase.from('ac_users').insert({
    name, email, password: hashPassword(password), age,
    city: String(req.body.city || '').trim().slice(0, 80),
    gender, interest,
    bio: String(req.body.bio || '').trim().slice(0, 500),
    photos: JSON.stringify(photos),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null
  }).select('id').single();

  if (error?.code === '23505') return res.status(409).json({ error: 'Cet email est déjà utilisé.' });
  if (error) throw error;
  res.status(201).json({ id: data.id });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis.' });

  const key = `${req.ip}:${email}`;
  if (tooManyAttempts(key)) return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });

  const { data: user, error } = await supabase.from('ac_users').select('*').ilike('email', email).maybeSingle();
  if (error) throw error;
  if (!user || !verifyPassword(password, user.password)) {
    noteFailure(key);
    return res.status(401).json({ error: 'Email ou mot de passe incorrect.' });
  }

  if (!user.password.startsWith('scrypt$')) {
    const { error: updateError } = await supabase
      .from('ac_users').update({ password: hashPassword(password) }).eq('id', user.id);
    if (updateError) throw updateError;
  }

  const token = crypto.randomBytes(24).toString('hex');
  const { error: sessionError } = await supabase.from('ac_sessions').insert({ token, user_id: user.id });
  if (sessionError) throw sessionError;
  attempts.delete(key);
  res.json({ token, id: user.id, name: user.name });
}));

app.post('/api/logout', auth, wrap(async (req, res) => {
  const { error } = await supabase.from('ac_sessions').delete().eq('token', req.token);
  if (error) throw error;
  res.json({ ok: true });
}));

app.get('/api/me', auth, wrap(async (req, res) => res.json(await publicMe(req.user))));

app.put('/api/profile', auth, wrap(async (req, res) => {
  const update = {};
  if (req.body.name != null) update.name = String(req.body.name).trim().slice(0, 40);
  if (req.body.city != null) update.city = String(req.body.city).trim().slice(0, 80);
  if (req.body.bio != null) update.bio = String(req.body.bio).trim().slice(0, 500);
  if (req.body.age != null) {
    const age = Number(req.body.age);
    if (age < 18 || age > 99) return res.status(400).json({ error: 'Âge invalide.' });
    update.age = age;
  }
  if (req.body.gender != null) {
    if (!['Homme', 'Femme'].includes(req.body.gender)) return res.status(400).json({ error: 'Genre invalide.' });
    update.gender = req.body.gender;
  }
  if (req.body.interest != null) {
    if (!['Homme', 'Femme'].includes(req.body.interest)) return res.status(400).json({ error: 'Recherche invalide.' });
    update.interest = req.body.interest;
  }
  if (Array.isArray(req.body.photos)) {
    update.photos = JSON.stringify(req.body.photos.filter(x => typeof x === 'string' && x.length < 3000000).slice(0, 6));
  }
  if (typeof req.body.lat === 'number') update.lat = req.body.lat;
  if (typeof req.body.lng === 'number') update.lng = req.body.lng;

  const { error } = await supabase.from('ac_users').update(update).eq('id', req.user.id);
  if (error) throw error;
  res.json({ ok: true });
}));

app.delete('/api/account', auth, wrap(async (req, res) => {
  const id = Number(req.user.id);
  await Promise.all([
    supabase.from('ac_sessions').delete().eq('user_id', id),
    supabase.from('ac_likes').delete().or(`from_id.eq.${id},to_id.eq.${id}`),
    supabase.from('ac_daily_likes').delete().or(`user_id.eq.${id},to_id.eq.${id}`),
    supabase.from('ac_messages').delete().or(`from_id.eq.${id},to_id.eq.${id}`),
    supabase.from('ac_signals').delete().or(`from_id.eq.${id},to_id.eq.${id}`),
    supabase.from('ac_blocks').delete().or(`blocker_id.eq.${id},blocked_id.eq.${id}`),
    supabase.from('ac_push_subscriptions').delete().eq('user_id', id),
    supabase.from('ac_skipped_profiles').delete().or(`user_id.eq.${id},skipped_user_id.eq.${id}`)
  ]);
  const { error } = await supabase.from('ac_users').delete().eq('id', id);
  if (error) throw error;
  res.json({ ok: true });
}));

app.post('/api/profiles/skip', auth, wrap(async (req, res) => {
  const skipped = Number(req.body.skippedUserId);
  if (!Number.isInteger(skipped) || skipped <= 0 || skipped === Number(req.user.id)) {
    return res.status(400).json({ error: 'Profil invalide.' });
  }
  const { error } = await supabase.from('ac_skipped_profiles').upsert({
    user_id: req.user.id, skipped_user_id: skipped
  }, { onConflict: 'user_id,skipped_user_id', ignoreDuplicates: true });
  if (error) throw error;
  res.json({ ok: true });
}));

app.get('/api/users', auth, wrap(async (req, res) => {
  const me = req.user;
  const blocked = await getBlockedIds(me.id);

  const { data: skipped, error: skipError } = await supabase
    .from('ac_skipped_profiles').select('skipped_user_id').eq('user_id', me.id);
  if (skipError) throw skipError;
  const skippedIds = new Set((skipped || []).map(x => Number(x.skipped_user_id)));

  let query = supabase
    .from('ac_users')
    .select('id,name,age,city,bio,photos,gender,interest,lat,lng')
    .neq('id', me.id);
  if (me.interest) query = query.eq('gender', me.interest);
  const { data, error } = await query;
  if (error) throw error;

  res.json((data || [])
    .filter(u => !blocked.has(Number(u.id)) && !skippedIds.has(Number(u.id)))
    .map(u => {
      const { lat, lng, ...safe } = u;
      return { ...safe, photos: parsePhotos(u), distance: distKm(me, u) };
    }));
}));

app.post('/api/like', auth, wrap(async (req, res) => {
  const fromId = Number(req.user.id);
  const toId = Number(req.body.toId);
  const type = req.body.type;
  if (!toId || toId === fromId || !LIKE_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Requête invalide.' });
  }

  const target = await getUser(toId);
  if (!target) return res.status(404).json({ error: 'Profil introuvable.' });
  const blocked = await getBlockedIds(fromId);
  if (blocked.has(toId)) return res.status(403).json({ error: 'Action impossible.' });

  const { data: existing, error: existingError } = await supabase
    .from('ac_likes').select('id,type').eq('from_id', fromId).eq('to_id', toId).maybeSingle();
  if (existingError) throw existingError;
  if (existing) return res.json({ liked: true, alreadyLiked: true, type: existing.type });

  if (req.user.gender === 'Homme' && !isPremium(req.user)) {
    if (await likesToday(fromId) >= FREE_LIKES_PER_DAY) {
      return res.status(402).json({
        code: 'LIMIT',
        error: `Limite de ${FREE_LIKES_PER_DAY} likes par jour atteinte. Passez Premium (${PREMIUM_PRICE_EUR} €/mois) pour des likes illimités.`
      });
    }
  }

  const { error: likeError } = await supabase.from('ac_likes').insert({ from_id: fromId, to_id: toId, type });
  if (likeError?.code === '23505') return res.json({ liked: true, alreadyLiked: true });
  if (likeError) throw likeError;

  const { error: dailyError } = await supabase.from('ac_daily_likes').upsert({
    user_id: fromId, to_id: toId, day: parisDay()
  }, { onConflict: 'user_id,to_id,day', ignoreDuplicates: true });
  if (dailyError) console.error('Daily like :', dailyError.message);

  await sendPush(toId, { title: '❤️ Nouveau like', body: `${req.user.name} vous a envoyé un like.`, url: '/#likes' });
  const match = await isMatch(fromId, toId);
  res.json({ liked: true, match });
}));

app.get('/api/activity', auth, wrap(async (req, res) => {
  const me = Number(req.user.id);
  const blocked = await getBlockedIds(me);

  const [{ data: sent, error: sentError }, { data: receivedLikes, error: receivedError }] = await Promise.all([
    supabase.from('ac_likes').select('to_id,type').eq('from_id', me),
    supabase.from('ac_likes').select('from_id,type').eq('to_id', me).order('id', { ascending: false })
  ]);
  if (sentError) throw sentError;
  if (receivedError) throw receivedError;

  const receivedIds = [...new Set((receivedLikes || []).map(x => Number(x.from_id)).filter(id => !blocked.has(id)))];
  let users = [];
  if (receivedIds.length) {
    const result = await supabase.from('ac_users').select('id,name,city,photos').in('id', receivedIds);
    if (result.error) throw result.error;
    users = result.data || [];
  }
  const byId = new Map(users.map(u => [Number(u.id), u]));
  const received = (receivedLikes || []).map(l => {
    const user = byId.get(Number(l.from_id));
    return user ? { from_id: Number(l.from_id), type: l.type, name: user.name, photos: parsePhotos(user) } : null;
  }).filter(Boolean);

  const sentIds = new Set((sent || []).map(x => Number(x.to_id)));
  const matchIds = receivedIds.filter(id => sentIds.has(id));
  const matches = users.filter(u => matchIds.includes(Number(u.id))).map(u => ({ ...u, photos: parsePhotos(u) }));
  res.json({ sent: sent || [], received, matches });
}));

app.get('/api/conversations', auth, wrap(async (req, res) => {
  const me = Number(req.user.id);
  const blocked = await getBlockedIds(me);

  const [{ data: sent, error: sentError }, { data: received, error: receivedError }] = await Promise.all([
    supabase.from('ac_likes').select('to_id').eq('from_id', me),
    supabase.from('ac_likes').select('from_id').eq('to_id', me)
  ]);
  if (sentError) throw sentError;
  if (receivedError) throw receivedError;

  const sentIds = new Set((sent || []).map(x => Number(x.to_id)));
  const matchIds = [...new Set((received || []).map(x => Number(x.from_id)))]
    .filter(id => sentIds.has(id) && !blocked.has(id));
  if (!matchIds.length) return res.json([]);

  const { data: users, error: usersError } = await supabase
    .from('ac_users').select('id,name,city,photos').in('id', matchIds);
  if (usersError) throw usersError;

  const rows = await Promise.all((users || []).map(async user => {
    const other = Number(user.id);
    const { data: messages, error } = await supabase
      .from('ac_messages')
      .select('kind,content,from_id,to_id,read_at,created_at')
      .or(`and(from_id.eq.${me},to_id.eq.${other}),and(from_id.eq.${other},to_id.eq.${me})`)
      .order('id', { ascending: false })
      .limit(200);
    if (error) throw error;
    const last = messages?.[0];
    const unread = (messages || []).filter(m => Number(m.from_id) === other && Number(m.to_id) === me && !m.read_at).length;
    return {
      ...user,
      photos: parsePhotos(user),
      last_kind: last?.kind || null,
      last_text: last && last.kind !== 'audio' ? String(last.content || '').slice(0, 80) : '',
      unread
    };
  }));
  res.json(rows);
}));

app.get('/api/messages', auth, wrap(async (req, res) => {
  const me = Number(req.user.id);
  const other = Number(req.query.with);
  const after = Number(req.query.after) || 0;
  if (!other || !(await isMatch(me, other))) {
    return res.status(403).json({ error: 'Vous devez vous être likés mutuellement.' });
  }

  const { data, error } = await supabase
    .from('ac_messages')
    .select('id,from_id,to_id,kind,content,created_at')
    .gt('id', after)
    .or(`and(from_id.eq.${me},to_id.eq.${other}),and(from_id.eq.${other},to_id.eq.${me})`)
    .order('id', { ascending: true })
    .limit(200);
  if (error) throw error;

  const { error: readError } = await supabase
    .from('ac_messages')
    .update({ read_at: new Date().toISOString() })
    .eq('to_id', me)
    .eq('from_id', other)
    .is('read_at', null);
  if (readError) console.error('Lecture messages :', readError.message);
  res.json(data || []);
}));

app.post('/api/messages', auth, wrap(async (req, res) => {
  const me = Number(req.user.id);
  const toId = Number(req.body.toId);
  const kind = req.body.kind;
  const content = String(req.body.content || '');
  if (!toId || !(await isMatch(me, toId))) {
    return res.status(403).json({ error: 'Vous devez vous être likés mutuellement.' });
  }
  if (!MESSAGE_KINDS.includes(kind)) return res.status(400).json({ error: 'Type de message invalide.' });
  if (kind === 'text' && (!content.trim() || content.length > 2000)) return res.status(400).json({ error: 'Message invalide.' });
  if (kind === 'audio' && (!content.startsWith('data:audio/') || content.length > 8000000)) return res.status(400).json({ error: 'Message vocal invalide ou trop long.' });
  if (['image', 'video', 'pdf', 'file'].includes(kind) && (!content || content.length > 14000000)) {
    return res.status(400).json({ error: 'Fichier invalide ou trop volumineux.' });
  }

  const { data, error } = await supabase.from('ac_messages').insert({
    from_id: me, to_id: toId, kind, content: kind === 'text' ? content.trim() : content
  }).select('id').single();
  if (error) throw error;

  await sendPush(toId, { title: '💬 Nouveau message', body: `${req.user.name} vous a envoyé un message.`, url: '/#messages' });
  res.status(201).json({ id: data.id });
}));

app.post('/api/signal', auth, wrap(async (req, res) => {
  const me = Number(req.user.id);
  const toId = Number(req.body.toId);
  const type = req.body.type;
  if (!SIGNAL_TYPES.includes(type)) return res.status(400).json({ error: 'Signal invalide.' });
  if (!toId || !(await isMatch(me, toId))) return res.status(403).json({ error: 'Appel impossible.' });
  const payload = JSON.stringify(req.body.data ?? null);
  if (payload.length > 100000) return res.status(400).json({ error: 'Signal trop gros.' });

  const { error } = await supabase.from('ac_signals').insert({ from_id: me, to_id: toId, type, data: payload });
  if (error) throw error;
  if (type === 'offer') {
  const isVideo = req.body.data?.kind === 'video';

  await sendPush(toId, {
    title: isVideo ? '📹 Appel vidéo entrant' : '📞 Appel entrant',
    body: `${req.user.name} vous appelle.`,
    url: '/#messages'
  });

  await sendFcmPush(toId, {
    title: isVideo ? '📹 Appel vidéo entrant' : '📞 Appel entrant',
    body: `${req.user.name} vous appelle.`,
    url: '/#messages'
  });
}
  }
  res.json({ ok: true });
}));

app.get('/api/signal', auth, wrap(async (req, res) => {
  const me = Number(req.user.id);

  const { data, error } = await supabase
    .from('ac_signals').select('id,from_id,type,data').eq('to_id', me).order('id', { ascending: true });
  if (error) throw error;
  if ((data || []).length) {
    const maxId = data[data.length - 1].id;
    await supabase.from('ac_signals').delete().eq('to_id', me).lte('id', maxId);
  }
  res.json((data || []).map(row => ({
    ...row,
    data: row.data ? JSON.parse(row.data) : null
  })));
}));

app.post('/api/block', auth, wrap(async (req, res) => {
  const userId = Number(req.body.userId);
  if (!userId || userId === Number(req.user.id)) return res.status(400).json({ error: 'Requête invalide.' });
  const { error } = await supabase.from('ac_blocks').upsert({
    blocker_id: req.user.id, blocked_id: userId
  }, { onConflict: 'blocker_id,blocked_id', ignoreDuplicates: true });
  if (error) throw error;
  res.json({ ok: true });
}));

app.post('/api/subscribe', auth, wrap(async (req, res) => {
  if (TEST_PAYMENT) {
    const base = isPremium(req.user) ? new Date(req.user.premium_until) : new Date();
    base.setDate(base.getDate() + 30);
    const { error } = await supabase
      .from('ac_users').update({ premium_until: base.toISOString() }).eq('id', req.user.id);
    if (error) throw error;
    return res.json({ ok: true, premium_until: base.toISOString(), test: true });
  }

  if (!process.env.STRIPE_PRICE_ID) return res.status(500).json({ error: 'Le tarif Stripe Premium n’est pas configuré.' });
  const origin = req.headers.origin || `${req.protocol}://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
    customer_email: req.user.email,
    metadata: { user_id: String(req.user.id) },
    subscription_data: { metadata: { user_id: String(req.user.id) } },
    success_url: `${origin}/?premium=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?premium=cancel`
  });
  res.json({ ok: true, test: false, url: session.url });
}));
setInterval(async () => {
  const expiration = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  await supabase.from('ac_signals').delete().lt('created_at', expiration);
}, 60 * 1000);



const server = app.listen(PORT, () => {
  console.log(`Serveur Amour & Cie opérationnel sur le port ${PORT}`);
  if (TEST_PAYMENT) console.log('MODE TEST PAIEMENT ACTIF');
});
server.on('error', err => console.error('ERREUR SERVEUR :', err.message));
process.on('uncaughtException', err => console.error('ERREUR NON GÉRÉE :', err));
process.on('unhandledRejection', err => console.error('PROMESSE REJETÉE :', err));
