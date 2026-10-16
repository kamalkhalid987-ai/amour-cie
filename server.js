const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
// Remplacez 'votre_cle_secrete_stripe' par votre vraie clé secrète Stripe (commençant par sk_...)
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'votre_cle_secrete_stripe');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let users = {}; 
let likes = {}; 

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

app.post('/api/login', (req, res) => {
  const { prenom, password } = req.body;
  const key = prenom.trim().toLowerCase();
  
  if (!users[key] || users[key].password !== password) {
    return res.status(400).json({ error: 'Prénom ou mot de passe incorrect' });
  }

  res.json({ success: true, user: users[key] });
});

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

app.post('/api/like', (req, res) => {
  const { from, to } = req.body;
  const fromKey = from.trim().toLowerCase();
  const toKey = to.trim().toLowerCase();

  const user = users[fromKey];
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu' });

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

// Création d'une session de paiement Stripe (11 € / mois)
app.post('/api/create-checkout-session', async (req, res) => {
  const { prenom } = req.body;
  const key = prenom ? prenom.trim().toLowerCase() : '';
  
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Pass Illimité Amour & Cie (Abonnement Mensuel)',
          },
          unit_amount: 1100, // 11,00 € en centimes
          recurring: {
            interval: 'month',
          },
        },
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `https://amour-cie-1.onrender.com/?success=true&user=${encodeURIComponent(prenom)}`,
      cancel_url: `https://amour-cie-1.onrender.com/?canceled=true`,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Erreur Stripe:", e.message);
    // Fallback de simulation si la clé Stripe n'est pas encore configurée sur Render
    res.json({ simulated: true });
  }
});

// Route pour valider le statut Premium après paiement réussi
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
