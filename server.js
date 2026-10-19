require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const Stripe = require('stripe');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);
const stripe = Stripe(process.env.STRIPE_KEY);

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getDistanceKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// Récupérer les profils avec filtre de distance
app.get('/api/users', async (req, res) => {
  const { userLat, userLon, maxKm } = req.query;
  const { data, error } = await supabase.from('profiles').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ success: false, message: error.message });

  let results = data;
  if (userLat && userLon) {
    const uLat = parseFloat(userLat);
    const uLon = parseFloat(userLon);
    const limitKm = maxKm ? parseFloat(maxKm) : null;

    results = results.map(function (u) {
      const distance = getDistanceKm(uLat, uLon, u.lat, u.lon);
      return Object.assign({}, u, { distance: distance });
    });

    if (limitKm) {
      results = results.filter(function (u) { return u.distance === null || u.distance <= limitKm; });
    }
    results.sort(function (a, b) { return (a.distance || 9999) - (b.distance || 9999); });
  }

  res.json(results);
});

// Route d'inscription corrigée pour correspondre au front
app.post('/register', async (req, res) => {
  const { name, email, password, age, city, gender, lookingFor, bio, photo, lat, lon } = req.body;
  
  if (!name || !email || !password || !age || !gender || !city) {
    return res.status(400).json({ success: false, message: 'Tous les champs obligatoires ne sont pas remplis.' });
  }

  const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé. Choisissez-en un autre.' });
  }

  const defaultPhoto = gender === 'femme'
    ? 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=600&auto=format&fit=crop&q=80'
    : 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600&auto=format&fit=crop&q=80';

  const { data, error } = await supabase
    .from('profiles')
    .insert([{
      name: name,
      email: email,
      password: password,
      age: parseInt(age),
      gender: gender,
      looking_for: lookingFor,
      city: city,
      bio: bio || '',
      lat: lat ? parseFloat(lat) : 48.8566,
      lon: lon ? parseFloat(lon) : 2.3522,
      photo: (photo && photo.trim() && photo.startsWith('data:image')) ? photo : defaultPhoto,
      is_subscribed: gender === 'femme',
      likes_count: 0,
      last_like_date: new Date().toISOString().split('T')[0]
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ success: false, message: error.message });
  
  // Renvoyer un token factice ou l'ID utilisateur pour le localStorage
  res.json({ success: true, token: data.id, user: data });
});

// Route de connexion corrigée
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });
  }

  const { data, error } = await supabase.from('profiles').select('*').eq('email', email).limit(1);
  if (error) return res.status(500).json({ success: false, message: error.message });
  if (!data || data.length === 0) return res.status(404).json({ success: false, message: 'Aucun compte associé à cet email.' });

  const user = data[0];
  if (user.password && user.password !== password) {
    return res.status(401).json({ success: false, message: 'Mot de passe incorrect.' });
  }

  res.json({ success: true, token: user.id, user: user });
});

// Route de vérification de session /me
app.get('/api/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Non autorisé.' });
  const token = authHeader.split(' ')[1];

  const { data, error } = await supabase.from('profiles').select('*').eq('id', token).single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
  
  res.json({ success: true, user: data });
});

app.post('/api/like', async (req, res) => {
  const { fromId, toId } = req.body;

  const { data: user } = await supabase.from('profiles').select('*').eq('id', fromId).single();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });

  const today = new Date().toISOString().split('T')[0];
  let currentLikes = user.likes_count || 0;
  if (user.last_like_date !== today) currentLikes = 0;

  if (user.gender === 'homme' && !user.is_subscribed && currentLikes >= 10) {
    return res.status(403).json({
      error: 'QUOTA_LIKES_ATTEINT',
      message: 'Limite de 10 likes atteinte pour aujourd hui ! Passez VIP pour liker sans limite.'
    });
  }

  await supabase.from('likes').upsert([{ from_id: fromId, to_id: toId }]);

  const updatedLikes = currentLikes + 1;
  await supabase.from('profiles').update({ likes_count: updatedLikes, last_like_date: today }).eq('id', fromId);

  const { data: match } = await supabase.from('likes').select('id').eq('from_id', toId).eq('to_id', fromId).limit(1);
  const isMatch = match && match.length > 0;

  res.json({
    success: true,
    isMatch: isMatch,
    likesRemaining: (user.gender === 'femme' || user.is_subscribed) ? 'Illimités' : (10 - updatedLikes)
  });
});

app.post('/api/create-checkout', async (req, res) => {
  const { userId } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Amour & Cie - Abonnement Privilège' },
          unit_amount: 1990,
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      success_url: 'http://localhost:3000/?paiement=succes&user=' + userId,
      cancel_url: 'http://localhost:3000/?paiement=annule',
      client_reference_id: String(userId)
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Serveur Amour & Cie démarré sur le port ' + PORT);
});
