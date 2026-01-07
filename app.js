/**
 * PROJECT   : WafaMonitor PRO - Ultimate Edition (v3.0)
 * AUTHOR    : Wafan & Gemini Partner
 * STATUS    : Production Ready
 * FEATURES  : 
 * - Intelligent Multi-User Management
 * - Persistent IP Tracking (24-Hour Trial System)
 * - Anti-Memory Leak Logic
 * - Real-time Admin Command Center
 * - Silent Auto-Reconnect on Internet Drop
 * - Detailed Connection Debugging
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
    connectionStateRecovery: {} // Fitur Socket.io agar koneksi tidak gampang putus
});

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = "Wafa12345";
const ADMIN_WA = "62895322080063";

// Inisialisasi Database (system_data.db)
const db = Datastore.create({ 
    filename: path.join(__dirname, 'system_data.db'), 
    autoload: true 
});

// --- STATE MANAGEMENT ---
// Key: SocketID, Value: { connection, ip, target, joinedAt }
const activeConnections = new Map();

// --- SETTINGS & MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- CORE UTILS ---

/**
 * Validasi Hak Akses User (Trial & Block)
 */
async function checkUserPrivilege(ip) {
    try {
        const user = await db.findOne({ ip: ip });
        const now = Date.now();
        const ONE_DAY = 24 * 60 * 60 * 1000;

        if (!user) {
            // User Baru: Mulai Trial
            const newUser = {
                ip: ip,
                startTime: now,
                isBlocked: false,
                lastSeen: new Date().toISOString(),
                totalSessions: 1
            };
            await db.insert(newUser);
            return { status: 'ALLOWED' };
        }

        if (user.isBlocked) {
            return { status: 'BLOCKED', msg: "AKSES DITOLAK: IP ANDA DIBLOKIR ADMIN" };
        }

        if (now - user.startTime > ONE_DAY) {
            return { status: 'EXPIRED', msg: "TRIAL 24 JAM HABIS. SILAKAN AKTIVASI." };
        }

        // Update User Activity
        await db.update({ ip: ip }, { $inc: { totalSessions: 1 }, $set: { lastSeen: new Date().toISOString() } });
        return { status: 'ALLOWED' };
    } catch (err) {
        console.error("DB_ERROR:", err);
        return { status: 'ERROR' };
    }
}

/**
 * Fetch Laporan Terkini untuk Admin Dashboard
 */
async function generateAdminReport() {
    const allUsers = await db.find({}).sort({ startTime: -1 });
    const liveSessions = [];
    
    activeConnections.forEach((conn, socketId) => {
        liveSessions.push({
            id: socketId,
            ip: conn.userIp,
            target: conn.targetAccount,
            uptime: conn.connectedAt
        });
    });

    return { allUsers, liveSessions };
}

// --- SOCKET.IO ENGINE ---

io.on('connection', (socket) => {
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    console.log(`[NET] Client Connected: ${clientIp} | ID: ${socket.id}`);

    // ACTION: Mulai Monitoring TikTok
    socket.on('start_monitoring', async (targetUser) => {
        if (!targetUser) return;

        // 1. Validasi Keamanan
        const access = await checkUserPrivilege(clientIp);
        if (access.status !== 'ALLOWED') {
            return socket.emit('connection_status', { 
                success: false, 
                msg: access.msg, 
                isTrialOver: access.status === 'EXPIRED' 
            });
        }

        // 2. Cleanup Sesi Lama (Anti-Memory Leak)
        if (activeConnections.has(socket.id)) {
            const oldConn = activeConnections.get(socket.id);
            try { oldConn.disconnect(); } catch(e) {}
            activeConnections.delete(socket.id);
        }

        // 3. Inisialisasi TikTok Connector (Gaya Klasik - Paling Stabil)
        const tiktok = new WebcastPushConnection(targetUser, {
            enableWebsocketUpgrade: true,
            processInitialData: false
        });

        // 4. Eksekusi Koneksi
        tiktok.connect().then(state => {
            console.log(`[TIKTOK] Success: @${targetUser} by ${clientIp}`);

            // Simpan Metadata ke Memory Map
            tiktok.targetAccount = targetUser;
            tiktok.userIp = clientIp;
            tiktok.connectedAt = new Date().toLocaleTimeString('id-ID');
            
            activeConnections.set(socket.id, tiktok);

            // Beritahu Client
            socket.emit('connection_status', { success: true });
            
            // Broadcast ke Admin Dashboard
            generateAdminReport().then(report => io.emit('admin_update_list', report));

        }).catch(err => {
            console.error(`[TIKTOK] Fail: @${targetUser} | Reason: ${err.message}`);
            socket.emit('connection_status', { 
                success: false, 
                msg: "TIKTOK OFFLINE / USERNAME SALAH",
                debug: err.message 
            });
        });

        // --- TIKTOK EVENTS HANDLING ---

        tiktok.on('chat', data => {
            socket.emit('server_new_chat', {
                username: data.uniqueId,
                comment: data.comment,
                profilePic: data.profilePictureUrl
            });
        });

        tiktok.on('gift', data => {
            if (data.giftType === 1 && !data.repeatEnd) return;
            socket.emit('server_new_gift', {
                username: data.uniqueId,
                giftName: data.giftName,
                count: data.repeatCount,
                giftIcon: data.giftPictureUrl
            });
        });

        tiktok.on('roomUser', data => {
            socket.emit('server_update_viewers', { count: data.viewerCount });
        });

        tiktok.on('streamEnd', () => {
            console.log(`[TIKTOK] Stream ended for @${targetUser}`);
            socket.emit('server_disconnected', { msg: "LIVE TELAH BERAKHIR" });
            activeConnections.delete(socket.id);
            generateAdminReport().then(report => io.emit('admin_update_list', report));
        });

        tiktok.on('error', (err) => {
            console.error(`[TIKTOK] Runtime Error: ${err.message}`);
            // Jangan disconnect paksa di sini, biarkan library mencoba auto-reconnect
        });
    });

    // ACTION: Admin Login
    socket.on('admin_login', (password) => {
        if (password === ADMIN_PASSWORD) {
            socket.emit('login_res', { success: true });
            generateAdminReport().then(report => socket.emit('admin_update_list', report));
        } else {
            socket.emit('login_res', { success: false });
        }
    });

    // ACTION: Admin Block/Unblock
    socket.on('admin_toggle_block', async (targetIp) => {
        const user = await db.findOne({ ip: targetIp });
        if (user) {
            const newState = !user.isBlocked;
            await db.update({ ip: targetIp }, { $set: { isBlocked: newState } });

            // Jika diblokir, tendang semua koneksi aktif milik IP tersebut
            if (newState === true) {
                activeConnections.forEach((conn, sid) => {
                    if (conn.userIp === targetIp) {
                        try { conn.disconnect(); } catch(e) {}
                        io.to(sid).emit('server_disconnected', { msg: "AKSES ANDA DIBLOKIR ADMIN" });
                        activeConnections.delete(sid);
                    }
                });
            }
            generateAdminReport().then(report => io.emit('admin_update_list', report));
        }
    });

    // ACTION: User Disconnect (Tutup Tab)
    socket.on('disconnect', () => {
        if (activeConnections.has(socket.id)) {
            const conn = activeConnections.get(socket.id);
            try { conn.disconnect(); } catch(e) {}
            activeConnections.delete(socket.id);
            console.log(`[NET] Sesi ditutup: @${conn.targetAccount}`);
        }
        // Update dashboard admin secara real-time
        generateAdminReport().then(report => io.emit('admin_update_list', report));
    });
});

// --- ROUTES ---
app.get('/', (req, res) => res.render('index'));
app.get('/admin-wafa', (req, res) => res.render('admin'));

// --- START SERVER ---
server.listen(PORT, '0.0.0.0', () => {
    console.clear();
    console.log(`
    ┌────────────────────────────────────────────────────────┐
    │  WAFA MONITOR PRO SYSTEM v3.0                          │
    ├────────────────────────────────────────────────────────┤
    │  SERVER RUNNING ON PORT : ${PORT}                         │
    │  LOCAL ACCESS           : http://localhost:${PORT}        │
    │  ADMIN ACCESS           : /admin-wafa                  │
    │  ADMIN PASSWORD         : ${ADMIN_PASSWORD}                    │
    ├────────────────────────────────────────────────────────┤
    │  SISTEM MULTI-USER & TRIAL IP AKTIF                    │
    └────────────────────────────────────────────────────────┘
    `);
});

// ERROR CATCHER (Mencegah Server Mati Total)
process.on('uncaughtException', (err) => {
    console.error('CRITICAL_ERROR_DETECTED:', err.message);
});
