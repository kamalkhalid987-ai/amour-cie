const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let users = {}; // { id: { prenom, password, genre, ville, age, photo, likesLeft, isPremium } }
let likes = {}; // { prenom: [destinataires] }
let messages = {}; 

// Inscription
app.post('/api/register', (req, res) => {
  const { prenom, password, age, ville, genre, photo } = req.body;
  if (!prenom || !password) return res.status(400).json({ error: 'Identifiants requis' });
  
  const key = prenom.trim().toLowerCase();
  if (users[key]) {
    return res.status(400).json({ error: 'Ce prénom existe déjà. Connectez-vous !' });
  }

  users[key] = {
    prenom: prenom.trim(),
    password,
    age,
    ville,
    genre,
    photo,
    likesLeft: genre === 'Homme' ? 10 : Infinity,
    isPremium: false
  };
  
  res.json({ success: true, user: users[key] });
});

// Connexion
app.post('/api/login', (req, res) => {
  const { prenom, password } = req.body;
  const key = prenom.trim().toLowerCase();
  
  if (!users[key] || users[key].password !== password) {
    return res.status(400).json({ error: 'Prénom ou mot de passe incorrect' });
  }

  res.json({ success: true, user: users[key] });
});

// Profils à swiper
app.get('/api/profiles/:prenom', (req, res) => {
  const currentKey = req.params.prenom.trim().toLowerCase();
  const currentUser = users[currentKey];
  if (!currentUser) return res.json([]);

  const userLikes = likes[currentKey] || [];
  const available = Object.values(users).filter(u => {
    const uKey = u.prenom.trim().toLowerCase();
    return uKey !== currentKey && !userLikes.includes(uKey);
  });

  res.json(available);
});

// Gestion des Likes & Quota Hommes
app.post('/api/like', (req, res) => {
  const { from, to } = req.body;
  const fromKey = from.trim().toLowerCase();
  const toKey = to.trim().toLowerCase();

  const user = users[fromKey];
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu' });

  // Règle Tinder : Quota strict de 10 likes pour les hommes (sauf si premium)
  if (user.genre === 'Homme' && !user.isPremium) {
    if (user.likesLeft <= 0) {
      return res.json({ success: false, paywall: true, message: "Quota de 10 likes journaliers atteint." });
    }
    user.likesLeft--;
  }

  if (!likes[fromKey]) likes[fromKey] = [];
  if (!likes[fromKey].includes(toKey)) {
    likes[fromKey].push(toKey);
  }

  let isMatch = false;
  const targetLikes = likes[toKey] || [];
  if (targetLikes.includes(fromKey)) {
    isMatch = true;
    io.to(toKey).emit('match_notification', { withUser: user });
  }

  res.json({ success: true, isMatch, likesLeft: user.likesLeft });
});

// Paiement / Pass Illimité pour dépasser les 10 likes
app.post('/api/upgrade', (req, res) => {
  const { prenom } = req.body;
  const key = prenom.trim().toLowerCase();
  if (users[key]) {
    users[key].isPremium = true;
    users[key].likesLeft = Infinity;
    return res.json({ success: true, user: users[key] });
  }
  res.status(400).json({ error: 'Utilisateur non trouvé' });
});

io.on('connection', (socket) => {
  socket.on('join', (prenom) => {
    if (prenom) socket.join(prenom.trim().toLowerCase());
  });

  socket.on('send_message', ({ from, to, text }) => {
    const data = { from, text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
    io.to(to.trim().toLowerCase()).emit('receive_message', data);
    io.to(from.trim().toLowerCase()).emit('receive_message', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur actif sur le port ${PORT}`);
});
