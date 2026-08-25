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
// 1. SERVER HEALTH-CHECK (DUMMY HTTP FOR RENDER)
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sock;
let isReady = false; // Flag untuk memastikan sesi WA sudah benar-benar siap

// ==========================================
// 3. INISIALISASI BOT WHATSAPP (WA BUSINESS COMPATIBLE)
// ==========================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Notif-UT Business', 'Chrome', '1.0.0'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n=== SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP HP KAMU ===\n');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Koneksi terputus (Reason Code: ${statusCode})`);

            // Reason 515 = Restart Required (Sangat sering di WA Business saat awal terkoneksi)
            if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                console.log('🔄 [RESTART REQUIRED] Melakukan koneksi ulang untuk menyingkronkan sesi...');
                setTimeout(() => startBot(), 2000);
            } else if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting otomatis...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('❌ Anda telah Log Out. Silakan hapus folder baileys_auth dan restart aplikasi.');
            }
        } else if (connection === 'open') {
            console.log('⏳ Sinkronisasi sesi WhatsApp Business...');
            // Beri jeda 5 detik setelah terhubung agar Signal Keys WA Business tersimpan sempurna
            await sleep(5000);
            isReady = true;
            console.log('\n✅ WhatsApp Client (Baileys) Berhasil Terhubung & Siap 100%!\n');
        }
    });

    // AUTO-REPLY MESSAGES HANDLER
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const from = msg.key.remoteJid;
                if (!from || from.endsWith('@g.us')) continue;

                const teks = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim().toUpperCase();

                if (!teks) continue;

                let nomorTeleponMurni = from.replace('@s.whatsapp.net', '').replace('@lid', '').split(':')[0].replace(/[^0-9]/g, '');
                let nomor62 = nomorTeleponMurni.startsWith('0') ? '62' + nomorTeleponMurni.slice(1) : nomorTeleponMurni;
                let nomor08 = nomorTeleponMurni.startsWith('62') ? '0' + nomorTeleponMurni.slice(2) : nomorTeleponMurni;
                let nomorPlus62 = '+' + nomor62;

                console.log(`📩 [PESAN MASUK] Dari: ${nomor62} | Pesan: "${teks}"`);

                // A. FITUR UNSUBSCRIBE (STOP)
                if (teks === 'STOP') {
                    const { data, error } = await supabase
                        .from('mahasiswa')
                        .update({ status_aktif: false })
                        .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
                        .select();

                    if (error) {
                        await sock.sendMessage(from, { text: '❌ Gagal memproses penonaktifan. Silakan coba lagi nanti.' });
                    } else if (!data || data.length === 0) {
                        await sock.sendMessage(from, { text: '🛑 Nomor Anda tidak terdaftar di sistem pendaftaran.' });
                    } else {
                        await sock.sendMessage(from, { text: '🛑 *Layanan Notifikasi Diberhentikan.*\n\nAnda tidak akan menerima pengingat jadwal Tuton UT lagi.' });
                    }
                    continue;
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
                        continue;
                    }

                    let balasanJadwal = `📅 *[KALENDER TUTON UT 2026 GENAP]*\n\nHalo *${namaUser}*, berikut jadwal Sesi 1 s.d. 8:\n\n`;
                    daftarJadwal.forEach((j) => {
                        const tglBuka = new Date(j.waktu_kirim).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
                        balasanJadwal += `📌 *${j.nama_sesi}*\n🟢 Tanggal Buka Sesi: _${tglBuka}_\n📘 Deadline Sesi : _${j.deadline_non_praktik}_\n\n`;
                    });
                    balasanJadwal += `-----------------------------------\n_Ketik *STOP* untuk berhenti berlangganan._`;

                    await sock.sendMessage(from, { text: balasanJadwal });
                    continue;
                }

                // C. BANTUAN / FALLBACK
                const pesanBantuan = `🤖 *[BOT NOTIF-UT]*\n\nHalo! Saya adalah bot pengingat otomatis Tuton UT. Kata kunci yang dapat kamu gunakan:\n\n` +
                    `👉 *JADWAL* : Cek kalender jadwal Tuton 1 semester (Sesi 1-8).\n` +
                    `👉 *STOP* : Berhenti menerima notifikasi pengingat.`;

                await sock.sendMessage(from, { text: pesanBantuan });
            }
        } catch (err) {
            console.error('❌ Error Handling Message:', err);
        }
    });
}

// ==========================================
// 4. LOGIKA PENGIRIMAN PESAN MASSAL (BLAST NOTIFIKASI)
// ==========================================
async function kirimNotifikasiMassal(jadwal) {
    if (!sock || !isReady) {
        console.log('⚠️ Sesi WhatsApp belum siap, menunda pengiriman notifikasi...');
        return;
    }

    console.log(`\n[SCHEDULER] Menjalankan pengiriman notifikasi: ${jadwal.nama_sesi}`);

    const { data: daftarMahasiswa, error } = await supabase
        .from('mahasiswa')
        .select('*')
        .eq('status_aktif', true);

    if (error || !daftarMahasiswa || daftarMahasiswa.length === 0) {
        console.log('⚠️ Tidak ada mahasiswa AKTIF untuk dikirimkan notifikasi.');
        return;
    }

    for (const mhs of daftarMahasiswa) {
        if (mhs.status_aktif !== true) continue;

        let nomorBersih = String(mhs.nomor_wa).replace(/[^0-9]/g, '');
        if (nomorBersih.startsWith('0')) {
            nomorBersih = '62' + nomorBersih.slice(1);
        }

        try {
            // Verifikasi pendaftaran nomor via Server WA
            const [result] = await sock.onWhatsApp(nomorBersih);
            
            if (!result || !result.exists) {
                console.error(`❌ Nomor ${nomorBersih} tidak terdaftar di WhatsApp.`);
                continue;
            }

            const targetJid = result.jid;

            let headerNotif = "📢 [NOTIF-UT] Pengingat Sesi Baru";
            if (jadwal.tipe_pengingat === "H-7 DEADLINE") headerNotif = "🗓️ [NOTIF-UT] Pengingat H-7 Deadline";
            else if (jadwal.tipe_pengingat === "H-3 DEADLINE") headerNotif = "⚠️ [NOTIF-UT] Pengingat H-3 Deadline";
            else if (jadwal.tipe_pengingat === "H-1 DEADLINE") headerNotif = "⏰ [NOTIF-UT] Peringatan BESOK DEADLINE!";
            else if (jadwal.tipe_pengingat === "HARI-H DEADLINE") headerNotif = "🚨🔥 [NOTIF-UT] LAST CHANCE - DEADLINE HARI INI!";

            const pesan = `${headerNotif}\n\nHalo *${mhs.nama}* (${mhs.jurusan}),\nBerikut pengingat batas waktu untuk *${jadwal.nama_sesi}*:\n\n📘 Deadline Sesi : _${jadwal.deadline_non_praktik}_\n\n⚠️ _Segera selesaikan dan unggah tugas/diskusi kamu di elearning.ut.ac.id sebelum pukul 23.59 WIB!_\n-----------------------------------\n_Ketik *JADWAL* untuk cek kalender lengkap | Ketik *STOP* untuk berhenti._`;

            await sock.sendMessage(targetJid, { text: pesan });
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

        await sleep(2000);
    }

    await supabase.from('jadwal_tuton').update({ status_terkirim: true }).eq('id', jadwal.id);
}

// ==========================================
// 5. CRONJOB SCHEDULER
// ==========================================
cron.schedule('* * * * *', async () => {
    if (!isReady) return;

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

// Start Bot
startBot();
