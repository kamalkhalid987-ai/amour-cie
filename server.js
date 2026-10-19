require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const Stripe = require('stripe');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
const stripe = Stripe(process.env.STRIPE_KEY);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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

// Inscription
app.post('/register', async (req, res) => {
  const { name, email, password, age, city, gender, lookingFor, bio, photo, lat, lon } = req.body;
  if (!name || !email || !password || !age || !gender || !city) {
    return res.status(400).json({ success: false, message: 'Tous les champs obligatoires sont requis.' });
  }

  const { data: existing } = await supabase.from('profiles').select('id').eq('email', email).limit(1);
  if (existing && existing.length > 0) {
    return res.status(409).json({ success: false, message: 'Cet email est déjà utilisé.' });
  }

 const defaultPhoto = '';

  const { data, error } = await supabase
    .from('profiles')
    .insert([{
      name, email, password,
      age: parseInt(age),
      gender,
      looking_for: lookingFor,
      city,
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
  res.json({ success: true, token: data.id, user: data });
});

// Connexion
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.from('profiles').select('*').eq('email', email).limit(1);
  if (error) return res.status(500).json({ success: false, message: error.message });
  if (!data || data.length === 0) return res.status(404).json({ success: false, message: 'Compte introuvable.' });

  const user = data[0];
  if (user.password && user.password !== password) {
    return res.status(401).json({ success: false, message: 'Mot de passe incorrect.' });
  }

  res.json({ success: true, token: user.id, user: user });
});

// Vérification session
app.get('/me', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, message: 'Non autorisé.' });
  const token = authHeader.split(' ')[1];

  const { data, error } = await supabase.from('profiles').select('*').eq('id', token).single();
  if (error || !data) return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
  res.json({ success: true, user: data });
});

// Découvrir les profils
app.get('/discover', async (req, res) => {
  const { radius } = req.query;
  const { data, error } = await supabase.from('profiles').select('*').order('id', { ascending: false });
  if (error) return res.status(500).json({ success: false, message: error.message });
  res.json(data || []);
});

// Likes reçus
app.get('/likes', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json([]);
  const userId = authHeader.split(' ')[1];

  const { data: likes } = await supabase.from('likes').select('from_id').eq('to_id', userId);
  if (!likes || !likes.length) return res.json([]);

  const fromIds = likes.map(l => l.from_id);
  const { data: profiles } = await supabase.from('profiles').select('*').in('id', fromIds);
  res.json(profiles || []);
});

// Matchs
app.get('/matches', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json([]);
  const userId = authHeader.split(' ')[1];

  // Récupérer les likes mutuels
  const { data: myLikes } = await supabase.from('likes').select('to_id').eq('from_id', userId);
  if (!myLikes || !myLikes.length) return res.json([]);

  const targetIds = myLikes.map(l => l.to_id);
  const { data: mutualLikes } = await supabase.from('likes').select('from_id').eq('to_id', userId).in('from_id', targetIds);
  if (!mutualLikes || !mutualLikes.length) return res.json([]);

  const matchIds = mutualLikes.map(l => l.from_id);
  const { data: matchedProfiles } = await supabase.from('profiles').select('*').in('id', matchIds);

  const formattedMatches = (matchedProfiles || []).map(p => ({
    matchId: p.id,
    user: p
  }));

  res.json(formattedMatches);
});

// Messages d'un match
app.get('/messages/:matchId', async (req, res) => {
  const { matchId } = req.params;
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json([]);
  const userId = authHeader.split(' ')[1];

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .or(`and(sender_id.eq.${userId},receiver_id.eq.${matchId}),and(sender_id.eq.${matchId},receiver_id.eq.${userId})`)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json([]);
  
  const formatted = (data || []).map(m => ({
    matchId: m.sender_id === userId ? m.receiver_id : m.sender_id,
    author: m.sender_id,
    authorName: '',
    text: m.content
  }));

  res.json(formatted);
});

// Gestion Socket.io en temps réel
io.on('connection', (socket) => {
  const token = socket.handshake.auth.token;
  if (token) {
    socket.join(token);
  }

  socket.on('send_like', async (data) => {
    if (!token || !data.targetId) return;
    await supabase.from('likes').upsert([{ from_id: token, to_id: data.targetId }]);

    // Vérifier s'il y a match réciproque
    const { data: check } = await supabase.from('likes').select('id').eq('from_id', data.targetId).eq('to_id', token).limit(1);
    if (check && check.length > 0) {
      const { data: targetUser } = await supabase.from('profiles').select('*').eq('id', data.targetId).single();
      socket.emit('match_success', { matchId: data.targetId, user: targetUser });
      io.to(data.targetId).emit('match_success', { matchId: token, user: { id: token } });
    } else {
      io.to(data.targetId).emit('receive_like_notification', { senderId: token, senderName: 'Quelqu un' });
    }
  });

  socket.on('send_message', async (data) => {
    if (!token || !data.matchId || !data.text) return;
    
    await supabase.from('messages').insert([{
      sender_id: token,
      receiver_id: data.matchId,
      content: data.text
    }]);

    const msgObj = {
      matchId: data.matchId,
      author: token,
      text: data.text
    };

    socket.emit('receive_message', msgObj);
    io.to(data.matchId).emit('receive_message', { ...msgObj, matchId: token });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('Serveur opérationnel sur le port ' + PORT);
});
