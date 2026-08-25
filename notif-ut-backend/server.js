const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const http = require('http');
const pino = require('pino');

// ==========================================
// 1. SERVER HEALTH-CHECK (MENJAGA BOT HIDUP 24 JAM DI RENDER)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot UT WhatsApp (Baileys Engine) is Alive & Running 24/7!\n');
}).listen(PORT, () => {
    console.log(`🌐 Health-Check Server berjalan di port ${PORT}`);
});

// ==========================================
// 2. KONFIGURASI SUPABASE
// ==========================================
const SUPABASE_URL = "https://mzxrcslawziuvzqpwbjs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fdJvajntNzea73UkHOvBmg_tKRkvwG5";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Helper Delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Variabel Socket Global
let sock;

// ==========================================
// 3. INISIALISASI BOT WHATSAPP (BAILEYS)
// ==========================================
async function startBot() {
    // Menyimpan sesi secara lokal di folder 'baileys_auth'
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }), // Mematikan log sampah Baileys
        browser: ['Notif-UT Bot', 'Chrome', '1.0.0']
    });

    // Simpan kredensial jika ada perubahan/penyegaran token
    sock.ev.on('creds.update', saveCreds);

    // Event Status Koneksi & QR Code
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Cetak QR Code di Logs Render / Terminal
        if (qr) {
            console.log('\n=== SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP HP KAMU ===\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Koneksi terputus (Reason: ${statusCode}). Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                setTimeout(() => startBot(), 3000); // Reconnect otomatis
            }
        } else if (connection === 'open') {
            console.log('\n✅ WhatsApp Client (Baileys) Berhasil Terhubung & Siap 24 Jam!\n');
        }
    });

    // Event Auto-Reply Pesan Masuk
    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            
            // Abaikan grup WA
            if (from.endsWith('@g.us')) return;

            // Ambil teks isi pesan
            const teks = (
                msg.message.conversation || 
                msg.message.extendedTextMessage?.text || 
                ''
            ).trim().toUpperCase();

            if (!teks) return;

            // Ekstraksi Nomor HP Asli
            let nomorTeleponMurni = from.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0].replace(/[^0-9]/g, '');

            let nomor62 = nomorTeleponMurni.startsWith('0') ? '62' + nomorTeleponMurni.slice(1) : nomorTeleponMurni;
            let nomor08 = nomorTeleponMurni.startsWith('62') ? '0' + nomorTeleponMurni.slice(2) : nomorTeleponMurni;
            let nomorPlus62 = '+' + nomor62;

            // A. FITUR UNSUBSCRIBE (STOP)
            if (teks === 'STOP') {
                console.log(`\n[PROSES STOP] Menerima instruksi STOP dari Nomor: ${nomor62} / ${nomor08}`);

                const { data, error } = await supabase
                    .from('mahasiswa')
                    .update({ status_aktif: false })
                    .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
                    .select();

                if (error) {
                    console.error('❌ [DATABASE ERROR] Gagal update status_aktif:', error.message);
                    await sock.sendMessage(from, { text: '❌ Gagal memproses penonaktifan. Silakan coba lagi nanti.' });
                } else if (!data || data.length === 0) {
                    console.log('⚠️ [WARNING] Nomor HP tidak ditemukan di database Supabase.');
                    await sock.sendMessage(from, { text: '🛑 Nomor Anda tidak terdaftar di sistem pendaftaran.' });
                } else {
                    console.log(`✅ [UNSUBSCRIBE SUKSES] Status ${data[0].nama} (${nomor62}) diubah menjadi status_aktif = FALSE`);
                    await sock.sendMessage(from, { text: '🛑 *Layanan Notifikasi Diberhentikan.*\n\nAnda tidak akan menerima pengingat jadwal Tuton UT lagi. Jika ingin mendaftar ulang, silakan akses kembali website pendaftaran.' });
                }
                return;
            }

            // B. FITUR CEK JADWAL
            if (teks === 'JADWAL' || teks === 'INFO' || teks === 'CEK JADWAL') {
                const { data: mhs } = await supabase
                    .from('mahasiswa')
                    .select('nama')
                    .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
                    .single();

                const namaUser = mhs ? mhs.nama : 'Mahasiswa UT';

                const { data: daftarJadwal, error } = await supabase
                    .from('jadwal_tuton')
                    .select('*')
                    .eq('tipe_pengingat', 'SESI_BUKA')
                    .order('id', { ascending: true });

                if (error || !daftarJadwal || daftarJadwal.length === 0) {
                    await sock.sendMessage(from, { text: `Halo *${namaUser}*,\n\nSaat ini daftar jadwal Tuton 1 semester belum tersedia di database.` });
                    return;
                }

                let balasanJadwal = `📅 *[KALENDER TUTON UT 2026 GENAP]*\n\nHalo *${namaUser}*, berikut jadwal Sesi 1 s.d. 8:\n\n`;

                daftarJadwal.forEach((j) => {
                    const tglBuka = new Date(j.waktu_kirim).toLocaleDateString('id-ID', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric'
                    });

                    balasanJadwal += `📌 *${j.nama_sesi}*\n`;
                    balasanJadwal += `🟢 Tanggal Buka Sesi: _${tglBuka}_\n`;
                    balasanJadwal += `📘 Deadline Sesi : _${j.deadline_non_praktik}_\n\n`;
                });

                balasanJadwal += `-----------------------------------\n`;
                balasanJadwal += `_Ketik *STOP* untuk berhenti berlangganan._`;

                await sock.sendMessage(from, { text: balasanJadwal });
                return;
            }

            // C. BANTUAN / FALLBACK
            const pesanBantuan = `🤖 *[BOT NOTIF-UT]*\n\nHalo! Saya adalah bot pengingat otomatis Tuton UT. Kata kunci yang dapat kamu gunakan:\n\n` +
                `👉 *JADWAL* : Cek kalender jadwal Tuton 1 semester (Sesi 1-8).\n` +
                `👉 *STOP* : Berhenti menerima notifikasi pengingat.`;
            
            await sock.sendMessage(from, { text: pesanBantuan });
        } catch (err) {
            console.error('Error handling message:', err);
        }
    });
}

// ==========================================
// 4. LOGIKA PENGIRIMAN PESAN MASSAL (BLAST NOTIFIKASI)
// ==========================================
async function kirimNotifikasiMassal(jadwal) {
    if (!sock) return;

    console.log(`\n[SCHEDULER] Menjalankan pengiriman notifikasi: ${jadwal.nama_sesi}`);

    const { data: daftarMahasiswa, error } = await supabase
        .from('mahasiswa')
        .select('*')
        .eq('status_aktif', true);

    if (error || !daftarMahasiswa || daftarMahasiswa.length === 0) {
        console.log('⚠️ Tidak ada mahasiswa AKTIF untuk dikirimkan notifikasi.');
        return;
    }

    console.log(`📌 Memproses pengiriman ke ${daftarMahasiswa.length} mahasiswa aktif.`);

    for (const mhs of daftarMahasiswa) {
        if (mhs.status_aktif !== true) continue;

        let nomorBersih = String(mhs.nomor_wa).replace(/[^0-9]/g, '');
        if (nomorBersih.startsWith('0')) {
            nomorBersih = '62' + nomorBersih.slice(1);
        }

        // Format JID Baileys menggunakan suffix @s.whatsapp.net
        const targetWa = `${nomorBersih}@s.whatsapp.net`;

        let headerNotif = "📢 [NOTIF-UT] Pengingat Sesi Baru";
        if (jadwal.tipe_pengingat === "H-7 DEADLINE") {
            headerNotif = "🗓️ [NOTIF-UT] Pengingat H-7 Deadline";
        } else if (jadwal.tipe_pengingat === "H-3 DEADLINE") {
            headerNotif = "⚠️ [NOTIF-UT] Pengingat H-3 Deadline";
        } else if (jadwal.tipe_pengingat === "H-1 DEADLINE") {
            headerNotif = "⏰ [NOTIF-UT] Peringatan BESOK DEADLINE!";
        } else if (jadwal.tipe_pengingat === "HARI-H DEADLINE") {
            headerNotif = "🚨🔥 [NOTIF-UT] LAST CHANCE - DEADLINE HARI INI!";
        }

        const pesan = `${headerNotif}

Halo *${mhs.nama}* (${mhs.jurusan}),
Berikut pengingat batas waktu untuk *${jadwal.nama_sesi}*:

📘 Deadline Sesi : _${jadwal.deadline_non_praktik}_

⚠️ _Segera selesaikan dan unggah tugas/diskusi kamu di elearning.ut.ac.id sebelum pukul 23.59 WIB!_
-----------------------------------
_Ketik *JADWAL* untuk cek kalender lengkap | Ketik *STOP* untuk berhenti._`;

        try {
            await sock.sendMessage(targetWa, { text: pesan });
            console.log(`✅ Pesan terkirim ke: ${mhs.nama} (${nomorBersih})`);

            await supabase.from('log_pengiriman').insert([{
                mahasiswa_id: mhs.id,
                jadwal_id: jadwal.id,
                nomor_wa: nomorBersih,
                status_kirim: 'SUCCESS'
            }]);
        } catch (err) {
            console.error(`❌ Gagal mengirim ke ${nomorBersih}:`, err.message || err);
        }

        await sleep(1500); // Delay 1.5 detik
    }

    await supabase.from('jadwal_tuton').update({ status_terkirim: true }).eq('id', jadwal.id);
}

// ==========================================
// 5. CRONJOB SCHEDULER
// ==========================================
cron.schedule('* * * * *', async () => {
    const sekarang = new Date().toISOString();

    const { data: jadwalPending } = await supabase
        .from('jadwal_tuton')
        .select('*')
        .lte('waktu_kirim', sekarang)
        .eq('status_terkirim', false);

    if (jadwalPending && jadwalPending.length > 0) {
        for (const jadwal of jadwalPending) {
            await kirimNotifikasiMassal(jadwal);
        }
    }
});

// Start Engine
startBot();
