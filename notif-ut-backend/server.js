const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const http = require('http');
const fs = require('fs');

// =========================================================================
// 0. DUMMY HTTP SERVER (Mencegah Port Timeout di Render Web Service)
// =========================================================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('NOTIF-UT Bot is running active!\n');
}).listen(PORT, () => {
    console.log(`🌐 Dummy Web Server berjalan di port ${PORT}`);
});

// =========================================================================
// 1. KONFIGURASI SUPABASE
// =========================================================================
const SUPABASE_URL = process.env.SUPABASE_URL || "https://mzxrcslawziuvzqpwbjs.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "sb_publishable_fdJvajntNzea73UkHOvBmg_tKRkvwG5";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// =========================================================================
// 2. INISIALISASI BOT WHATSAPP (Anti-Crash & Bypass Headless Detection)
// =========================================================================
const client = new Client({
    authStrategy: new LocalAuth({ clientId: "session-v2" }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-component-update',
            '--disable-default-apps',
            '--mute-audio',
            '--no-default-browser-check',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    }
});

// INDIKATOR EVENT MONITORING
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Memuat WhatsApp Web: ${percent}% - ${message}`);
});

client.on('qr', (qr) => {
    console.log('\n========================================================');
    console.log('📌 QR CODE BARU BERHASIL DITERBITKAN! SCAN DENGAN HP KAMU:');
    console.log('========================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('🔑 Otentikasi WhatsApp Berhasil!');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Otentikasi Gagal:', msg);
});

client.on('ready', () => {
    console.log('\n✅ WhatsApp Client Berhasil Terhubung & Siap Mengirim Notifikasi!\n');
});

client.on('disconnected', (reason) => {
    console.log('⚠️ Client terputus dari WhatsApp:', reason);
    if (fs.existsSync('./.wwebjs_auth')) {
        try {
            fs.rmSync('./.wwebjs_auth', { recursive: true, force: true });
            console.log('🗑️ Folder sesi lama berhasil dibersihkan.');
        } catch (e) {
            console.error('Gagal menghapus folder sesi:', e.message);
        }
    }
});

// =========================================================================
// 3. FITUR INTERAKTIF: AUTO-REPLY (STOP, JADWAL, & FALLBACK)
// =========================================================================
client.on('message', async (msg) => {
    if (msg.from.endsWith('@g.us')) return;

    const teks = msg.body.trim().toUpperCase();

    // EKSTRAKSI NOMOR HP ASLI DARI PAYLOAD MENTAH WHATSAPP (_data)
    let rawJid = "";
    if (msg._data && msg._data.from && msg._data.from.endsWith('@c.us')) {
        rawJid = msg._data.from;
    } else if (msg._data && msg._data.author && msg._data.author.endsWith('@c.us')) {
        rawJid = msg._data.author;
    } else {
        const contact = await msg.getContact();
        rawJid = contact.id._serialized || msg.from;
    }

    // Ambil angka murni nomor HP
    let nomorTeleponMurni = rawJid.replace('@c.us', '').replace('@lid', '').split(':')[0].replace(/[^0-9]/g, '');

    // Standardisasi 3 format nomor Indonesia (62..., 08..., +62...)
    let nomor62 = nomorTeleponMurni.startsWith('0') ? '62' + nomorTeleponMurni.slice(1) : nomorTeleponMurni;
    let nomor08 = nomorTeleponMurni.startsWith('62') ? '0' + nomorTeleponMurni.slice(2) : nomorTeleponMurni;
    let nomorPlus62 = '+' + nomor62;

    // A. FITUR UNSUBSCRIBE (STOP)
    if (teks === 'STOP') {
        console.log(`\n[PROSES STOP] Menerima instruksi STOP dari Nomor HP Asli: ${nomor62} / ${nomor08}`);

        const { data, error } = await supabase
            .from('mahasiswa')
            .update({ status_aktif: false })
            .or(`nomor_wa.eq.${nomor62},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
            .select();

        if (error) {
            console.error('❌ [DATABASE ERROR] Gagal update status_aktif:', error.message);
            await msg.reply('❌ Gagal memproses penonaktifan. Silakan coba lagi nanti.');
        } else if (!data || data.length === 0) {
            console.log('⚠️ [WARNING] Nomor HP tidak ditemukan di database Supabase.');
            await msg.reply('🛑 Nomor Anda tidak terdaftar di sistem pendaftaran.');
        } else {
            console.log(`✅ [UNSUBSCRIBE SUKSES] Status ${data[0].nama} (${nomor62}) berhasil diubah menjadi status_aktif = FALSE`);
            await msg.reply('🛑 *Layanan Notifikasi Diberhentikan.*\n\nAnda tidak akan menerima pengingat jadwal Tuton UT lagi. Jika ingin mendaftar ulang, silakan akses kembali website pendaftaran.');
        }
        return;
    }

    // B. FITUR CEK JADWAL (FORMAT RINGKAS SESI 1-8)
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
            await msg.reply(`Halo *${namaUser}*,\n\nSaat ini daftar jadwal Tuton 1 semester belum tersedia di database.`);
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

        await msg.reply(balasanJadwal);
        return;
    }

    // C. BANTUAN / FALLBACK UNTUK PESAN LAINNYA
    const pesanBantuan = `🤖 *[BOT NOTIF-UT]*\n\nHalo! Saya adalah bot pengingat otomatis Tuton UT. Kata kunci yang dapat kamu gunakan:\n\n` +
        `👉 *JADWAL* : Cek kalender jadwal Tuton 1 semester (Sesi 1-8).\n` +
        `👉 *STOP* : Berhenti menerima notifikasi pengingat.`;
    
    await msg.reply(pesanBantuan);
});

// =========================================================================
// 4. LOGIKA PENGIRIMAN PESAN MASSAL (BLAST NOTIFIKASI)
// =========================================================================
async function kirimNotifikasiMassal(jadwal) {
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

        const targetWa = `${nomorBersih}@c.us`;

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
            await client.sendMessage(targetWa, pesan);
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
    }

    await supabase.from('jadwal_tuton').update({ status_terkirim: true }).eq('id', jadwal.id);
}

// =========================================================================
// 5. CRONJOB SCHEDULER
// =========================================================================
cron.schedule('* * * * *', async () => {
    const sekarang = new Date().toISOString();

    const { data: jadwalPending, error } = await supabase
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

console.log('🚀 Memulai inisialisasi Puppeteer & WhatsApp Client...');
client.initialize();
