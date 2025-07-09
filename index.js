const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const cors =require('cors');
const admin = require('firebase-admin');

// --- Firebase Initialization ---
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
const messaging = admin.messaging();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*" }
});

const port = 3001;
app.use(cors());
app.use(express.json());

// --- Multi-Session Management ---
const sessions = {}; // Key: userId, Value: { client, status, qrCode, fcmToken }

const createWhatsappSession = async (userId) => {
    console.log(`Creating WhatsApp session for user: ${userId}`);
    
    const client = new Client({
        authStrategy: new LocalAuth({ clientId: userId }), // Use userId for persistent sessions
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        }
    });

    // Fetch the active FCM token from the root user document
    let fcmToken = null;
    try {
        const userDoc = await db.collection('users').doc(userId).get();
        if (userDoc.exists && userDoc.data().selectedFcmToken) {
            fcmToken = userDoc.data().selectedFcmToken;
        } else {
            throw new Error('No active FCM token has been set for this user.');
        }
    } catch (error) {
        console.error(`Failed to get active FCM token for user ${userId}:`, error);
        io.to(userId).emit('session_error', 'Could not start session: No active device has been set.');
        return;
    }

    // --- User-Specific Event Handlers ---
    client.on('qr', async (qr) => {
        console.log(`QR code received for user: ${userId}`);
        const qrDataURL = await qrcode.toDataURL(qr);
        sessions[userId].status = 'SCAN_QR';
        sessions[userId].qrCode = qrDataURL;
        io.to(userId).emit('status', 'SCAN_QR');
        io.to(userId).emit('qr', qrDataURL);
    });

    client.on('ready', () => {
        console.log(`Client is ready for user: ${userId}`);
        sessions[userId].status = 'READY';
        sessions[userId].qrCode = null;
        io.to(userId).emit('status', 'READY');
    });

    client.on('authenticated', () => {
        console.log(`Client authenticated for user: ${userId}`);
        sessions[userId].status = 'AUTHENTICATED';
        io.to(userId).emit('status', 'AUTHENTICATED');
    });

    client.on('auth_failure', (msg) => {
        console.error(`Authentication failure for user ${userId}:`, msg);
        sessions[userId].status = 'AUTH_FAILURE';
        io.to(userId).emit('status', 'AUTH_FAILURE');
    });

    client.on('disconnected', (reason) => {
        console.log(`Client for user ${userId} was logged out:`, reason);
        // Clean up the session
        if (sessions[userId]) {
             sessions[userId].status = 'DISCONNECTED';
             io.to(userId).emit('status', 'DISCONNECTED');
             // Optionally, remove the session object if logout is permanent
             // delete sessions[userId];
        }
    });

    client.on('message', async (msg) => {
        console.log(`Message from ${msg.from} for user ${userId}: ${msg.body}`);
        io.to(userId).emit('message', msg.body); // Forward message to the correct user's UI

        if (msg.body.toLowerCase().includes('notify')) {
            if (sessions[userId]?.fcmToken) {
                console.log(`Keyword "notify" detected. Sending push notification to user ${userId}`);
                const messagePayload = {
                    notification: { title: 'New WhatsApp Notification', body: msg.body },
                    token: sessions[userId].fcmToken
                };
                try {
                    await messaging.send(messagePayload);
                    io.to(userId).emit('notification_sent', `Notification sent for message: "${msg.body}"`);
                } catch (error) {
                    console.error('Error sending FCM message:', error);
                    io.to(userId).emit('notification_error', 'Failed to send notification.');
                }
            }
        }
    });

    sessions[userId] = { client, status: 'INITIALIZING', qrCode: null, fcmToken };
    io.to(userId).emit('status', 'INITIALIZING');
    client.initialize().catch(err => {
        console.error(`Initialization failed for user ${userId}:`, err);
        if(sessions[userId]) {
            sessions[userId].status = 'DISCONNECTED';
            io.to(userId).emit('status', 'DISCONNECTED');
        }
    });
};

const stopWhatsappSession = async (userId) => {
    if (sessions[userId]) {
        console.log(`Stopping session for user: ${userId}`);
        await sessions[userId].client.logout(); // logout() handles disconnection and cleanup
        // The 'disconnected' event listener will handle final status updates
        // We can delete the session object here or in the disconnected event
        delete sessions[userId]; 
        console.log(`Session for user ${userId} stopped and deleted.`);
        return true;
    }
    return false;
}

// --- Socket.IO Authentication Middleware & Connection Handling ---
io.use(async (socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
        return next(new Error('Authentication error: No token provided.'));
    }
    try {
        const decodedToken = await admin.auth().verifyIdToken(token);
        socket.user = decodedToken; // Attach user to the socket object
        next();
    } catch (err) {
        console.error("Socket auth error:", err.message);
        next(new Error('Authentication error: Invalid token.'));
    }
});

io.on('connection', (socket) => {
    const userId = socket.user.uid;
    console.log(`User ${userId} (${socket.user.email}) connected via WebSocket`);

    // Join a room unique to this user
    socket.join(userId);

    // Send the current session state to the newly connected client
    const currentUserSession = sessions[userId];
    if (currentUserSession) {
        socket.emit('status', currentUserSession.status);
        if (currentUserSession.qrCode) {
            socket.emit('qr', currentUserSession.qrCode);
        }
    } else {
        socket.emit('status', 'DISCONNECTED');
    }

    socket.on('disconnect', () => {
        console.log(`User ${userId} disconnected from WebSocket.`);
    });
});


// --- Authentication Middleware for HTTP Requests ---
const authMiddleware = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(403).send('Unauthorized: No token provided.');
    }
    const idToken = authHeader.split('Bearer ')[1];
    try {
        req.user = await admin.auth().verifyIdToken(idToken);
        next();
    } catch (error) {
        res.status(403).send('Unauthorized: Invalid token.');
    }
};

// --- API Endpoints ---
app.get('/status', authMiddleware, (req, res) => {
    const userId = req.user.uid;
    const sessionStatus = sessions[userId]?.status || 'DISCONNECTED';
    res.json({ status: sessionStatus });
});

app.get('/devices', authMiddleware, async (req, res) => {
    const userId = req.user.uid;
    try {
        const devicesSnap = await db.collection('users').doc(userId).collection('devices').get();
        if (devicesSnap.empty) {
            return res.status(404).json({ message: 'No registered devices found.' });
        }
        const devices = devicesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json(devices);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch devices.' });
    }
});

app.post('/start', authMiddleware, async (req, res) => {
    const userId = req.user.uid;
    
    if (sessions[userId] && sessions[userId].status !== 'DISCONNECTED' && sessions[userId].status !== 'AUTH_FAILURE') {
        return res.status(400).json({ message: 'Session is already active or initializing.' });
    }
    createWhatsappSession(userId);
    res.status(200).json({ message: 'WhatsApp client initialization started.' });
});

app.post('/stop', authMiddleware, async (req, res) => {
    const userId = req.user.uid;
    const stopped = await stopWhatsappSession(userId);
    if (stopped) {
        res.status(200).json({ message: 'Client session stopped successfully.' });
    } else {
        res.status(400).json({ message: 'No active session found to stop.' });
    }
});

app.post('/set-active-device', authMiddleware, (req, res) => {
    const userId = req.user.uid;
    const { fcmToken } = req.body;

    if (!fcmToken) {
        return res.status(400).json({ message: 'fcmToken is required.' });
    }

    if (sessions[userId] && (sessions[userId].status === 'READY' || sessions[userId].status === 'AUTHENTICATED')) {
        console.log(`Dynamically updating FCM token for running session of user: ${userId}`);
        sessions[userId].fcmToken = fcmToken;
        res.status(200).json({ message: 'Active FCM token updated for the current session.' });
    } else {
        // If the session isn't running, we don't need to do anything here.
        // The new token is already saved in Firestore and will be picked up on the next /start call.
        res.status(200).json({ message: 'Active device preference saved. It will be used on the next session start.' });
    }
});

server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
}); 