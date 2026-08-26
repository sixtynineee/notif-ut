const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
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
    res.end('Bot UT WhatsApp (Baileys Engine) is Active & Running 24/7!\n');
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
let isReady = false;

// ⚠️ MASUKKAN NOMOR HP BOT DI SINI (CONTOH: "6289523136633")
const BOT_PHONE_NUMBER = "6289523136633"; 

process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('Session Error') || err.message.includes('decrypt'))) {
        return;
    }
    console.error('❌ Uncaught Exception:', err);
});

// ==========================================
// 3. INISIALISASI BOT WHATSAPP (PAIRING CODE STABIL)
// ==========================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        // Format Browser Resmi untuk Penautan Perangkat
        browser: ['Mac OS', 'Chrome', '121.0.6167.160'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    // MINTA PAIRING CODE JIKA BELUM TERREGISTER
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanNumber = BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
                if (cleanNumber.startsWith('0')) {
                    cleanNumber = '62' + cleanNumber.slice(1);
                }

                let code = await sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                console.log('\n==================================================');
                console.log(`🔑 KODE PAIRING BARU (MASUKKAN DENGAN CEPAT):  ${code}`);
                console.log('==================================================\n');
            } catch (err) {
                console.error('❌ Gagal meminta Pairing Code, mencoba ulang...', err.message || err);
            }
        }, 5000); // Penyeimbang 5 detik agar koneksi awal siap
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`⚠️ Koneksi terputus (Reason Code: ${statusCode})`);

            if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                console.log('🔄 [RESTART REQUIRED] Menghubungkan ulang...');
                setTimeout(() => startBot(), 2000);
            } else if (statusCode !== DisconnectReason.loggedOut) {
                console.log('🔄 Reconnecting otomatis...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log('❌ Anda telah Log Out. Silakan hapus folder baileys_auth dan restart.');
            }
        } else if (connection === 'open') {
            console.log('⏳ Sinkronisasi sesi WhatsApp...');
            await sleep(3000);
            isReady = true;
            console.log('\n✅ WhatsApp Client (Baileys) Berhasil Terhubung & Siap 100%!\n');
        }
    });

    // ==========================================
    // 4. AUTO-REPLY MESSAGES HANDLER
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (m.type !== 'notify') return;

            for (const msg of m.messages) {
                if (!msg.message || msg.key.fromMe) continue;

                const rawFrom = msg.key.remoteJid;
                if (!rawFrom || rawFrom.endsWith('@g.us')) continue;

                const teks = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim().toUpperCase();

                if (!teks) continue;

                let phoneDigits = "";
                if (msg.key.participant) {
                    phoneDigits = msg.key.participant.split('@')[0].split(':')[0];
                } else if (msg.key.remoteJidAlt) {
                    phoneDigits = msg.key.remoteJidAlt.split('@')[0].split(':')[0];
                } else {
                    phoneDigits = rawFrom.split('@')[0].split(':')[0];
                }

                let nomorMurni = phoneDigits.replace(/[^0-9]/g, '');
                let nomor62 = nomorMurni.startsWith('0') ? '62' + nomorMurni.slice(1) : nomorMurni;
                let nomor08 = nomorMurni.startsWith('62') ? '0' + nomorMurni.slice(2) : nomorMurni;
                let nomorPlus62 = '+' + nomor62;

                console.log(`📩 [PESAN MASUK] Raw JID: ${rawFrom} | Nomor HP: ${nomor62} | Teks: "${teks}"`);

                let namaUser = 'Mahasiswa UT';
                if (nomor62 && !nomor62.startsWith('2192')) {
                    const { data } = await supabase
                        .from('mahasiswa')
                        .select('nama')
                        .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
                        .maybeSingle();

                    if (data && data.nama) {
                        namaUser = data.nama;
                    }
                }

                if (teks === 'STOP') {
                    const { data, error } = await supabase
                        .from('mahasiswa')
                        .update({ status_aktif: false })
                        .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
                        .select();

                    if (error) {
                        await sock.sendMessage(rawFrom, { text: '❌ Gagal memproses penonaktifan.' }, { quoted: msg });
                    } else if (!data || data.length === 0) {
                        await sock.sendMessage(rawFrom, { text: '🛑 Nomor Anda tidak terdaftar.' }, { quoted: msg });
                    } else {
                        await sock.sendMessage(rawFrom, { text: '🛑 *Layanan Notifikasi Diberhentikan.*' }, { quoted: msg });
                    }
                    continue;
                }

                if (teks === 'JADWAL' || teks === 'INFO' || teks === 'CEK JADWAL') {
                    const { data: daftarJadwal, error } = await supabase
                        .from('jadwal_tuton')
                        .select('*')
                        .eq('tipe_pengingat', 'SESI_BUKA')
                        .order('id', { ascending: true });

                    if (error || !daftarJadwal || daftarJadwal.length === 0) {
                        await sock.sendMessage(rawFrom, { text: `Halo *${namaUser}*,\n\nJadwal belum tersedia.` }, { quoted: msg });
                        continue;
                    }

                    let balasanJadwal = `📅 *[KALENDER TUTON UT 2026 GENAP]*\n\nHalo *${namaUser}*, berikut jadwal Sesi 1 s.d. 8:\n\n`;
                    daftarJadwal.forEach((j) => {
                        const tglBuka = new Date(j.waktu_kirim).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
                        balasanJadwal += `📌 *${j.nama_sesi}*\n🟢 Tanggal Buka Sesi: _${tglBuka}_\n📘 Deadline Sesi : _${j.deadline_non_praktik}_\n\n`;
                    });
                    balasanJadwal += `-----------------------------------\n_Ketik *STOP* untuk berhenti._`;

                    await sock.sendMessage(rawFrom, { text: balasanJadwal }, { quoted: msg });
                    continue;
                }

                const pesanBantuan = `🤖 *[BOT NOTIF-UT]*\n\nHalo *${namaUser}*! Kata kunci:\n👉 *JADWAL* : Cek kalender.\n👉 *STOP* : Berhenti.`;
                await sock.sendMessage(rawFrom, { text: pesanBantuan }, { quoted: msg });
            }
        } catch (err) {
            console.error('❌ Error Handling Message:', err);
        }
    });
}

// ==========================================
// 5. LOGIKA PENGIRIMAN PESAN MASSAL
// ==========================================
async function kirimNotifikasiMassal(jadwal) {
    if (!sock || !isReady) return;

    await supabase.from('jadwal_tuton').update({ status_terkirim: true }).eq('id', jadwal.id);

    const { data: daftarMahasiswa } = await supabase
        .from('mahasiswa')
        .select('*')
        .eq('status_aktif', true);

    if (!daftarMahasiswa || daftarMahasiswa.length === 0) return;

    for (const mhs of daftarMahasiswa) {
        if (mhs.status_aktif !== true) continue;

        let nomorBersih = String(mhs.nomor_wa).replace(/[^0-9]/g, '');
        if (nomorBersih.startsWith('0')) {
            nomorBersih = '62' + nomorBersih.slice(1);
        }

        const targetJid = `${nomorBersih}@s.whatsapp.net`;

        let headerNotif = "📢 [NOTIF-UT] Pengingat Sesi Baru";
        if (jadwal.tipe_pengingat === "H-7 DEADLINE") headerNotif = "🗓️ [NOTIF-UT] Pengingat H-7 Deadline";
        else if (jadwal.tipe_pengingat === "H-3 DEADLINE") headerNotif = "⚠️ [NOTIF-UT] Pengingat H-3 Deadline";
        else if (jadwal.tipe_pengingat === "H-1 DEADLINE") headerNotif = "⏰ [NOTIF-UT] Peringatan BESOK DEADLINE!";
        else if (jadwal.tipe_pengingat === "HARI-H DEADLINE") headerNotif = "🚨🔥 [NOTIF-UT] LAST CHANCE - DEADLINE HARI INI!";

        const pesan = `${headerNotif}\n\nHalo *${mhs.nama}* (${mhs.jurusan}),\nBerikut pengingat batas waktu untuk *${jadwal.nama_sesi}*:\n\n📘 Deadline Sesi : _${jadwal.deadline_non_praktik}_\n\n⚠️ _Segera selesaikan dan unggah tugas/diskusi kamu di elearning.ut.ac.id sebelum pukul 23.59 WIB!_\n-----------------------------------\n_Ketik *JADWAL* untuk cek kalender | Ketik *STOP* untuk berhenti._`;

        try {
            await sock.sendMessage(targetJid, { text: pesan });
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
}

// ==========================================
// 6. CRONJOB SCHEDULER
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

startBot();
