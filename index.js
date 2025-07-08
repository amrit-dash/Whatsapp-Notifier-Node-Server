const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const socketIO = require('socket.io');
const http = require('http');
const qrcode = require('qrcode');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*", // In production, you should restrict this to your frontend's URL
    }
});

const port = 3001;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Hello from the WhatsApp API server!');
});

// State variables
let status = 'DISCONNECTED';
let qrCodeData = null;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true // run headless for server environment
	}
});

io.on('connection', (socket) => {
    console.log('a user connected');
    socket.emit('status', status); // Immediately send current status to new client
    if (qrCodeData) {
        socket.emit('qr', qrCodeData);
    }

    socket.on('disconnect', () => {
        console.log('user disconnected');
    });
});

const updateStatus = (newStatus, data = null) => {
    status = newStatus;
    console.log('Status updated:', status);
    io.emit('status', status);
    if (data) {
        io.emit(newStatus.toLowerCase(), data);
    }
}

client.on('qr', async (qr) => {
    console.log('QR RECEIVED');
    qrCodeData = await qrcode.toDataURL(qr);
    updateStatus('SCAN_QR', qrCodeData);
});

client.on('ready', () => {
    qrCodeData = null;
    updateStatus('READY');
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
    updateStatus('AUTHENTICATED');
});

client.on('auth_failure', (msg) => {
    console.error('AUTHENTICATION FAILURE', msg);
    updateStatus('AUTH_FAILURE');
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    updateStatus('DISCONNECTED');
    // Potentially re-initialize or notify admin
});

client.on('message', msg => {
    // For now, just log it. We will add notification logic later.
    console.log('MESSAGE RECEIVED', msg.body);
    io.emit('message', msg.body); // Forward message to client
    if (msg.body === '!ping') {
        msg.reply('pong');
    }
});

// --- API Endpoints ---

app.get('/status', (req, res) => {
    res.json({ status });
});

app.post('/start', (req, res) => {
    if (status === 'READY' || status === 'AUTHENTICATED') {
        return res.status(400).json({ message: 'Client is already running.' });
    }
    if (status === 'INITIALIZING' || status === 'SCAN_QR') {
        return res.status(400).json({ message: 'Client is already initializing.' });
    }
    
    console.log('Starting client initialization...');
    updateStatus('INITIALIZING');
    client.initialize().catch(err => {
        console.error('Failed to initialize client:', err);
        updateStatus('DISCONNECTED');
    });
    res.status(200).json({ message: 'WhatsApp client initialization started.' });
});

app.post('/stop', (req, res) => {
    if (status !== 'READY' && status !== 'AUTHENTICATED') {
        return res.status(400).json({ message: 'Client is not running.' });
    }
    console.log('Stopping client...');
    client.logout().then(() => {
        updateStatus('DISCONNECTED');
        res.status(200).json({ message: 'Client stopped successfully.' });
    }).catch(err => {
        console.error('Failed to stop client:', err);
        res.status(500).json({ message: 'Failed to stop client.' });
    });
});


server.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
}); 