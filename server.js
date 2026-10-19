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

app.get('/api/users', async (req, res) => {
  const { userLat, userLon, maxKm } = req.query;
  const { data, error } = await supabase.from('profiles').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

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

app.get('/api/users/:id', async (req, res) => {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Membre introuvable.' });
  res.json(data);
});

app.post('/api/upload-avatar', async (req, res) => {
  const { name, imageBase64 } = req.body;
  if (!name || !imageBase64) {
    return res.status(400).json({ error: 'Photo manquante.' });
  }

  try {
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const fileName = name.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Date.now() + '.jpg';

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(fileName, buffer, { contentType: 'image/jpeg', upsert: true });

    if (uploadError) return res.status(500).json({ error: uploadError.message });

    const { data: urlData } = supabase.storage.from('avatars').getPublicUrl(fileName);
    res.json({ success: true, url: urlData.publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/register', async (req, res) => {
  const { name, age, gender, city, photo_url, lat, lon } = req.body;
  if (!name || !age || !gender || !city) {
    return res.status(400).json({ error: 'Tous les champs sont requis.' });
  }

  const { data: existing } = await supabase.from('profiles').select('id').eq('name', name).limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ error: 'Ce prénom est déjà utilisé. Choisissez-en un autre.' });
  }

  const defaultPhoto = gender === 'femme'
    ? '[images.unsplash.com](https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=600&auto=format&fit=crop&q=80)'
    : '[images.unsplash.com](https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600&auto=format&fit=crop&q=80)';

  const { data, error } = await supabase
    .from('profiles')
    .insert([{
      name: name,
      age: parseInt(age),
      gender: gender,
      city: city,
      lat: lat ? parseFloat(lat) : 48.8566,
      lon: lon ? parseFloat(lon) : 2.3522,
      photo_url: (photo_url && photo_url.trim() && !photo_url.startsWith('data:image')) ? photo_url : defaultPhoto,
      is_subscribed: gender === 'femme',
      likes_count: 0,
      last_like_date: new Date().toISOString().split('T')[0]
    }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, user: data });
});

app.post('/api/login', async (req, res) => {
  const { name } = req.body;
  const { data, error } = await supabase.from('profiles').select('*').eq('name', name).limit(1);
  if (error) return res.status(500).json({ error: error.message });
  if (!data || data.length === 0) return res.status(404).json({ error: 'Aucun membre avec ce prénom.' });
  res.json({ success: true, user: data[0] });
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

app.post('/api/subscribe', async (req, res) => {
  const { userId } = req.body;
  const { data, error } = await supabase
    .from('profiles')
    .update({ is_subscribed: true })
    .eq('id', userId)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, user: data });
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
      success_url: '[localhost](http://localhost:3000/?paiement=succes&user=)' + userId,
      cancel_url: '[localhost](http://localhost:3000/?paiement=annule)',
      client_reference_id: String(userId)
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/messages/:user1/:user2', async (req, res) => {
  const { user1, user2 } = req.params;

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(
      'and(sender_id.eq.' + user1 + ',receiver_id.eq.' + user2 + '),' +
      'and(sender_id.eq.' + user2 + ',receiver_id.eq.' + user1 + ')'
    )
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/messages', async (req, res) => {
  const { senderId, receiverId, content } = req.body;
  if (!senderId || !receiverId || !content) {
    return res.status(400).json({ error: 'Message vide.' });
  }

  const { data: sender } = await supabase
    .from('profiles').select('gender, is_subscribed').eq('id', senderId).single();

  if (sender && sender.gender === 'homme' && !sender.is_subscribed) {
    return res.status(403).json({ error: 'ABONNEMENT_REQUIS' });
  }

  const { data, error } = await supabase
    .from('messages')
    .insert([{ sender_id: senderId, receiver_id: receiverId, content: content }])
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, message: data });
});

app.get('/api/notifications/:userId', async (req, res) => {
  const { userId } = req.params;
  const { lastCheck } = req.query;

  const timeFilter = lastCheck || new Date(Date.now() - 3000).toISOString();

  const { data: newMsgs } = await supabase
    .from('messages')
    .select('*')
    .eq('receiver_id', userId)
    .gt('created_at', timeFilter)
    .order('created_at', { ascending: true });

  const { data: newLikes } = await supabase
    .from('likes')
    .select('*')
    .eq('to_id', userId)
    .gt('created_at', timeFilter);

  res.json({
    messages: newMsgs || [],
    likes: newLikes || [],
    timestamp: new Date().toISOString()
  });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('Serveur Amour & Cie accessible sur le réseau, port ' + PORT);
});
