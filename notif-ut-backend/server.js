const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers
} = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const http = require('http');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

// ==========================================
// 1. SERVER HEALTH-CHECK (RENDER KEEP-ALIVE)
// ==========================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot UT WhatsApp (Baileys Engine) Active!\n');
}).listen(PORT, () => {
    console.log(` Health-Check Server berjalan di port ${PORT}`);
});

// ==========================================
// 2. KONFIGURASI SUPABASE & MEMORY STORE
// ==========================================
const SUPABASE_URL = "https://mzxrcslawziuvzqpwbjs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_fdJvajntNzea73UkHOvBmg_tKRkvwG5";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SESSION_DIR = path.join(__dirname, 'baileys_session_v3');
const lidToPhoneMap = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sock;
let isReady = false;

// Mencegah crash akibat Uncaught Error enkripsi Signal
process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Bad MAC') || err.message.includes('Session Error') || err.message.includes('decrypt') || err.message.includes('prekey'))) {
        return;
    }
    console.error(' Uncaught Exception:', err);
});

// Helper pembersih angka
function cleanNumber(str) {
    if (!str) return '';
    return String(str).replace(/[^0-9]/g, '');
}

function formatTo62(str) {
    let clean = cleanNumber(str);
    if (clean.startsWith('0')) {
        clean = '62' + clean.slice(1);
    }
    return clean;
}

// ==========================================
// 3. FUNGSI SINKRONISASI SESI DISK <=> SUPABASE
// ==========================================
async function restoreSessionFromSupabase() {
    try {
        if (!fs.existsSync(SESSION_DIR)) {
            fs.mkdirSync(SESSION_DIR, { recursive: true });
        }
        const { data } = await supabase.from('wa_sessions').select('*');
        if (data && data.length > 0) {
            console.log(' Mengunduh cadangan sesi dari Supabase ke lokal disk...');
            for (const row of data) {
                const filePath = path.join(SESSION_DIR, `${row.id}.json`);
                fs.writeFileSync(filePath, JSON.stringify(row.data));
            }
            console.log(' Pemulihan sesi dari Supabase selesai.');
        }
    } catch (err) {
        console.error(' Gagal memulihkan sesi dari Supabase:', err.message);
    }
}

async function backupSessionToSupabase() {
    try {
        if (!fs.existsSync(SESSION_DIR)) return;
        const files = fs.readdirSync(SESSION_DIR);
        for (const file of files) {
            if (file.endsWith('.json')) {
                const fileId = file.replace('.json', '');
                const filePath = path.join(SESSION_DIR, file);
                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                
                await supabase.from('wa_sessions').upsert({
                    id: fileId,
                    data: content,
                    updated_at: new Date().toISOString()
                });
            }
        }
        console.log(' [BACKUP] Sesi WhatsApp berhasil disinkronkan ke Supabase.');
    } catch (err) {
        console.error(' Gagal backup sesi ke Supabase:', err.message);
    }
}

// Ekstraksi Nomor HP Pengirim
function resolvePhoneNumber(msg) {
    let rawJid = msg.key.remoteJid || '';
    
    if (msg.key.remoteJidAlt && msg.key.remoteJidAlt.endsWith('@s.whatsapp.net')) {
        rawJid = msg.key.remoteJidAlt;
    } else if (msg.key.participantAlt && msg.key.participantAlt.endsWith('@s.whatsapp.net')) {
        rawJid = msg.key.participantAlt;
    } else if (msg.key.participant && msg.key.participant.endsWith('@s.whatsapp.net')) {
        rawJid = msg.key.participant;
    }

    if (rawJid.endsWith('@s.whatsapp.net')) {
        return formatTo62(rawJid.split('@')[0].split(':')[0]);
    }

    if (rawJid.endsWith('@lid') && lidToPhoneMap.has(rawJid)) {
        return lidToPhoneMap.get(rawJid);
    }

    return null; 
}

// Fungsi Pencarian Mahasiswa (LID + Nomor Phone Suffix)
async function findMahasiswaByLidOrPhone(rawFrom, nomor62) {
    if (rawFrom.endsWith('@lid')) {
        const { data: lidMatch } = await supabase
            .from('mahasiswa')
            .select('*')
            .eq('lid', rawFrom)
            .maybeSingle();

        if (lidMatch) return lidMatch;
    }

    if (nomor62) {
        const nomor08 = '0' + nomor62.slice(2);
        const nomorPlus62 = '+' + nomor62;

        const { data: directMatch } = await supabase
            .from('mahasiswa')
            .select('*')
            .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
            .maybeSingle();

        if (directMatch) return directMatch;
    }

    const { data: allMhs } = await supabase.from('mahasiswa').select('*');
    if (allMhs && allMhs.length > 0) {
        if (nomor62) {
            const lastDigitsSender = nomor62.slice(-9);
            const matched = allMhs.find(mhs => cleanNumber(mhs.nomor_wa).endsWith(lastDigitsSender));
            if (matched) return matched;
        }
        
        const unlinkedMhs = allMhs.filter(m => !m.lid && m.status_aktif);
        if (unlinkedMhs.length === 1) {
            return unlinkedMhs[0];
        }
    }

    return null;
}

// ==========================================
// 4. INISIALISASI BOT WHATSAPP
// ==========================================
async function startBot() {
    await restoreSessionFromSupabase();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        emitOwnEvents: false,
        getMessage: async (key) => {
            return { conversation: '' };
        }
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        await backupSessionToSupabase();
    });

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const contact of contacts) {
            if (contact.id && contact.lid) {
                const phone = formatTo62(contact.id.split('@')[0]);
                lidToPhoneMap.set(contact.lid, phone);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n==================================================');
            console.log(' SCAN QR CODE DI BAWAH INI DENGAN WHATSAPP HP KAMU:');
            console.log('==================================================');
            qrcode.generate(qr, { small: true });
            console.log('==================================================\n');
        }

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(` Koneksi terputus (Reason Code: ${statusCode})`);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log(' Sesi terputus permanen / Logged Out. Membersihkan sesi...');
                if (fs.existsSync(SESSION_DIR)) {
                    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                }
                await supabase.from('wa_sessions').delete().neq('id', '');
                setTimeout(() => startBot(), 3000);
            } else if (!sock.authState.creds.registered) {
                console.log(' [QR PENDING] Menunggu proses scan QR code...');
                setTimeout(() => startBot(), 3000);
            } else {
                console.log(' Memicu auto-restart (Sesi telah aman di-backup ke Supabase)...');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log(' Menyinkronkan sesi WhatsApp...');
            await sleep(3000);
            isReady = true;
            console.log('\n WhatsApp Client (Hybrid Storage) Berhasil Terhubung & Siap 100%!\n');
            await backupSessionToSupabase();
        }
    });

    // ==========================================
    // 5. AUTO-REPLY MESSAGES HANDLER (ASLI)
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

                let nomor62 = resolvePhoneNumber(msg);
                const dataMahasiswa = await findMahasiswaByLidOrPhone(rawFrom, nomor62);

                if (dataMahasiswa && rawFrom.endsWith('@lid') && !dataMahasiswa.lid) {
                    await supabase
                        .from('mahasiswa')
                        .update({ lid: rawFrom })
                        .eq('id', dataMahasiswa.id);
                    console.log(` [AUTO-LINK LID] Berhasil menautkan LID ${rawFrom} ke Mahasiswa: ${dataMahasiswa.nama}`);
                }

                let namaUser = dataMahasiswa?.nama || 'Teman';
                let targetDbId = dataMahasiswa?.id || null;

                console.log(` [PESAN MASUK] Raw: ${rawFrom} | No Parsed: ${nomor62 || 'LID Only'} | Mhs: ${namaUser} | Teks: "${teks}"`);

                // A. FITUR UNSUBSCRIBE (STOP)
                if (teks === 'STOP') {
                    if (!targetDbId) {
                        await sock.sendMessage(rawFrom, { 
                            text: 'Nomor WhatsApp kamu belum terdaftar di sistem pengingat kami. Kamu bisa mendaftar terlebih dahulu via website:\nhttps://notif-ut.vercel.app/' 
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
                        await sock.sendMessage(rawFrom, { text: 'Maaf, gagal memproses penonaktifan pengingat. Silakan coba lagi beberapa saat lagi.' }, { quoted: msg });
                    } else {
                        const mhsUpdated = data && data[0] ? data[0] : dataMahasiswa;
                        console.log(` [BERHASIL STOP] Status ${mhsUpdated.nama} diubah menjadi status_aktif = false`);
                        await sock.sendMessage(rawFrom, { 
                            text: `Siap ${mhsUpdated.nama}, pengingat Tuton kamu telah dinonaktifkan.\n\nJika nanti ingin mengaktifkan kembali, kamu bisa daftar ulang kapan saja via website kami di:\nhttps://notif-ut.vercel.app/\n\nSemangat kuliahnya!` 
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
// 6. LOGIKA PENGIRIMAN NOTIFIKASI SCHEDULER (ASLI & LENGKAP)
// ==========================================
async function kirimNotifikasiMassal(jadwal) {
    if (!sock || !isReady) return;

    await supabase.from('jadwal_tuton').update({ status_terkirim: true }).eq('id', jadwal.id);
    console.log(`\n[SCHEDULER] Menjalankan pengiriman notifikasi: ${jadwal.nama_sesi} (${jadwal.tipe_pengingat})`);

    const { data: daftarMahasiswa } = await supabase
        .from('mahasiswa')
        .select('*')
        .eq('status_aktif', true);

    if (!daftarMahasiswa || daftarMahasiswa.length === 0) return;

    for (const mhs of daftarMahasiswa) {
        let nomorBersih = formatTo62(mhs.nomor_wa);
        if (!nomorBersih) continue;

        const targetJid = mhs.lid || `${nomorBersih}@s.whatsapp.net`;
        const isTugas = jadwal.nama_sesi.includes("Tugas");
        const jenisKegiatan = isTugas ? "Tugas" : "Diskusi";

        let pesan = "";
        if (jadwal.tipe_pengingat === "SESI_BUKA") {
            pesan = `Halo ${mhs.nama}!\n\nSekadar mengingatkan, *${jadwal.nama_sesi}* sudah resmi dibuka ya.\n\n📘 Batas Akhir: _${jadwal.deadline_non_praktik}_\n\nYuk segera login di elearning.ut.ac.id dan mulai mencicil ${jenisKegiatan} kamu! Semangat!`;
        } else if (jadwal.tipe_pengingat === "H-10 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nPengingat santai: Waktu pengerjaan *${jadwal.nama_sesi}* sisa *10 hari lagi* (_${jadwal.deadline_non_praktik}_).\n\nMumpung masih panjang, yuk dicicil dari sekarang di elearning.ut.ac.id!`;
        } else if (jadwal.tipe_pengingat === "H-7 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nPengingat minggu kedua: Batas akhir untuk *${jadwal.nama_sesi}* tinggal *7 hari lagi* (_${jadwal.deadline_non_praktik}_).\n\nJangan lupa luangkan waktu minggu ini untuk menyelesaikan ${jenisKegiatan} kamu di elearning.ut.ac.id ya!`;
        } else if (jadwal.tipe_pengingat === "H-5 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nPengingat pertengahan: Deadline *${jadwal.nama_sesi}* tinggal *5 hari lagi* nih (_${jadwal.deadline_non_praktik}_).\n\nYuk segara selesaikan pengerjaannya di elearning.ut.ac.id!`;
        } else if (jadwal.tipe_pengingat === "H-3 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nPengingat cepat: Batas waktu untuk *${jadwal.nama_sesi}* tinggal *3 hari lagi* nih (_${jadwal.deadline_non_praktik}_).\n\nJangan sampai terlewat ya, yuk segera tuntaskan ${jenisKegiatan} di elearning.ut.ac.id!`;
        } else if (jadwal.tipe_pengingat === "H-1 DEADLINE") {
            pesan = `Halo ${mhs.nama}!\n\nPengingat H-1: Besok adalah batas akhir pengunggahan untuk *${jadwal.nama_sesi}* (_${jadwal.deadline_non_praktik}_).\n\nPastikan lembar ${jenisKegiatan} kamu sudah ter-upload dengan benar di elearning.ut.ac.id ya. Semangat!`;
        } else if (jadwal.tipe_pengingat === "HARI-H DEADLINE") {
            pesan = `🚨 *LAST CHANCE - DEADLINE HARI INI!*\n\nHalo ${mhs.nama}!\n\nHari ini adalah *BATAS AKHIR TERAKHIR* untuk *${jadwal.nama_sesi}*!\n\n⏰ Batas Pengunggahan: _Pukul 23.59 WIB malam ini_.\n\nJika belum selesai, yuk segera unggah ${jenisKegiatan} kamu di elearning.ut.ac.id sekarang juga!`;
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
// 7. CRONJOB SCHEDULER
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
