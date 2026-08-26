// Contoh handler pendaftaran di Backend Website (Node.js/Express atau Next.js API Route)
app.post('/api/daftar', async (req, res) => {
    const { nama, nomor_wa, jurusan } = req.body;

    // Standardisasi nomor ke format 62
    let nomorBersih = String(nomor_wa).replace(/[^0-9]/g, '');
    if (nomorBersih.startsWith('0')) {
        nomorBersih = '62' + nomorBersih.slice(1);
    }

    let nomor08 = '0' + nomorBersih.slice(2);
    let nomorPlus62 = '+' + nomorBersih;

    // 1. Cek apakah nomor sudah ada di database (tanpa peduli status aktifnya)
    const { data: mhsEksis } = await supabase
        .from('mahasiswa')
        .select('*')
        .or(`nomor_wa.eq.${nomorBersih},nomor_wa.eq.${nomor08},nomor_wa.eq.${nomorPlus62}`)
        .maybeSingle();

    if (mhsEksis) {
        // A. Jika nomor ada DAN sudah AKTIF, beritahu bahwa nomor sudah terdaftar
        if (mhsEksis.status_aktif === true) {
            return res.json({ 
                success: false, 
                message: "Nomor WhatsApp ini sudah terdaftar dan layanan pengingat sedang AKTIF." 
            });
        } 
        
        // B. Jika nomor ada TAPI status_aktif = FALSE (Pernah ketik STOP), AKTIFKAN KEMBALI
        const { error: updateErr } = await supabase
            .from('mahasiswa')
            .update({ 
                nama: nama, 
                jurusan: jurusan, 
                status_aktif: true // Re-aktivasi status
            })
            .eq('id', mhsEksis.id);

        if (!updateErr) {
            return res.json({ 
                success: true, 
                message: "Pendaftaran ulang berhasil! Layanan pengingat pengingat Tuton kamu telah diaktifkan kembali." 
            });
        }
    } else {
        // C. Jika nomor BENAR-BENAR BARU, lakukan INSERT
        const { error: insertErr } = await supabase
            .from('mahasiswa')
            .insert([{ 
                nama, 
                nomor_wa: nomorBersih, 
                jurusan, 
                status_aktif: true 
            }]);

        if (!insertErr) {
            return res.json({ 
                success: true, 
                message: "Pendaftaran berhasil! Pengingat otomatis Tuton UT kamu telah aktif." 
            });
        }
    }
});
