# Logic Arena — use your logic! 🧠

Game kuis logika real-time party-style (ala Kahoot/Jackbox): satu **layar utama** (host, dibuka di laptop/TV) + banyak **HP pemain** (controller, scan QR). Satu project, deploy sekali ke Netlify.

---

## ⚠️ Baca dulu: kenapa arsitekturnya bukan "SSE via Netlify Functions"

Brief awal minta real-time sync pakai **Server-Sent Events dari Netlify Functions**. Setelah dicek, ini **tidak bisa benar-benar jalan** untuk kasus broadcast ke banyak client, dan saya tidak mau kasih kode yang keliatan jalan tapi break pas dipakai rame-rame. Alasannya:

- Netlify Functions itu **stateless & terisolasi** — tiap invocation adalah proses baru tanpa memori bersama dengan invocation lain. Waktu Player A menekan jawaban di HP-nya, itu memicu satu invocation function yang terpisah total dari invocation yang (misalnya) sedang menahan koneksi SSE terbuka ke layar Host. Tidak ada jalan bagi invocation Player A untuk "menyuntikkan" data ke stream yang sudah dipegang invocation lain — keduanya tidak saling kenal.
- Supaya SSE semacam itu bisa broadcast ke banyak client, kamu tetap butuh **pusat pesan bersama** (shared pub/sub) di luar Netlify Functions itu sendiri. Begitu kamu punya itu, SSE-nya jadi lapisan yang tidak perlu — client bisa langsung dengar dari pusat pesan itu.

**Solusi yang dipakai di proyek ini:** [Supabase Realtime](https://supabase.com/docs/guides/realtime) (WebSocket, mode *Postgres Changes*) sebagai pusat pesannya — persis opsi "atau Pusher/Supabase" yang kamu sebut di brief. Prinsipnya:

- **Baca & langganan real-time** → langsung dari browser ke Supabase pakai `anon key` (public, aman ditaruh di client — akses datanya dibatasi Row Level Security, bukan disembunyikan lewat key).
- **Tulis / ubah state game** (buat game, jawab soal, ganti soal, dst) → **selalu** lewat Netlify Functions, pakai `service_role key` yang rahasia (server-side saja). Netlify Functions di sini berfungsi sebagai **backend aman untuk logic & rahasia** (Gemini API key, scoring anti-curang), bukan sebagai jalur real-time-nya.
- Setiap kali Netlify Function menulis ke tabel `games` / `players` / `answers`, Supabase Realtime otomatis mendorong perubahan itu ke **semua** client yang berlangganan (layar host + semua HP pemain) dalam hitungan puluhan-ratusan milidetik. Ini yang menggantikan peran SSE di desain awal.

Efeknya di kode: gak ada file `game-stream.js`. Real-time sync-nya "gratis" datang dari Supabase, bukan dari sebuah Netlify Function yang berjaga.

---

## Struktur proyek

```
logic-arena/
├── netlify.toml              # konfigurasi build + redirect /api/* -> functions
├── package.json              # dependency untuk functions (@google/genai, @supabase/supabase-js)
├── public/                   # semua yang di-serve statis oleh Netlify
│   ├── index.html            # splash -> setup host -> lobby+QR -> layar game
│   ├── player.html            # controller HP pemain
│   ├── style.css             # design system (warna #FFD166 / #6F4E37, font Quicksand)
│   ├── config.js             # ISI INI: Supabase URL + anon key (public, aman)
│   ├── app.js                # helper bersama: client Supabase, panggil /api/*, QR, dll
│   ├── host.js               # logic layar utama (state machine tampilan)
│   └── player.js              # logic controller HP
├── netlify/functions/
│   ├── _lib/
│   │   ├── supabaseAdmin.js  # client Supabase pakai service_role key (server-only)
│   │   └── bracket.js        # algoritma seeding & advance bracket
│   ├── create-game.js        # host bikin game baru -> kode + row `games`
│   ├── join-game.js          # pemain gabung -> insert row `players`
│   ├── get-questions.js      # panggil Gemini (Google Search grounding) -> 5 soal
│   ├── submit-answer.js      # pemain jawab -> scoring anti-curang di server
│   └── update-game-state.js  # semua kontrol alur game (reveal/next/bracket/...)
└── supabase/
    └── schema.sql            # jalankan sekali di SQL Editor Supabase
```

---

## Setup (sekali saja)

### 1. Buat project Supabase
1. Buka [supabase.com](https://supabase.com) → New Project (gratis).
2. Setelah project jadi, buka **SQL Editor** → New query → paste seluruh isi `supabase/schema.sql` → **Run**.
   Ini membuat tabel `games`/`players`/`answers`, RLS policy (baca publik, tulis hanya lewat server), fungsi `increment_player_score`, dan mendaftarkan ketiga tabel ke publication `supabase_realtime` (kalau baris `alter publication ...` di paling bawah gagal karena publication-nya sudah ada isi lain, cukup aktifkan replikasi manual: **Database → Replication → supabase_realtime → nyalakan toggle untuk `games`, `players`, `answers`**).
3. Buka **Project Settings → API** (atau tab **API Keys** kalau proyekmu sudah pakai penamaan key baru):
   - Salin **Project URL**.
   - Salin **anon / publishable key** (public, aman untuk browser).
   - Salin **service_role / secret key** (RAHASIA, jangan pernah taruh di kode client).

### 2. Isi konfigurasi public (aman untuk browser)
Edit `public/config.js`:
```js
window.LOGIC_ARENA_CONFIG = {
  SUPABASE_URL: 'https://xxxxxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ....',
};
```

### 3. Siapkan Gemini API key
Ambil API key gratis di [Google AI Studio](https://aistudio.google.com/apikey). Ini **jangan** ditaruh di `config.js` — ini rahasia, masuk ke Environment Variables Netlify (langkah berikut).

### 4. Deploy ke Netlify
**Cara tercepat (drag & drop):**
1. Zip folder `logic-arena` ini (atau upload langsung foldernya).
2. Buka [app.netlify.com](https://app.netlify.com) → **Add new site → Deploy manually** → drag folder/zip-nya.
3. Setelah site jadi, buka **Site settings → Environment variables** → tambahkan:
   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | API key dari Google AI Studio |
   | `SUPABASE_URL` | Project URL Supabase (sama seperti di `config.js`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | **service_role / secret key** (yang RAHASIA) |
4. **Deploys → Trigger deploy → Deploy site** lagi supaya env var-nya kepakai oleh Functions.

**Cara alternatif (Git-based, lebih enak buat update selanjutnya):** push folder ini ke GitHub repo, lalu di Netlify pilih **Add new site → Import an existing project**, hubungkan repo-nya. Build command dikosongkan, publish directory `public`, functions directory `netlify/functions` (sudah diatur di `netlify.toml`, jadi biasanya otomatis kedetect).

### 5. Coba main
- Buka `https://situs-kamu.netlify.app/` di laptop/TV → itu layar Host.
- Scan salah satu dari 2 QR yang muncul pakai HP → itu controller pemain.

---

## Cara kerja tiap mode

### Mode **Tim**
Semua pemain gabung ke salah satu dari 2 grup lewat QR (default nama "Tim Gold" / "Tim Coffee", bisa diganti host). Kelima soal dijawab bareng-bareng oleh semua pemain; skor per pemain dijumlah per tim di setiap layar Reveal & Papan Skor. Skor pakai bonus kecepatan (500 poin dasar + sampai 500 poin bonus makin cepat & benar), dihitung **di server** dari `question_started_at`, jadi tidak bisa dicurangi lewat jam HP pemain.

### Mode **Play-off Bracket**
1. Semua pemain tetap jawab 5 soal awal yang sama dulu (menentukan skor awal).
2. Host klik **"Buat Bracket"** di layar Papan Skor → sistem membuat bracket gugur tunggal, di-seed dari skor (skor tertinggi dapat "byes"/jalan otomatis kalau jumlah pemain bukan pas 2^n), pakai urutan seeding turnamen standar (seed 1 vs seed terakhir, dst) supaya pemain terbaik gak ketemu duluan.
3. Tiap babak: satu soal yang sama ditampilkan untuk **pasangan yang sedang bertanding saja**; pemain lain otomatis lihat layar "nonton" di HP-nya. Yang menjawab benar menang; kalau dua-duanya benar, yang paling cepat menang; kalau dua-duanya salah/gak jawab, diundi otomatis biar game tetap lanjut live tanpa macet.
4. Pemenang tiap babak lanjut ke babak berikutnya sampai tersisa satu juara.

> **Simplifikasi yang disengaja:** tiap babak bracket diputuskan dari **satu** soal (bukan best-of-banyak), dan 2 QR di lobby ("Grup A"/"Grup B") di mode ini cuma jadi dua pintu masuk yang lebih cepat buat antrean scan — tidak memengaruhi pasangan bracket (itu murni dari skor ronde awal). Kalau mau versi "1 pertandingan = beberapa soal", tinggal ubah `handleBracketReveal` di `update-game-state.js` untuk menunggu N jawaban per pemain sebelum menentukan pemenang.

---

## Kustomisasi cepat
- **Jumlah soal / lama waktu per soal:** `QUESTION_COUNT` di `get-questions.js`, dan `question_duration_seconds` (default 20 detik) di `create-game.js`.
- **Rumus skor:** `BASE_POINTS` / `SPEED_BONUS` di `submit-answer.js`.
- **Warna & font:** semua di `public/style.css` lewat CSS variables (`--gold`, `--coffee`, dst) — sudah sesuai brief (#FFD166, #6F4E37, Quicksand).
- **QR code:** dipakai layanan gambar publik `api.qrserver.com` (tanpa perlu library tambahan). Kalau butuh full offline, ganti `qrImageUrl()` di `app.js` dengan library QR client-side.
- **Fallback soal:** kalau Gemini/Google Search grounding gagal (kuota habis, API key belum diisi, dll), game tetap jalan pakai 5 soal cadangan statis di `FALLBACK_QUESTIONS` (`get-questions.js`) — supaya demo live kamu gak macet total.

---

## Cek cepat lokal (opsional)
Kalau punya Netlify CLI (`npm install -g netlify-cli`):
```bash
netlify dev
```
Ini menjalankan `public/` + `netlify/functions/` sekaligus di `localhost:8888`, lengkap dengan redirect `/api/*`. Environment variable lokal bisa ditaruh di file `.env` di root (jangan pernah commit file ini kalau repo-nya public).
