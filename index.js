const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const admin = require('firebase-admin');
const fs = require('fs');
const prompts = require('prompts');
const axios = require('axios');

const CONFIG_PATH = './config.json';
const SERVICE_ACCOUNT_PATH = './serviceAccountKey.json';

let selectedFcmToken; // This will hold the token for the chosen device

// --- Main Application Logic ---
async function main() {
    console.log('--- WhatsApp Notifier Server ---');

    // 1. Load Config and Service Account
    const config = loadConfig();
    if (!config) return; // Stop if config is invalid or missing

    const serviceAccount = loadServiceAccount();
    if (!serviceAccount) return;

    // 2. Initialize Firebase
    initializeFirebase(serviceAccount);
    const db = admin.firestore();

    // 3. User Login
    const user = await login(config);
    if (!user) {
        console.error('Login failed. Exiting.');
        return;
    }
    console.log(`Successfully logged in as user: ${user.uid}`);

    // 4. Select Device
    selectedFcmToken = await selectDevice(db, user.uid);
    if (!selectedFcmToken) {
        console.error('No device selected. Exiting.');
        return;
    }
    console.log(`Device selected. Notifications will be sent to this device.`);

    // 5. Initialize WhatsApp Client
    initializeWhatsAppClient(config);
}

// --- Helper Functions ---

/**
 * Loads and validates the main config file.
 * Creates a template if it doesn't exist.
 */
function loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        console.log('`config.json` not found. Creating a template.');
        const template = {
            chromePath: '',
            firebaseApiKey: 'YOUR_FIREBASE_WEB_API_KEY_HERE'
        };
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2));
        console.error('Please fill in your Firebase Web API Key in `config.json` and restart the server.');
        return null;
    }

    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        if (!config.firebaseApiKey || config.firebaseApiKey.includes('YOUR_FIREBASE')) {
            console.error('Error: `firebaseApiKey` is not set in `config.json`. Please add it and restart.');
            return null;
        }
        return config;
    } catch (e) {
        console.error('[Config] Error reading or parsing config.json:', e);
        return null;
    }
}

/**
 * Loads the Firebase service account key.
 */
function loadServiceAccount() {
    if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
        console.error(`Error: Firebase service account key not found at '${SERVICE_ACCOUNT_PATH}'.`);
        console.error('Please download it from your Firebase project settings and place it in the root directory.');
        return null;
    }
    try {
        return require(SERVICE_ACCOUNT_PATH);
    } catch (e) {
        console.error('Error reading or parsing service account key file:', e);
        return null;
    }
}


/**
 * Initializes the Firebase Admin SDK.
 */
function initializeFirebase(serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized.');
}

/**
 * Prompts user for email/password and signs them in via Firebase Auth REST API.
 * @param {object} config - The application config containing the Firebase API key.
 * @returns {Promise<object|null>} Firebase user object or null.
 */
async function login(config) {
    const response = await prompts([
        {
            type: 'text',
            name: 'email',
            message: 'Please enter your email:'
        },
        {
            type: 'password',
            name: 'password',
            message: 'Please enter your password:'
        }
    ]);

    try {
        const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.firebaseApiKey}`;
        const authResponse = await axios.post(authUrl, {
            email: response.email,
            password: response.password,
            returnSecureToken: true
        });
        return {
            uid: authResponse.data.localId,
            token: authResponse.data.idToken
        };
    } catch (error) {
        console.error('Authentication failed:', error.response ? error.response.data.error.message : error.message);
        return null;
    }
}

/**
 * Fetches the user's devices from Firestore and prompts for selection.
 * @param {object} db - The Firestore database instance.
 * @param {string} uid - The user's ID.
 * @returns {Promise<string|null>} The selected device's FCM token or null.
 */
async function selectDevice(db, uid) {
    const devicesRef = db.collection('users').doc(uid).collection('devices');
    const snapshot = await devicesRef.get();

    if (snapshot.empty) {
        console.log('No registered devices found for this user.');
        return null;
    }

    const deviceChoices = snapshot.docs.map(doc => ({
        title: `Device: ${doc.id} (${doc.data().platform || 'Unknown OS'})`,
        description: `Token: ${doc.data().fcm_token.substring(0, 20)}...`,
        value: doc.data().fcm_token
    }));

    const response = await prompts({
        type: 'select',
        name: 'fcmToken',
        message: 'Please select the device to send notifications to:',
        choices: deviceChoices
    });

    return response.fcmToken;
}

/**
 * Initializes the WhatsApp client and sets up event listeners.
 */
function initializeWhatsAppClient(config) {
    const puppeteerConfig = {};
     if (config.chromePath && config.chromePath.trim() !== '') {
        puppeteerConfig.executablePath = config.chromePath.trim();
        console.log(`[Config] Using custom Chrome path: ${puppeteerConfig.executablePath}`);
    }

    const client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: puppeteerConfig
    });

    client.on('qr', (qr) => {
        console.log('QR code received, please scan:');
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log('WhatsApp client is ready!');
        console.log('Listening for messages with keywords: urgent, important, asap');
    });

    client.on('message', (message) => {
        console.log(`New message from ${message.from}: "${message.body}"`);
        const keywords = ['urgent', 'important', 'asap'];
        const messageBody = message.body.toLowerCase();
        const foundKeyword = keywords.find(keyword => messageBody.includes(keyword));

        if (foundKeyword) {
            console.log(`Keyword "${foundKeyword}" found! Triggering notification.`);
            sendNotification(message, foundKeyword);
        }
    });
    
    client.on('auth_failure', msg => console.error('Authentication failed:', msg));
    client.on('disconnected', reason => console.log('Client was logged out', reason));
    
    client.initialize();
}

/**
 * Sends a push notification via FCM to the globally selected device.
 * @param {object} message - The WhatsApp message object.
 * @param {string} keyword - The keyword that was matched.
 */
function sendNotification(message, keyword) {
    if (!selectedFcmToken) {
        console.error('Error: No FCM token selected. Cannot send notification.');
        return;
    }

    const fromName = message._data.notifyName || message.from.replace('@c.us', '');
    const notificationPayload = {
        notification: {
            title: `New "${keyword}" message from ${fromName}`,
            body: message.body
        },
        token: selectedFcmToken
    };

    admin.messaging().send(notificationPayload)
        .then((response) => {
            console.log('Successfully sent notification:', response);
        })
        .catch((error) => {
            console.error('Error sending notification:', error);
        });
}

// --- Start the application ---
main(); 