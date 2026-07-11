// ============================================================================
// LOGIC ARENA — netlify/functions/join-game.js
// POST { gameId, name, teamGroup: 'A'|'B' } -> { playerId }
// ============================================================================

const { getAdminClient, jsonResponse, parseBody } = require('./supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const { gameId, name, teamGroup } = parseBody(event);
  const cleanName = (name || '').trim().slice(0, 20);
  const group = teamGroup === 'B' ? 'B' : 'A';

  if (!gameId || !cleanName) {
    return jsonResponse(400, { error: 'Kode game dan nama wajib diisi.' });
  }

  try {
    const supabase = getAdminClient();

    const { data: game, error: gameError } = await supabase
      .from('games')
      .select('id, status')
      .eq('id', gameId.toUpperCase())
      .maybeSingle();

    if (gameError) throw gameError;
    if (!game) return jsonResponse(404, { error: 'Kode game tidak ditemukan. Cek lagi kodenya ya.' });
    if (game.status !== 'lobby') {
      return jsonResponse(409, { error: 'Game ini sudah dimulai, kamu nggak bisa gabung lagi sekarang.' });
    }

    const { data: player, error: insertError } = await supabase
      .from('players')
      .insert({ game_id: game.id, name: cleanName, team_group: group, score: 0 })
      .select('id')
      .single();

    if (insertError) throw insertError;

    return jsonResponse(200, { playerId: player.id });
  } catch (err) {
    console.error('join-game error:', err);
    return jsonResponse(500, { error: err.message || 'Gagal gabung ke game.' });
  }
};
