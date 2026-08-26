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
// 1. SERVER HEALTH-CHECK (MENCEGAH RENDER SLEEP 24/7)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot UT WhatsApp (Baileys Engine) Active!\n');
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

// NOMOR HP BOT WHATSAPP
const BOT_PHONE_NUMBER = "6283148834649"; 

// Mencegah crash akibat Uncaught Error enkripsi Signal
process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('Session Error') || err.message.includes('decrypt') || err.message.includes('prekey'))) {
        return;
    }
    console.error('❌ Uncaught Exception:', err);
});

// ==========================================
// 3. INISIALISASI BOT WHATSAPP (KHUSUS PAIRING CODE)
// ==========================================
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_session_v8');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false, // Mematikan QR total
        logger: pino({ level: 'silent' }),
        browser: ['Chrome (Linux)', 'Chrome', '121.0.6167.160'],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

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
                console.log(`🔑 KODE PAIRING WHATSAPP KAMU:  ${code}`);
                console.log('==================================================');
                console.log(`📲 MASUKKAN KODE DI ATAS KE HP: ${cleanNumber}\n`);
            } catch (err) {
                console.error('❌ Gagal meminta Pairing Code:', err.message || err);
            }
        }, 5000);
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
                console.log('❌ Sesi Terputus/Log Out.');
            }
        } else if (connection === 'open') {
            console.log('⏳ Menyinkronkan sesi WhatsApp...');
            await sleep(3000);
            isReady = true;
            console.log('\n✅ WhatsApp Client (Baileys) Berhasil Terhubung & Siap 100%!\n');
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
                if (!rawFrom || rawFrom.endsWith('@g.us')) continue;

                const teks = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    ''
                ).trim().toUpperCase();

                if (!teks) continue;

                let realPhoneJid = "";
                if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
                    realPhoneJid = msg.key.remoteJidAlt;
                } else if (msg.key.participantAlt && msg.key.participantAlt.endsWith('@s.whatsapp.net')) {
                    realPhoneJid = msg.key.participantAlt;
                } else if (rawFrom.endsWith('@s.whatsapp.net')) {
                    realPhoneJid = rawFrom;
                }

                let nomorMurni = realPhoneJid ? realPhoneJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '') : "";

                let dataMahasiswa = null;

                if (nomorMurni) {
                    let nomor62 = nomorMurni.startsWith('0') ? '62' + nomorMurni.slice(1) : nomorMurni;
                    let nomor08 = nomorMurni.startsWith('62') ? '0' + nomorMurni.slice(2) : nomorMurni;
                    let nomorPlus62 = '+' + nomor62;

                    const { data } = await supabase
                        .from('mahasiswa')
                        .select('*')
                        .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
                        .maybeSingle();

                    dataMahasiswa = data;
                }

                // FIX NAMA: Hanya pakai nama Supabase jika match, atau PushName WA / "Teman" (Gak bakal asal tunjuk nama lain lagi)
                let namaUser = dataMahasiswa?.nama || msg.pushName || 'Teman';
                let targetDbId = dataMahasiswa?.id || null;

                console.log(`📩 [PESAN MASUK] Raw: ${rawFrom} | Terdaftar: ${!!dataMahasiswa} | Nama: ${namaUser} | Teks: "${teks}"`);

                if (teks === 'STOP') {
                    if (!targetDbId) {
                        await sock.sendMessage(rawFrom, { text: 'Nomor kamu sepertinya belum terdaftar di sistem pengingat nih.' }, { quoted: msg });
                        continue;
                    }

                    const { data, error } = await supabase
                        .from('mahasiswa')
                        .update({ status_aktif: false })
                        .eq('id', targetDbId)
                        .select();

                    if (error) {
                        console.error('❌ [DATABASE ERROR]:', error.message);
                        await sock.sendMessage(rawFrom, { text: 'Waduh, maaf ya gagal memproses penonaktifan. Coba sebentar lagi ya!' }, { quoted: msg });
                    } else if (data && data.length > 0) {
                        console.log(`✅ [BERHASIL STOP] Status ${data[0].nama} berhasil diubah menjadi status_aktif = false`);
                        await sock.sendMessage(rawFrom, { text: `Siap ${data[0].nama || namaUser}, pengingat Tuton kamu sudah dinonaktifkan yaa. Kalau nanti mau diaktifkan lagi, tinggal daftar ulang aja lewat website. Semangat kuliahnya!` }, { quoted: msg });
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
                        await sock.sendMessage(rawFrom, { text: `Halo ${namaUser}! Jadwal Tuton untuk semester ini belum ada di sistem nih, nanti diinfokan lagi yaa.` }, { quoted: msg });
                        continue;
                    }

                    let balasanJadwal = `Halo ${namaUser}! 👋\n\nIni rincian jadwal Tuton semester ini, dicatat atau dicapture ya biar nggak ketinggalan:\n\n`;
                    daftarJadwal.forEach((j) => {
                        const tglBuka = new Date(j.waktu_kirim).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
                        balasanJadwal += `📌 *${j.nama_sesi}*\n• Buka: ${tglBuka}\n• Batas Akhir: ${j.deadline_non_praktik}\n\n`;
                    });
                    balasanJadwal += `_Kalau kamu merasa terganggu dan mau berhenti dapat pengingat, tinggal balas *STOP* aja ya._`;

                    await sock.sendMessage(rawFrom, { text: balasanJadwal }, { quoted: msg });
                    continue;
                }

                const pesanBantuan = `Halo ${namaUser}! 👋\n\nAku pesan otomatis pengingat Tuton UT. Biar gampang, ini beberapa perintah yang bisa kamu ketik:\n\n` +
                    `• Ketik *JADWAL* : Untuk lihat kalender & deadline Tuton.\n` +
                    `• Ketik *STOP* : Kalau mau berhenti dapat pengingat harian.`;

                await sock.sendMessage(rawFrom, { text: pesanBantuan }, { quoted: msg });

            } catch (errInner) {
                console.error('❌ Error isolasi pesan:', errInner.message || errInner);
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
        if (mhs.status_aktif !== true) continue;

        let nomorBersih = String(mhs.nomor_wa).replace(/[^0-9]/g, '');
        if (nomorBersih.startsWith('0')) {
            nomorBersih = '62' + nomorBersih.slice(1);
        }

        const targetJid = `${nomorBersih}@s.whatsapp.net`;

        let pesan = "";
        if (jadwal.tipe_pengingat === "SESI_BUKA") {
            pesan = `Halo ${mhs.nama}! 👋\n\nSekadar mengingatkan nih, *${jadwal.nama_sesi}* sudah dibuka yaa.\n\nDeadlineninya tanggal _${jadwal.deadline_non_praktik}_. Jangan lupa luangkan waktu buat buka elearning.ut.ac.id dan cicil diskusinya dari sekarang yaa biar nggak kewalahan nanti. Semangat! 😊`;
        } else if (jadwal.tipe_pengingat === "H-7 DEADLINE") {
            pesan = `Halo ${mhs.nama}, apa kabar?\n\nCuma mau ngingetin aja, deadline untuk *${jadwal.nama_sesi}* tinggal *7 hari lagi* nih (_${jadwal.deadline_non_praktik}_).\n\nKalau ada waktu senggang hari ini, yuk dicicil kerjakan tugas/diskusinya di elearning.ut.ac.id!`;
        } else if (jadwal.tipe_pengingat === "H-3 DEADLINE") {
            pesan = `Halo ${mhs.nama}! ⚠️\n\nPengingat cepat yaa, deadline *${jadwal.nama_sesi}* sisa *3 hari lagi* nih (Batas akhir: _${jadwal.deadline_non_praktik}_).\n\nJangan sampai terlewat ya, yuk segera login dan selesaikan sebelum menumpuk!`;
        } else if (jadwal.tipe_pengingat === "H-1 DEADLINE") {
            pesan = `Halo ${mhs.nama}! ⏰\n\nBesok sudah batas akhir untuk *${jadwal.nama_sesi}* nih (_${jadwal.deadline_non_praktik}_).\n\nPastikan jawaban diskusi atau tugas kamu sudah diunggah di elearning.ut.ac.id yaa. Semangat sedikit lagi! 🔥`;
        } else if (jadwal.tipe_pengingat === "HARI-H DEADLINE") {
            pesan = `Halo ${mhs.nama}! 🚨\n\nHari ini *DEADLINE TERAKHIR* untuk *${jadwal.nama_sesi}* yaa!\n\nBatas waktu pengunggahan sampai pukul 23.59 WIB malam ini. Kalau belum selesai, yuk segera dikerjakan dan di-upload di elearning.ut.ac.id sekarang juga biar nilainya nggak kosong! 🙏`;
        } else {
            pesan = `Halo ${mhs.nama},\n\nJangan lupa ada info pengingat untuk *${jadwal.nama_sesi}* dengan batas waktu _${jadwal.deadline_non_praktik}_.\n\nSegera cek elearning.ut.ac.id yaa!`;
        }

        pesan += `\n\n-----------------------------------\n_Ketik *JADWAL* untuk cek kalender lengkap | Ketik *STOP* untuk berhenti pengingat._`;

        try {
            await sock.sendMessage(targetJid, { text: pesan });
            console.log(`✅ Pesan pengingat terkirim ke: ${mhs.nama} (${targetJid})`);
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
        for (const jadwal fearful of jadwalPending) {
            await kirimNotifikasiMassal(jadwal);
        }
    }
});

startBot();
