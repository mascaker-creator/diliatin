/**
 * PROJECT   : WafaMonitor PRO - Cloud Optimized
 * PLATFORM  : Optimized for Railway / Render / VPS
 * FEATURES  : Multi-User, 24h Trial, Admin Control, Auto-Reconnect
 */

const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Datastore = require('nedb-promises');

// --- INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 30000,
    pingInterval: 10000
});

// Port Binding Railway Fix
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = "Wafa12345";

// Database Setup
const db = Datastore.create({ 
    filename: path.join(__dirname, 'system_data.db'), 
    autoload: true 
});

// Memory Store
const activeConnections = new Map();

// --- CONFIGURATION ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// --- CORE FUNCTIONS ---

async function validateUser(ip) {
    try {
        const user = await db.findOne({ ip: ip });
        const now = Date.now();
        const TRIAL_PERIOD = 24 * 60 * 60 * 1000;

        if (!user) {
            await db.insert({ ip: ip, startTime: now, isBlocked: false });
            return { allowed: true };
        }
        if (user.isBlocked) return { allowed: false, msg: "IP ANDA DIBLOKIR" };
        if (now - user.startTime > TRIAL_PERIOD) return { allowed: false, isTrialOver: true, msg: "TRIAL HABIS" };
        
        return { allowed: true };
    } catch (e) {
        return { allowed: false, msg: "DATABASE ERROR" };
    }
}

async function fetchAdminReport() {
    const allUsers = await db.find({}).sort({ startTime: -1 });
    const liveSessions = [];
    activeConnections.forEach((conn, id) => {
        liveSessions.push({ id, ip: conn.userIp, target: conn.targetAccount, uptime: conn.connectedAt });
    });
    return { allUsers, liveSessions };
}

// --- SOCKET ENGINE ---

io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    socket.on('start_monitoring', async (target) => {
        if (!target) return;

        const auth = await validateUser(clientIp);
        if (!auth.allowed) {
            return socket.emit('connection_status', { success: false, msg: auth.msg, isTrialOver: auth.isTrialOver });
        }

        // Cleanup Sesi Lama
        if (activeConnections.has(socket.id)) {
            try { activeConnections.get(socket.id).disconnect(); } catch(e) {}
            activeConnections.delete(socket.id);
        }

        const tiktok = new WebcastPushConnection(target, { enableWebsocketUpgrade: true });

        tiktok.connect().then(() => {
            tiktok.targetAccount = target;
            tiktok.userIp = clientIp;
            tiktok.connectedAt = new Date().toLocaleTimeString('id-ID');
            activeConnections.set(socket.id, tiktok);
            
            socket.emit('connection_status', { success: true });
            fetchAdminReport().then(r => io.emit('admin_update_list', r));
        }).catch(err => {
            socket.emit('connection_status', { success: false, msg: "OFFLINE / SALAH USERNAME", debug: err.message });
        });

        // TIKTOK EVENTS
        tiktok.on('chat', d => socket.emit('server_new_chat', { username: d.uniqueId, comment: d.comment, profilePic: d.profilePictureUrl }));
        tiktok.on('gift', d => {
            if (d.giftType === 1 && !d.repeatEnd) return;
            socket.emit('server_new_gift', { username: d.uniqueId, giftName: d.giftName, count: d.repeatCount, giftIcon: d.giftPictureUrl });
        });
        tiktok.on('roomUser', d => socket.emit('server_update_viewers', { count: d.viewerCount }));
        tiktok.on('streamEnd', () => {
            socket.emit('server_disconnected', { msg: "LIVE BERAKHIR" });
            activeConnections.delete(socket.id);
        });
    });

    // ADMIN ACTIONS
    socket.on('admin_login', (p) => {
        if (p === ADMIN_PASS) {
            socket.emit('login_res', { success: true });
            fetchAdminReport().then(r => socket.emit('admin_update_list', r));
        } else {
            socket.emit('login_res', { success: false });
        }
    });

    socket.on('admin_toggle_block', async (ip) => {
        const user = await db.findOne({ ip });
        if (user) {
            const block = !user.isBlocked;
            await db.update({ ip }, { $set: { isBlocked: block } });
            if (block) {
                activeConnections.forEach((c, id) => {
                    if (c.userIp === ip) {
                        c.disconnect();
                        io.to(id).emit('server_disconnected', { msg: "IP DIBLOKIR" });
                        activeConnections.delete(id);
                    }
                });
            }
            fetchAdminReport().then(r => io.emit('admin_update_list', r));
        }
    });

    socket.on('disconnect', () => {
        if (activeConnections.has(socket.id)) {
            activeConnections.get(socket.id).disconnect();
            activeConnections.delete(socket.id);
        }
    });
});

// --- ROUTES ---
app.get('/', (req, res) => res.render('index'));
app.get('/admin-wafa', (req, res) => res.render('admin'));

// --- START SERVER (RAILWAY FIX) ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`ONLINE_PORT_${PORT}`);
});

// Anti-Crash
process.on('uncaughtException', (err) => console.error('ERROR:', err.message));
