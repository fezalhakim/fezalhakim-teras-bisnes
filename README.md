# Teras Bisnes

Sistem operasi bisnes ringkas untuk satu syarikat: **HR**, **Perakaunan** dan **Jualan (CRM)** dalam satu app web, dengan **pembantu AI baca-sahaja**.

## Modul

| Modul | Ciri-ciri |
|---|---|
| **HR** | Rekod pekerja, clock-in/clock-out dengan lokasi GPS, permohonan & kelulusan cuti (baki cuti tahunan disemak), tuntutan perbelanjaan, jana gaji bulanan dengan KWSP, slip gaji boleh cetak |
| **Perakaunan** | Lejar catatan bergu sebenar, carta akaun asas Malaysia, invois dengan SST setiap baris, bayaran separa/penuh, perbelanjaan, jurnal manual, laporan Untung Rugi, Kunci Kira-kira, Imbangan Duga dan ringkasan SST |
| **CRM** | Kenalan, pipeline urus niaga (Baru → Dihubungi → Sebut harga → Rundingan → Menang/Kalah), log aktiviti, pautan WhatsApp, borang lead awam di `/lead` |
| **AI** | Tanya soalan tentang data syarikat dalam Bahasa Melayu. AI hanya nampak data yang dibenarkan untuk peranan anda, dan **tidak boleh mengubah** apa-apa |

## Peranan

| Peranan | Akses |
|---|---|
| **Pekerja** | Ruang Saya (kehadiran, cuti, tuntutan, slip gaji sendiri) + kenalan/urus niaga milik sendiri |
| **Pengurus** | + Rekod pekerja, kelulusan cuti & tuntutan, kehadiran semua, semua CRM, AI |
| **Kewangan** | + Invois, belanja, jurnal, laporan, gaji, bayar tuntutan, AI |
| **Admin** | Semua, termasuk pengguna, tetapan dan log audit |

Peranan dibaca semula pada setiap permintaan, jadi jika admin menukar peranan seseorang, kesannya serta-merta.

## Kawalan penting

- Catatan jurnal **tidak boleh diubah atau dipadam** (dikunci di peringkat pangkalan data). Betulkan kesilapan dengan catatan pembalikan.
- Setiap jurnal mesti seimbang (debit = kredit).
- Pekerja tidak boleh meluluskan cuti atau tuntutan sendiri.
- Kata laluan disimpan sebagai hash scrypt; sesi dalam kuki HttpOnly.
- Log audit untuk tindakan penting.

## Batasan versi ini (belum disokong)

- **KWSP dikira dengan kadar anggaran** (11% pekerja; 13% majikan jika gaji ≤ RM5,000, 12% jika lebih). Jadual rasmi KWSP membundarkan mengikut julat gaji; semak sebelum bayaran sebenar.
- **PERKESO, SIP dan PCB** belum dikira automatik. Masukkan dalam "Potongan lain" jika perlu.
- **e-Invois LHDN (MyInvois)** belum disepadukan.
- Belum ada iklan Meta/WhatsApp automatik, chatbot, atau import penyata bank.

## Jalankan secara tempatan

Perlu **Node.js 22.13 atau lebih baru** (menggunakan SQLite terbina dalam Node, tiada pangkalan data luaran diperlukan).

```bash
npm install
npm start          # http://localhost:3000
npm test           # ujian API
```

Kali pertama dibuka, anda akan diminta mencipta akaun admin dan nama syarikat.

### Pemboleh ubah persekitaran

| Nama | Keterangan |
|---|---|
| `PORT` | Port pelayan (lalai 3000) |
| `DB_PATH` | Lokasi fail pangkalan data (lalai `data/teras.db`) |
| `ANTHROPIC_API_KEY` | Pilihan. Diperlukan untuk ciri **Tanya AI** |
| `CLAUDE_MODEL` | Pilihan. Model Claude untuk AI |

## Deploy

**Penting:** data disimpan dalam fail SQLite, jadi pelayan mesti ada **cakera kekal (persistent disk)**. Pelan percuma Render tiada cakera kekal, jadi data akan hilang setiap kali pelayan dimulakan semula.

`render.yaml` disediakan dengan cakera 1 GB (memerlukan pelan berbayar Render). Pilihan lain: VPS kecil (cth DigitalOcean, Hetzner, atau pelayan Malaysia) yang menjalankan `npm start` di belakang HTTPS.

**Sandaran:** salin fail `DB_PATH` secara berkala ke tempat lain.
