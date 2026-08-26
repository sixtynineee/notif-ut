const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeInMemoryStore
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const http = require('http');
const pino = require('pino');

// ==========================================
// 1. SERVER HEALTH-CHECK (MENCEGAH RENDER SLEEP 24/7)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot UT WhatsApp (Baileys Engine) Active!\n');
}).listen(PORT, () => {
    console.log(` Health-Check Server berjalan di port ${PORT}`);
});

// ==========================================
// 2. KONFIGURASI SUPABASE & STORE
// ==========================================
const SUPABASE_URL = "https://mzxrcslawziuvzqpwbjs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fdJvajntNzea73UkHOvBmg_tKRkvwG5";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// In-Memory Store Baileys untuk memetakan Kontak & LID ke Nomor HP
const logger = pino({ level: 'silent' });
const store = makeInMemoryStore({ logger });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sock;
let isReady = false;
const BOT_PHONE_NUMBER = "6283148834649";

process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('Session Error') || err.message.includes('decrypt') || err.message.includes('prekey'))) {
        return;
    }
    console.error(' Uncaught Exception:', err);
});

// Helper normalisasi nomor ke format 62xxx
function cleanTo62(numberStr) {
    if (!numberStr) return '';
    let clean = String(numberStr).replace(/[^0-9]/g, '');
    if (clean.startsWith('0')) {
        clean = '62' + clean.slice(1);
    }
    return clean;
}

// Ekstraksi Nomor HP Pengirim yang mendukung LID & Multi-Device
async function resolvePhoneNumber(msg, sockInstance) {
    let rawJid = msg.key.remoteJid || '';
    
    // 1. Cek Metadata Alternatif Baileys
    if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        rawJid = msg.key.remoteJidAlt;
    } else if (msg.key.participantAlt && msg.key.participantAlt.endsWith('@s.whatsapp.net')) {
        rawJid = msg.key.participantAlt;
    }

    // 2. Jika JID sudah berbentuk @s.whatsapp.net
    if (rawJid.endsWith('@s.whatsapp.net')) {
        return cleanTo62(rawJid.split('@')[0].split(':')[0]);
    }

    // 3. Jika JID berbentuk LID (@lid), cari di Contacts Store
    if (rawJid.endsWith('@lid') && store.contacts) {
        const contact = store.contacts[rawJid];
        if (contact && contact.id && contact.id.endsWith('@s.whatsapp.net')) {
            return cleanTo62(contact.id.split('@')[0]);
        }
    }

    // 4. Fallback jika masih LID
    let possibleDigits = rawJid.split('@')[0].replace(/[^0-9]/g, '');
    return possibleDigits.length >= 10 ? possibleDigits : null;
}

// ==========================================
// 3. INISIALISASI BOT WHATSAPP
// ==========================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_session_v3');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger,
        browser: ['Ubuntu', 'Chrome', '121.0.6167.160'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    // Hubungkan store dengan event Baileys
    store?.bind(sock.ev);

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let cleanNumber = cleanTo62(BOT_PHONE_NUMBER);
                let code = await sock.requestPairingCode(cleanNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                
                console.log('\n==================================================');
                console.log(` KODE PAIRING WHATSAPP KAMU:  ${code}`);
                console.log('==================================================\n');
            } catch (err) {
                console.error(' Gagal meminta Pairing Code:', err.message || err);
            }
        }, 5000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(` Koneksi terputus (Reason Code: ${statusCode})`);

            if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                console.log(' [RESTART REQUIRED] Menghubungkan ulang...');
                setTimeout(() => startBot(), 2000);
            } else if (statusCode !== DisconnectReason.loggedOut) {
                console.log(' Reconnecting otomatis...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log(' Sesi Terputus/Log Out.');
            }
        } else if (connection === 'open') {
            console.log(' Menyinkronkan sesi WhatsApp...');
            await sleep(3000);
            isReady = true;
            console.log('\n WhatsApp Client (Baileys) Berhasil Terhubung & Siap 100%!\n');
        }
    });

    // ==========================================
    // 4. AUTO-REPLY MESSAGES HANDLER
    // ==========================================
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            try {
                if (!msg.message || msg.key.fromMe) continue;

                const rawFrom = msg.key.remoteJid;
                if (!rawFrom || rawFrom.endsWith('@g.us')) continue; // Abaikan pesan grup

                const teks = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim().toUpperCase();

                if (!teks) continue;

                // 1. Dapatkan nomor murni pengirim
                const nomor62 = await resolvePhoneNumber(msg, sock);
                let dataMahasiswa = null;

                // 2. Pencarian Fleksibel di Supabase
                if (nomor62) {
                    const nomorSuffix = nomor62.length > 9 ? nomor62.slice(-9) : nomor62;

                    const { data } = await supabase
                        .from('mahasiswa')
                        .select('*')
                        .ilike('nomor_wa', `%${nomorSuffix}`)
                        .maybeSingle();

                    dataMahasiswa = data;
                }

                let namaUser = dataMahasiswa?.nama || 'Teman';
                let targetDbId = dataMahasiswa?.id || null;

                console.log(` [PESAN MASUK] Raw JID: ${rawFrom} | No Parsed: ${nomor62 || 'LID/Unknown'} | Mhs: ${namaUser} | Teks: "${teks}"`);

                // A. FITUR UNSUBSCRIBE (STOP)
                if (teks === 'STOP') {
                    if (!targetDbId) {
                        await sock.sendMessage(rawFrom, { 
                            text: 'Nomor WhatsApp kamu belum terdaftar di sistem pengingat kami. Kamu bisa mendaftar terlebih dahulu melalui website:\nhttps://notif-ut.vercel.app/' 
                        }, { quoted: msg });
                        continue;
                    }

                    const { data, error } = await supabase
                        .from('mahasiswa')
                        .update({ status_aktif: false })
                        .eq('id', targetDbId)
                        .select();

                    if (error) {
                        console.error(' [DATABASE ERROR STOP]:', error.message);
                        await sock.sendMessage(rawFrom, { text: 'Maaf, gagal memproses penonaktifan. Silakan coba lagi beberapa saat lagi.' }, { quoted: msg });
                    } else {
                        const mhsUpdated = data && data[0] ? data[0] : dataMahasiswa;
                        console.log(` [BERHASIL STOP] Status ${mhsUpdated.nama} diubah menjadi status_aktif = false`);
                        await sock.sendMessage(rawFrom, { 
                            text: `Siap ${mhsUpdated.nama}, pengingat Tuton kamu telah dinonaktifkan.\n\nJika nanti mau diaktifkan lagi, kamu bisa daftar ulang kapan saja melalui website kami di:\nhttps://notif-ut.vercel.app/\n\nSemangat kuliahnya!` 
                        }, { quoted: msg });
                    }
                    continue;
                }

                // B. FITUR CEK JADWAL
                if (teks === 'JADWAL' || teks === 'INFO' || teks === 'CEK JADWAL') {
                    const { data: daftarJadwal, error } = await supabase
                        .from('jadwal_tuton')
                        .select('*')
                        .eq('tipe_pengingat', 'SESI_BUKA')
                        .order('id', { ascending: true });

                    if (error || !daftarJadwal || daftarJadwal.length === 0) {
                        await sock.sendMessage(rawFrom, { text: `Halo ${namaUser}! Jadwal Tuton untuk semester ini belum tersedia di sistem.` }, { quoted: msg });
                        continue;
                    }

                    let balasanJadwal = `Halo ${namaUser}!\n\nBerikut rincian jadwal Tuton semester ini:\n\n`;
                    daftarJadwal.forEach((j) => {
                        const tglBuka = new Date(j.waktu_kirim).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
                        balasanJadwal += ` *${j.nama_sesi}*\n• Buka: ${tglBuka}\n• Batas Akhir: ${j.deadline_non_praktik}\n\n`;
                    });
                    balasanJadwal += `_Ketik *STOP* untuk berhenti menerima pengingat otomatis._\nWebsite: https://notif-ut.vercel.app/`;

                    await sock.sendMessage(rawFrom, { text: balasanJadwal }, { quoted: msg });
                    continue;
                }

                // C. BANTUAN / FALLBACK UNTUK PESAN LAINNYA
                const pesanBantuan = `Halo ${namaUser}!\n\nIni adalah bot pengingat otomatis Tuton UT. Berikut kata kunci perintah yang bisa kamu gunakan:\n\n` +
                    `• Ketik *JADWAL* : Untuk melihat kalender & deadline Tuton.\n` +
                    `• Ketik *STOP* : Untuk berhenti menerima pengingat harian.\n\n` +
                    `Kunjungi portal resmi kami di:\nhttps://notif-ut.vercel.app/`;

                await sock.sendMessage(rawFrom, { text: pesanBantuan }, { quoted: msg });

            } catch (errInner) {
                console.error(' Error penanganan pesan:', errInner.message || errInner);
            }
        }
    });
}

// ==========================================
// 5. LOGIKA PENGIRIMAN NOTIFIKASI SCHEDULER
// ==========================================
async function kirimNotifikasiMassal(jadwal) {
    if (!sock || !isReady) return;

    await supabase.from('jadwal_tuton').update({ status_terkirim: true }).eq('id', jadwal.id);
    console.log(`\n[SCHEDULER] Menjalankan pengiriman notifikasi: ${jadwal.nama_sesi}`);

    const { data: daftarMahasiswa } = await supabase
        .from('mahasiswa')
        .select('*')
        .eq('status_aktif', true);

    if (!daftarMahasiswa || daftarMahasiswa.length === 0) return;

    for (const mhs of daftarMahasiswa) {
        let nomorBersih = cleanTo62(mhs.nomor_wa);
        if (!nomorBersih) continue;

        const targetJid = `${nomorBersih}@s.whatsapp.net`;

        let pesan = "";
        if (jadwal.tipe_pengingat === "SESI_BUKA") {
            pesan = `Halo ${mhs.nama}!\n\nSekadar mengingatkan, *${jadwal.nama_sesi}* sudah dibuka ya.\n\nDeadline: _${jadwal.deadline_non_praktik}_. Jangan lupa akses elearning.ut.ac.id dan mulai mencicil diskusinya. Semangat! `;
        } else if (jadwal.tipe_pengingat === "H-7 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nDeadline untuk *${jadwal.nama_sesi}* tinggal *7 hari lagi* (_${jadwal.deadline_non_praktik}_).\n\nYuk mulai dikerjakan di elearning.ut.ac.id!`;
        } else if (jadwal.tipe_pengingat === "H-3 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nPengingat: deadline *${jadwal.nama_sesi}* sisa *3 hari lagi* (_${jadwal.deadline_non_praktik}_).\n\nSegera selesaikan sebelum menumpuk!`;
        } else if (jadwal.tipe_pengingat === "H-1 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nBesok adalah batas akhir *${jadwal.nama_sesi}* (_${jadwal.deadline_non_praktik}_).\n\nPastikan tugas/diskusi sudah diunggah di elearning.ut.ac.id! `;
        } else if (jadwal.tipe_pengingat === "HARI-H DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nHari ini *DEADLINE TERAKHIR* untuk *${jadwal.nama_sesi}*!\n\nBatas pengunggahan sampai pukul 23.59 WIB. Segera unggah di elearning.ut.ac.id sekarang juga! `;
        } else {
            pesan = `Halo ${mhs.nama},\n\nPengingat untuk *${jadwal.nama_sesi}* dengan batas waktu _${jadwal.deadline_non_praktik}_.\n\nCek elearning.ut.ac.id ya!`;
        }

        pesan += `\n\n-----------------------------------\n_Ketik *JADWAL* untuk info jadwal | Ketik *STOP* untuk berhenti berlangganan._\nPortal Resmi: https://notif-ut.vercel.app/`;

        try {
            await sock.sendMessage(targetJid, { text: pesan });
            console.log(` Pesan terkirim ke: ${mhs.nama} (${targetJid})`);
            
            await supabase.from('log_pengiriman').insert([{
                mahasiswa_id: mhs.id,
                jadwal_id: jadwal.id,
                nomor_wa: nomorBersih,
                status_kirim: 'SUCCESS'
            }]);
        } catch (err) {
            console.error(` Gagal mengirim ke ${mhs.nama} (${nomorBersih}):`, err.message || err);
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
