const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// Stockage des utilisateurs enregistrés et des likes/matches
let registeredUsers = {}; // email/id -> userData
let userLikes = {};       // fromUser -> Set(toUser)
let userMatches = {};     // user -> Set(matchedUsers)
let connectedSockets = {}; // socket.id -> email/id

io.on('connection', (socket) => {
    console.log('Utilisateur connecté :', socket.id);

    // Inscription / Connexion
    socket.on('register_user', (userData) => {
        const userKey = userData.email || userData.name;
        userData.socketId = socket.id;
        
        registeredUsers[userKey] = { ...registeredUsers[userKey], ...userData };
        connectedSockets[socket.id] = userKey;

        if (!userLikes[userKey]) userLikes[userKey] = new Set();
        if (!userMatches[userKey]) userMatches[userKey] = new Set();

        // Envoyer la liste actualisée à tout le monde
        io.emit('update_users_list', Object.values(registeredUsers));
        socket.emit('login_success', registeredUsers[userKey]);
    });

    // Gestion des Likes et Notifications
    socket.on('send_like', (data) => {
        const { senderName, targetName } = data;
        if (!userLikes[senderName]) userLikes[senderName] = new Set();
        userLikes[senderName].add(targetName);

        // Trouver le socket du destinataire
        const targetUser = Object.values(registeredUsers).find(u => u.name === targetName);
        
        // 1. Notification de Like reçue
        if (targetUser && targetUser.socketId) {
            io.to(targetUser.socketId).emit('receive_like_notification', { senderName });
        }

        // 2. Vérification de Match
        if (userLikes[targetName] && userLikes[targetName].has(senderName)) {
            if (!userMatches[senderName]) userMatches[senderName] = new Set();
            if (!userMatches[targetName]) userMatches[targetName] = new Set();
            
            userMatches[senderName].add(targetName);
            userMatches[targetName].add(senderName);

            // Informer les deux personnes du Match
            socket.emit('match_success', { targetName });
            if (targetUser && targetUser.socketId) {
                io.to(targetUser.socketId).emit('match_success', { targetName: senderName });
            }
        }
    });

    // Envoi de messages (Autorisé SEULEMENT si Match)
    socket.on('send_message', (msgData) => {
        const { author, targetName } = msgData;
        const matches = userMatches[author];

        if (matches && matches.has(targetName)) {
            io.emit('receive_message', msgData);
        } else {
            socket.emit('error_message', { message: "Vous devez avoir un Match mutuel pour échanger des messages !" });
        }
    });

    // WebRTC Signaling (Appels)
    socket.on('call_user', (data) => {
        const targetSocket = Object.values(registeredUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('incoming_call', {
                callerName: data.callerName,
                offer: data.offer,
                callType: data.callType
            });
        }
    });

    socket.on('make_answer', (data) => {
        const targetSocket = Object.values(registeredUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('call_answered', { answer: data.answer });
        }
    });

    socket.on('ice_candidate', (data) => {
        const targetSocket = Object.values(registeredUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('ice_candidate', { candidate: data.candidate });
        }
    });

    socket.on('end_call', (data) => {
        const targetSocket = Object.values(registeredUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('call_ended');
        }
    });

    socket.on('disconnect', () => {
        delete connectedSockets[socket.id];
        console.log('Utilisateur déconnecté :', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
