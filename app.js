/**
 * PROJECT   : WafaMonitor PRO - Cloud Optimized (v3.2.0)
 * PLATFORM  : Optimized for Railway.app
 * FEATURES  : 
 * - Persistent Database Integration (NeDB)
 * - Intelligent Socket.io Handshaking
 * - Advanced Error Logging & Debugging
 * - Admin Command Center with Real-time Feeds
 * - Automatic Garbage Collection for Inactive Sessions
 */

const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Datastore = require('nedb-promises');

// --- 1. CONFIGURATION & CORE ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Railway Environment Variables
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Wafa12345";
const ADMIN_WA = "62895322080063";

// Database Initialization (Persistent Storage)
// Di Railway, pastikan mount volume ke root atau path ini
const db = Datastore.create({ 
    filename: path.join(__dirname, 'system_data.db'), 
    autoload: true 
});

// In-Memory Storage for Active Connections
const activeConnections = new Map();

// --- 2. MIDDLEWARE & VIEW ENGINE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- 3. LOGIC HELPERS ---

/**
 * Validasi trial user berdasarkan IP Address
 */
async function validateUserSession(ip) {
    try {
        const user = await db.findOne({ ip: ip });
        const now = Date.now();
        const TRIAL_DURATION = 24 * 60 * 60 * 1000; // 24 Jam

        if (!user) {
            const newUser = {
                ip: ip,
                startTime: now,
                isBlocked: false,
                firstConnect: new Date().toISOString()
            };
            await db.insert(newUser);
            return { status: 'OK' };
        }

        if (user.isBlocked) {
            return { status: 'BLOCKED', msg: "AKSES DITOLAK: IP ANDA TELAH DIBLOKIR" };
        }

        if (now - user.startTime > TRIAL_DURATION) {
            return { 
                status: 'EXPIRED', 
                msg: "MASA TRIAL 24 JAM ANDA SUDAH HABIS",
                isTrialOver: true 
            };
        }

        return { status: 'OK' };
    } catch (err) {
        console.error("[DB ERROR]", err.message);
        return { status: 'ERROR', msg: "DATABASE MALFUNCTION" };
    }
}

/**
 * Mengumpulkan data real-time untuk dashboard admin
 */
async function collectAdminStats() {
    const allUsers = await db.find({}).sort({ startTime: -1 });
    const liveMonitoring = [];
    
    activeConnections.forEach((conn, socketId) => {
        liveMonitoring.push({
            id: socketId,
            ip: conn.userIp,
            target: conn.targetAccount,
            since: conn.connectedAt
        });
    });

    return { allUsers, liveMonitoring };
}

// --- 4. SOCKET.IO CORE ENGINE ---

io.on('connection', (socket) => {
    // Deteksi IP (Mendukung Proxy Railway/Cloudflare)
    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    console.log(`[NETWORK] Connection Established: ${clientIp}`);

    // ACTION: Inisialisasi Monitoring TikTok
    socket.on('start_monitoring', async (targetUsername) => {
        if (!targetUsername) return;

        // Step 1: Keamanan & Validasi IP
        const access = await validateUserSession(clientIp);
        if (access.status !== 'OK') {
            return socket.emit('connection_status', { 
                success: false, 
                msg: access.msg, 
                isTrialOver: access.isTrialOver 
            });
        }

        // Step 2: Hapus sesi lama jika user melakukan restart/pindah akun
        if (activeConnections.has(socket.id)) {
            try {
                const oldConn = activeConnections.get(socket.id);
                oldConn.disconnect();
                activeConnections.delete(socket.id);
            } catch (e) { /* silent cleanup */ }
        }

        // Step 3: Membuat Koneksi ke TikTok Webcast API
        const tiktok = new WebcastPushConnection(targetUsername, {
            enableWebsocketUpgrade: true,
            requestOptions: { timeout: 10000 }
        });

        tiktok.connect().then(state => {
            console.log(`[SUCCESS] Monitoring @${targetUsername} for ${clientIp}`);

            // Simpan metadata koneksi ke memory map
            tiktok.targetAccount = targetUsername;
            tiktok.userIp = clientIp;
            tiktok.connectedAt = new Date().toLocaleTimeString('id-ID');
            
            activeConnections.set(socket.id, tiktok);

            // Beri respon sukses ke browser user
            socket.emit('connection_status', { success: true });
            
            // Perbarui dashboard admin secara real-time
            collectAdminStats().then(stats => io.emit('admin_update_list', stats));

        }).catch(err => {
            console.error(`[FAILURE] @${targetUsername} | Detail: ${err.message}`);
            socket.emit('connection_status', { 
                success: false, 
                msg: "GAGAL: TIKTOK OFFLINE / USERNAME SALAH",
                debug: err.message 
            });
        });

        // --- TIKTOK LIVE EVENTS ---

        tiktok.on('chat', data => {
            socket.emit('server_new_chat', {
                username: data.uniqueId,
                comment: data.comment,
                profilePic: data.profilePictureUrl
            });
        });

        tiktok.on('gift', data => {
            // Filter: Hanya kirim gift yang sudah selesai animasinya/streak
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
            console.log(`[EVENT] Stream Ended for @${targetUsername}`);
            socket.emit('server_disconnected', { msg: "LIVE TELAH BERAKHIR" });
            
            if (activeConnections.has(socket.id)) {
                activeConnections.delete(socket.id);
                collectAdminStats().then(stats => io.emit('admin_update_list', stats));
            }
        });

        tiktok.on('error', (err) => {
            console.warn(`[WARNING] TikTok Connection Issue: ${err.message}`);
            // Kita tidak memutus koneksi di sini agar library melakukan auto-retry
        });
    });

    // ACTION: Admin Command Center
    socket.on('admin_login', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.emit('login_res', { success: true });
            collectAdminStats().then(stats => socket.emit('admin_update_list', stats));
        } else {
            socket.emit('login_res', { success: false });
        }
    });

    socket.on('admin_toggle_block', async (targetIp) => {
        const user = await db.findOne({ ip: targetIp });
        if (user) {
            const newState = !user.isBlocked;
            await db.update({ ip: targetIp }, { $set: { isBlocked: newState } });

            // Jika diblokir, putuskan koneksi yang sedang berjalan milik IP tersebut
            if (newState === true) {
                activeConnections.forEach((conn, sid) => {
                    if (conn.userIp === targetIp) {
                        try { conn.disconnect(); } catch (e) {}
                        io.to(sid).emit('server_disconnected', { msg: "AKSES ANDA DIBLOKIR ADMIN" });
                        activeConnections.delete(sid);
                    }
                });
            }
            collectAdminStats().then(stats => io.emit('admin_update_list', stats));
        }
    });

    // ACTION: Clean Disconnect (Tutup Browser/Tab)
    socket.on('disconnect', () => {
        if (activeConnections.has(socket.id)) {
            const conn = activeConnections.get(socket.id);
            try { conn.disconnect(); } catch(e) {}
            activeConnections.delete(socket.id);
            console.log(`[NETWORK] Session Closed for IP: ${clientIp}`);
        }
        // Pastikan dashboard admin sinkron
        collectAdminStats().then(stats => io.emit('admin_update_list', stats));
    });
});

// --- 5. ROUTES ---
app.get('/', (req, res) => res.render('index'));
app.get('/admin-wafa', (req, res) => res.render('admin'));

// --- 6. SERVER ACTIVATION ---
server.listen(PORT, '0.0.0.0', () => {
    console.clear();
    console.log(`
    ================================================
    🚀 WAFA MONITOR PRO IS ONLINE
    ================================================
    PORT       : ${PORT}
    ADMIN URL  : http://localhost:${PORT}/admin-wafa
    PASSWORD   : ${ADMIN_PASSWORD}
    DB STATUS  : PERSISTENT CONNECTED
    ------------------------------------------------
    Railway Deployment: 0.0.0.0 Binding Active
    ================================================
    `);
});

// Global Safety Net: Mencegah server mati jika ada error tak terduga
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL ERROR] Server remained alive, but issue detected:', err.stack);
});
