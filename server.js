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

// Base de données en mémoire (persistante tant que le serveur tourne)
let users = {}; 
let messages = {}; 

app.post('/api/register', (req, res) => {
  const user = req.body;
  if (!user.prenom) return res.status(400).json({ error: 'Prénom requis' });
  
  const key = user.prenom.toLowerCase();
  if (!users[key]) {
    users[key] = {
      ...user,
      likesLeft: user.genre === 'Homme' ? 10 : Infinity,
      isPremium: false,
      likes: [],
      matches: []
    };
  }
  
  res.json({ success: true, user: users[key] });
});

app.get('/api/profiles/:prenom', (req, res) => {
  const currentKey = req.params.prenom.toLowerCase();
  const currentUser = users[currentKey];
  if (!currentUser) return res.json([]);

  const available = Object.values(users).filter(u => {
    return u.prenom.toLowerCase() !== currentKey && 
           !currentUser.likes.includes(u.prenom.toLowerCase());
  });

  res.json(available);
});

app.post('/api/like', (req, res) => {
  const { from, to } = req.body;
  const fromKey = from.toLowerCase();
  const toKey = to.toLowerCase();

  const user = users[fromKey];
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu' });

  // Vérification du quota pour les hommes non premium
  if (user.genre === 'Homme' && !user.isPremium) {
    if (user.likesLeft <= 0) {
      return res.json({ success: false, paywall: true, message: "Quota de likes épuisé" });
    }
    user.likesLeft--;
  }

  if (!user.likes.includes(toKey)) {
    user.likes.push(toKey);
  }

  let isMatch = false;
  if (users[toKey] && users[toKey].likes.includes(fromKey)) {
    isMatch = true;
    if (!user.matches.includes(toKey)) user.matches.push(toKey);
    if (!users[toKey].matches.includes(fromKey)) users[toKey].matches.push(fromKey);

    io.to(toKey).emit('match', { withUser: user });
  }

  res.json({ success: true, isMatch, likesLeft: user.likesLeft });
});

app.post('/api/upgrade', (req, res) => {
  const { prenom } = req.body;
  const key = prenom.toLowerCase();
  if (users[key]) {
    users[key].isPremium = true;
    users[key].likesLeft = Infinity;
    return res.json({ success: true, user: users[key] });
  }
  res.status(400).json({ error: 'Utilisateur non trouvé' });
});

io.on('connection', (socket) => {
  socket.on('join', (prenom) => {
    if (prenom) socket.join(prenom.toLowerCase());
  });

  socket.on('send_message', ({ from, to, text }) => {
    const matchKey = [from.toLowerCase(), to.toLowerCase()].sort().join('_');
    if (!messages[matchKey]) messages[matchKey] = [];
    
    const msgData = { from, text, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
    messages[matchKey].push(msgData);

    io.to(from.toLowerCase()).emit('receive_message', msgData);
    io.to(to.toLowerCase()).emit('receive_message', msgData);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur Amour & Cie actif sur le port ${PORT}`);
});
