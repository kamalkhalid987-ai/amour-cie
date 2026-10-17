const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Augmentation de la limite pour recevoir les fichiers audio vocaux et photos HD
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let users = [];
let likesData = {};

io.on('connection', (socket) => {
    console.log('Nouvelle connexion : ' + socket.id);

    // Inscription / Reconnexion d'un utilisateur (avec support Google Login)
    socket.on('register_user', (userData) => {
        let existingUser = users.find(u => u.name === userData.name);
        if (!existingUser) {
            users.push({
                socketId: socket.id,
                name: userData.name,
                age: userData.age || "60",
                city: userData.city || "Paris",
                gender: userData.gender || "homme",
                lookingFor: userData.lookingFor || "femme",
                bio: userData.bio || "Bonjour !",
                photo: userData.photo || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=300&q=80",
                isPremium: userData.isPremium || false
            });
        } else {
            existingUser.socketId = socket.id;
            existingUser.age = userData.age || existingUser.age;
            existingUser.city = userData.city || existingUser.city;
            existingUser.gender = userData.gender || existingUser.gender;
            existingUser.lookingFor = userData.lookingFor || existingUser.lookingFor;
            existingUser.bio = userData.bio || existingUser.bio;
            if (userData.photo) existingUser.photo = userData.photo;
            if (userData.isPremium !== undefined) existingUser.isPremium = userData.isPremium;
        }
        updateProfilesForEveryone();
    });

    // Traitement du Like et contrôle des quotas
    socket.on('send_like', (data) => {
        const { senderName, targetName, isLiked } = data;
        const sender = users.find(u => u.name === senderName);
        if (!sender) return;

        const isLimited = (sender.gender === 'homme' && sender.lookingFor === 'femme' && !sender.isPremium);

        if (isLiked && isLimited) {
            const today = new Date().toISOString().slice(0, 10);
            if (!likesData[senderName] || likesData[senderName].date !== today) {
                likesData[senderName] = { count: 0, date: today };
            }

            if (likesData[senderName].count >= 10) {
                socket.emit('like_limit_reached', {
                    message: "⚠️ Vous avez atteint votre limite de 10 likes gratuits aujourd'hui. Passez à l'abonnement Premium pour liker en illimité !"
                });
                return;
            }
            likesData[senderName].count++;
        }

        if (isLiked) {
            socket.emit('match_success', { targetName });
        }
    });

    // Messagerie texte et vocale
    socket.on('send_message', (data) => {
        io.emit('receive_message', data);
    });

    // --- WEBRTC SIGNALING (Appels Audio / Vidéo) ---
    socket.on('call_user', (data) => {
        const targetUser = users.find(u => u.name === data.targetName);
        if (targetUser) {
            io.to(targetUser.socketId).emit('incoming_call', {
                callerName: data.callerName,
                offer: data.offer,
                callType: data.callType // 'audio' ou 'video'
            });
        }
    });

    socket.on('make_answer', (data) => {
        const targetUser = users.find(u => u.name === data.targetName);
        if (targetUser) {
            io.to(targetUser.socketId).emit('call_answered', {
                answer: data.answer
            });
        }
    });

    socket.on('ice_candidate', (data) => {
        const targetUser = users.find(u => u.name === data.targetName);
        if (targetUser) {
            io.to(targetUser.socketId).emit('ice_candidate', {
                candidate: data.candidate
            });
        }
    });

    socket.on('end_call', (data) => {
        const targetUser = users.find(u => u.name === data.targetName);
        if (targetUser) {
            io.to(targetUser.socketId).emit('call_ended');
        }
    });

    socket.on('disconnect', () => {
        console.log('Un utilisateur s\'est déconnecté.');
    });
});

function updateProfilesForEveryone() {
    io.emit('update_users_list', users);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur Amour & Cie démarré sur http://localhost:${PORT}`);
});
