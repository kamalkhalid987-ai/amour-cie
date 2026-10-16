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

let users = {}; // Stocke les utilisateurs connectés
let likes = {}; // Stocke qui a liké qui : { "prenom1": ["prenom2"] }
let matches = [];

app.post('/api/register', (req, res) => {
  const user = req.body;
  if (!user.prenom) return res.status(400).json({ error: 'Prénom requis' });
  
  const key = user.prenom.trim().toLowerCase();
  if (!users[key]) {
    users[key] = {
      ...user,
      likesLeft: user.genre === 'Homme' ? 10 : Infinity,
      isPremium: false
    };
  }
  
  res.json({ success: true, user: users[key] });
});

app.get('/api/profiles/:prenom', (req, res) => {
  const currentKey = req.params.prenom.trim().toLowerCase();
  const currentUser = users[currentKey];
  if (!currentUser) return res.json([]);

  // Récupérer tous les autres utilisateurs inscrits
  const available = Object.values(users).filter(u => {
    const uKey = u.prenom.trim().toLowerCase();
    const userLikes = likes[currentKey] || [];
    return uKey !== currentKey && !userLikes.includes(uKey);
  });

  res.json(available);
});

app.post('/api/like', (req, res) => {
  const { from, to } = req.body;
  const fromKey = from.trim().toLowerCase();
  const toKey = to.trim().toLowerCase();

  const user = users[fromKey];
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu' });

  // Quota pour les hommes
  if (user.genre === 'Homme' && !user.isPremium) {
    if (user.likesLeft <= 0) {
      return res.json({ success: false, paywall: true });
    }
    user.likesLeft--;
  }

  if (!likes[fromKey]) likes[fromKey] = [];
  if (!likes[fromKey].includes(toKey)) {
    likes[fromKey].push(toKey);
  }

  // Vérifier si c'est un match (si l'autre a aussi liké 'from')
  let isMatch = false;
  const targetLikes = likes[toKey] || [];
  if (targetLikes.includes(fromKey)) {
    isMatch = true;
    io.to(toKey).emit('match_notification', { withUser: user });
  }

  res.json({ success: true, isMatch, likesLeft: user.likesLeft });
});

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
