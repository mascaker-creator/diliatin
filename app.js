/**
 * PROJECT: TikTok Live Monitoring Dashboard (Dynamic Version)
 * ROLE: Fullstack Backend Controller
 * DESCRIPTION: Menangani input username dari web, koneksi ke TikTok, 
 * dan distribusi data ke views/index.ejs secara real-time.
 */

const { WebcastPushConnection } = require('tiktok-live-connector');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

// --- INITIALIZATION ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// --- MIDDLEWARE ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// --- STATE MANAGEMENT ---
// Variabel untuk menyimpan koneksi yang sedang aktif
let tiktokConn = null;
let currentTarget = "";

// --- SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
    console.log(`🌐 Browser terhubung: ${socket.id}`);

    /**
     * Listener: Memulai Monitoring
     * Dipicu saat user memasukkan username di Frontend
     */
    socket.on('start_monitoring', (targetUsername) => {
        if (!targetUsername) return;

        console.log(`[SYSTEM] Mencoba menyambung ke: @${targetUsername}`);

        // 1. Putuskan koneksi lama jika sedang berjalan
        if (tiktokConn) {
            console.log(`[SYSTEM] Memutuskan koneksi sebelumnya (@${currentTarget})`);
            tiktokConn.disconnect();
            tiktokConn = null;
        }

        // 2. Inisialisasi koneksi baru
        currentTarget = targetUsername;
        tiktokConn = new WebcastPushConnection(targetUsername, {
            enableWebsocketUpgrade: true,
            requestPollingIntervalMs: 2000
        });

        // 3. Proses Koneksi
        tiktokConn.connect().then(state => {
            console.info(`✅ TERHUBUNG: Room ID ${state.roomId}`);
            socket.emit('connection_status', { 
                success: true, 
                msg: `Berhasil memantau @${targetUsername}` 
            });
        }).catch(err => {
            console.error("❌ KONEKSI GAGAL:", err.message);
            socket.emit('connection_status', { 
                success: false, 
                msg: `Gagal: Akun tidak ditemukan atau sedang offline.` 
            });
        });

        // --- TIKTOK EVENT LISTENERS ---

        // Event: Chat Masuk
        tiktokConn.on('chat', (data) => {
            const chatPayload = {
                username: data.uniqueId,
                nickname: data.nickname,
                comment: data.comment,
                profilePic: data.profilePictureUrl,
                timestamp: new Date().toLocaleTimeString('id-ID')
            };
            io.emit('server_new_chat', chatPayload);
        });

        // Event: Hadiah (Gift)
        tiktokConn.on('gift', (data) => {
            // Kita ambil gift yang sudah selesai (repeatEnd) atau gift besar (type 1)
            if (data.giftType === 1 && !data.repeatEnd) return;

            const giftPayload = {
                username: data.uniqueId,
                giftName: data.giftName,
                count: data.repeatCount,
                giftIcon: data.giftPictureUrl
            };
            io.emit('server_new_gift', giftPayload);
            console.log(`[GIFT] @${data.uniqueId} -> ${data.giftName} x${data.repeatCount}`);
        });

        // Event: Jumlah Penonton
        tiktokConn.on('roomUser', (data) => {
            io.emit('server_update_viewers', { count: data.viewerCount });
        });

        // Event: Diskoneksi tak terduga
        tiktokConn.on('disconnected', () => {
            console.warn("⚠️ Koneksi TikTok terputus secara sepihak.");
            io.emit('server_disconnected', { msg: "Koneksi ke TikTok terputus." });
        });

        // Event: Error
        tiktokConn.on('error', (err) => {
            console.error("❗ TikTok Connector Error:", err);
        });
    });

    // Handle saat browser ditutup
    socket.on('disconnect', () => {
        console.log(`❌ Browser terputus: ${socket.id}`);
    });
});

// --- ROUTING ---
app.get('/', (req, res) => {
    res.render('index');
});

// --- SERVER START ---
server.listen(PORT, () => {
    console.log("===============================================");
    console.log(`🚀 MONITORING DASHBOARD ACTIVE ON PORT ${PORT}`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
    console.log("===============================================");
});