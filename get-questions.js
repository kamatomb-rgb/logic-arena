// ============================================================================
// LOGIC ARENA — netlify/functions/get-questions.js
// POST { gameId } -> generates 5 multiple-choice logic questions grounded in
// this week's trends via Gemini + Google Search, saves them on the game row,
// and flips the game into 'question' status so Realtime pushes it to every
// connected screen at once.
//
// Model: gemini-2.5-flash, with the built-in `googleSearch` tool for
// grounding. This is combined with `responseMimeType: "application/json"` —
// note that this combo is only reliable for Gemini's *built-in* tools like
// googleSearch; combining JSON mode with custom function-calling tools is a
// known source of 400 errors on this API, but that doesn't apply here.
// Even so, grounded responses sometimes wrap JSON in prose or code fences,
// so the parsing below is defensive, and a static fallback question bank
// keeps the game playable even if Gemini or the search grounding fails.
// ============================================================================

const { getAdminClient, jsonResponse, parseBody } = require('./supabaseAdmin');

const QUESTION_COUNT = 5;

const FALLBACK_QUESTIONS = [
  {
    question: 'Semua Blorp adalah Zeeb. Sebagian Zeeb adalah Kwik. Jadi sudah pasti...',
    options: [
      'Semua Blorp adalah Kwik',
      'Sebagian Blorp mungkin Kwik, tapi belum pasti',
      'Tidak ada Blorp yang Kwik',
      'Semua Kwik adalah Blorp',
    ],
    correct_index: 1,
  },
  {
    question: 'Kalau hari ini Rabu, maka besok bukan Jumat. Hari ini Rabu. Kesimpulan yang valid?',
    options: ['Besok Kamis', 'Besok bukan Jumat', 'Besok Sabtu', 'Tidak bisa disimpulkan'],
    correct_index: 1,
  },
  {
    question: 'Deret angka: 2, 6, 12, 20, 30, ... Angka selanjutnya adalah?',
    options: ['36', '40', '42', '44'],
    correct_index: 2,
  },
  {
    question: 'Ani lebih tinggi dari Budi. Budi lebih tinggi dari Citra. Siapa yang paling pendek?',
    options: ['Ani', 'Budi', 'Citra', 'Tidak bisa ditentukan'],
    correct_index: 2,
  },
  {
    question: 'Jika semua kucing bisa mengeong, dan Milo bisa mengeong, apakah Milo pasti kucing?',
    options: ['Ya, pasti kucing', 'Belum tentu — bisa jadi hewan lain', 'Milo pasti anjing', 'Pertanyaan ini tidak logis'],
    correct_index: 1,
  },
];

function buildPrompt() {
  return `Cari tren media sosial, berita viral, atau meme paling hangat minggu ini (bebas topik: hiburan, olahraga, teknologi, budaya pop Indonesia maupun global).
Lalu buatkan tepat ${QUESTION_COUNT} pertanyaan pilihan ganda bertema LOGIKA (bukan sekadar trivia hafalan) yang terinspirasi/menyelipkan referensi ringan ke tren-tren tersebut, cocok untuk game kuis party rame-rame.

Setiap pertanyaan harus:
- Menguji penalaran logis (deduksi, urutan, sebab-akibat, pola), bukan cuma "siapa/apa/kapan".
- Punya tepat 4 pilihan jawaban, hanya 1 yang benar.
- Menggunakan Bahasa Indonesia yang santai dan mudah dipahami.
- Singkat, muat dibaca sekilas di layar TV/proyektor dalam beberapa detik.

Balas HANYA dengan JSON array valid (tanpa markdown, tanpa teks lain), dengan skema persis seperti ini:
[
  { "question": "...", "options": ["...", "...", "...", "..."], "correct_index": 0 }
]`;
}

function extractJsonArray(text) {
  if (!text) return null;
  let cleaned = text.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  cleaned = cleaned.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  // If there's still leading/trailing prose, grab the first [...] block.
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch (_) {
    return null;
  }
}

function validateQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const cleaned = [];
  for (const item of raw.slice(0, QUESTION_COUNT)) {
    if (
      !item ||
      typeof item.question !== 'string' ||
      !Array.isArray(item.options) ||
      item.options.length !== 4 ||
      !item.options.every((o) => typeof o === 'string') ||
      typeof item.correct_index !== 'number' ||
      item.correct_index < 0 ||
      item.correct_index > 3
    ) {
      return null; // any malformed item -> reject the whole batch, use fallback
    }
    cleaned.push({
      question: item.question.slice(0, 220),
      options: item.options.map((o) => o.slice(0, 90)),
      correct_index: item.correct_index,
    });
  }
  return cleaned.length === QUESTION_COUNT ? cleaned : null;
}

async function generateWithGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY belum di-set.');

  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: buildPrompt(),
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: 'application/json',
    },
  });

  const text = response.text;
  const raw = extractJsonArray(text);
  const validated = validateQuestions(raw);
  if (!validated) throw new Error('Format soal dari Gemini tidak valid.');
  return validated;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const { gameId } = parseBody(event);
  if (!gameId) return jsonResponse(400, { error: 'gameId wajib diisi.' });

  try {
    const supabase = getAdminClient();

    const { error: markGenerating } = await supabase
      .from('games')
      .update({ status: 'generating' })
      .eq('id', gameId);
    if (markGenerating) throw markGenerating;

    let questions;
    try {
      questions = await generateWithGemini();
    } catch (genError) {
      console.error('Gemini generation failed, using fallback questions:', genError.message);
      questions = FALLBACK_QUESTIONS;
    }

    const { error: updateError } = await supabase
      .from('games')
      .update({
        questions,
        status: 'question',
        current_question_index: 0,
        question_started_at: new Date().toISOString(),
      })
      .eq('id', gameId);

    if (updateError) throw updateError;

    return jsonResponse(200, { ok: true, count: questions.length });
  } catch (err) {
    console.error('get-questions error:', err);
    return jsonResponse(500, { error: err.message || 'Gagal membuat soal.' });
  }
};
