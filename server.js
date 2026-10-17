const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

let connectedUsers = {}; // socket.id -> userData

io.on('connection', (socket) => {
    console.log('Un utilisateur s\'est connecté :', socket.id);

    socket.on('register_user', (userData) => {
        userData.socketId = socket.id;
        connectedUsers[socket.id] = userData;
        io.emit('update_users_list', Object.values(connectedUsers));
    });

    socket.on('send_message', (msgData) => {
        io.emit('receive_message', msgData);
    });

    // WebRTC Signaling propre et corrigé
    socket.on('call_user', (data) => {
        const targetSocket = Object.values(connectedUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('incoming_call', {
                callerName: data.callerName,
                offer: data.offer,
                callType: data.callType
            });
        }
    });

    socket.on('make_answer', (data) => {
        const targetSocket = Object.values(connectedUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('call_answered', { answer: data.answer });
        }
    });

    socket.on('ice_candidate', (data) => {
        const targetSocket = Object.values(connectedUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('ice_candidate', { candidate: data.candidate });
        }
    });

    socket.on('end_call', (data) => {
        const targetSocket = Object.values(connectedUsers).find(u => u.name === data.targetName);
        if (targetSocket) {
            io.to(targetSocket.socketId).emit('call_ended');
        }
    });

    socket.on('disconnect', () => {
        delete connectedUsers[socket.id];
        io.emit('update_users_list', Object.values(connectedUsers));
        console.log('Utilisateur déconnecté :', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
});
