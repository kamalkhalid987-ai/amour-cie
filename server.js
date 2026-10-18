const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const io = new Server(server, {
    cors: {
        origin: "*"
    }
});

/*
=================================================
BASE TEMPORAIRE EN MEMOIRE
=================================================
*/

let users = [];
let likes = [];
let matches = [];

/*
=================================================
INSCRIPTION
=================================================
*/

app.post("/register", (req, res) => {

    const {
        name,
        email,
        password,
        age,
        city,
        gender,
        lookingFor,
        bio
    } = req.body;

    const existingUser =
        users.find(
            u => u.email === email
        );

    if (existingUser) {

        return res.status(400).json({
            success: false,
            message: "Email déjà utilisé"
        });

    }

    const user = {

        id: Date.now().toString(),

        name,
        email,
        password,

        age,
        city,
        gender,
        lookingFor,
        bio,

        photo: "",

        online: false

    };

    users.push(user);

    res.json({
        success: true,
        message: "Compte créé"
    });

});

/*
=================================================
CONNEXION
=================================================
*/

app.post("/login", (req, res) => {

    const {
        email,
        password
    } = req.body;

    const user =
        users.find(
            u =>
                u.email === email &&
                u.password === password
        );

    if (!user) {

        return res.status(401).json({

            success: false,

            message:
            "Email ou mot de passe incorrect"

        });

    }

    res.json({

        success: true,

        user

    });

});

/*
=================================================
PROFILS
=================================================
*/

app.get("/users", (req, res) => {

    res.json(users);

});

/*
=================================================
SOCKET.IO
=================================================
*/

io.on("connection", socket => {

    console.log("Utilisateur connecté");

    socket.on(
        "register_user",
        data => {

            const user =
                users.find(
                    u => u.name === data.name
                );

            if (user) {

                user.socketId = socket.id;
                user.online = true;

            }

            io.emit(
                "update_users_list",
                users
            );

        }
    );

    /*
    =============================================
    LIKE
    =============================================
    */

    socket.on(
        "send_like",
        data => {

            likes.push({

                sender:
                data.senderName,

                receiver:
                data.targetName

            });

            const targetUser =
                users.find(
                    u =>
                    u.name ===
                    data.targetName
                );

            if (
                targetUser &&
                targetUser.socketId
            ) {

                io.to(
                    targetUser.socketId
                ).emit(

                    "receive_like_notification",

                    {
                        senderName:
                        data.senderName
                    }

                );

            }

            const reverseLike =
                likes.find(

                    l =>

                    l.sender ===
                    data.targetName &&

                    l.receiver ===
                    data.senderName

                );

            if (reverseLike) {

                matches.push({

                    users: [

                        data.senderName,

                        data.targetName

                    ]

                });

                const senderUser =
                    users.find(
                        u =>
                        u.name ===
                        data.senderName
                    );

                if (
                    senderUser &&
                    senderUser.socketId
                ) {

                    io.to(
                        senderUser.socketId
                    ).emit(

                        "match_success",

                        {
                            targetName:
                            data.targetName
                        }

                    );

                }

                if (
                    targetUser &&
                    targetUser.socketId
                ) {

                    io.to(
                        targetUser.socketId
                    ).emit(

                        "match_success",

                        {
                            targetName:
                            data.senderName
                        }

                    );

                }

            }

        }

    );

    /*
    =============================================
    MESSAGE
    =============================================
    */

    socket.on(
        "send_message",
        data => {

            const match =
                matches.find(

                    m =>

                    m.users.includes(
                        data.author
                    )

                    &&

                    m.users.includes(
                        data.targetName
                    )

                );

            if (!match) {

                socket.emit(

                    "error_message",

                    {
                        message:
                        "Vous devez obtenir un Match avant de discuter."
                    }

                );

                return;

            }

            const receiver =
                users.find(

                    u =>
                    u.name ===
                    data.targetName

                );

            if (
                receiver &&
                receiver.socketId
            ) {

                io.to(
                    receiver.socketId
                ).emit(

                    "receive_message",

                    data

                );

                io.to(
                    receiver.socketId
                ).emit(

                    "message_notification",

                    {
                        senderName:
                        data.author
                    }

                );

            }

            socket.emit(
                "receive_message",
                data
            );

        }
    );

    /*
    =============================================
    DECONNEXION
    =============================================
    */

    socket.on(
        "disconnect",
        () => {

            users.forEach(
                user => {

                    if (
                        user.socketId ===
                        socket.id
                    ) {

                        user.online = false;

                    }

                }
            );

            io.emit(
                "update_users_list",
                users
            );

        }
    );

});

/*
=================================================
DEMARRAGE
=================================================
*/

const PORT =
process.env.PORT || 3000;

server.listen(PORT, () => {

    console.log(
        `Serveur démarré : http://localhost:${PORT}`
    );

});
