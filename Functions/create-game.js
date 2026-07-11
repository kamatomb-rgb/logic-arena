// ============================================================================
// LOGIC ARENA — netlify/functions/create-game.js
// POST { mode: 'team'|'bracket', teamAName, teamBName } -> { gameId }
// ============================================================================

const { getAdminClient, jsonResponse, parseBody, generateGameCode } = require('./_lib/supabaseAdmin');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const { mode, teamAName, teamBName } = parseBody(event);
  if (!['team', 'bracket'].includes(mode)) {
    return jsonResponse(400, { error: 'Mode harus "team" atau "bracket".' });
  }

  try {
    const supabase = getAdminClient();

    // Try a few times in the (very unlikely) case of a game-code collision.
    let gameId = null;
    let lastError = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateGameCode(5);
      const { data, error } = await supabase
        .from('games')
        .insert({
          id: candidate,
          mode,
          status: 'lobby',
          team_a_name: (teamAName || 'Tim Gold').slice(0, 24),
          team_b_name: (teamBName || 'Tim Coffee').slice(0, 24),
          current_question_index: -1,
          question_duration_seconds: 20,
          questions: [],
        })
        .select('id')
        .single();

      if (!error) {
        gameId = data.id;
        break;
      }
      lastError = error;
      // 23505 = unique_violation -> code collision, just retry with a new one.
      if (error.code !== '23505') break;
    }

    if (!gameId) throw lastError || new Error('Gagal membuat kode game.');

    return jsonResponse(200, { gameId });
  } catch (err) {
    console.error('create-game error:', err);
    return jsonResponse(500, { error: err.message || 'Gagal membuat game.' });
  }
};
