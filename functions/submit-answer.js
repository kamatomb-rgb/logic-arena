// ============================================================================
// LOGIC ARENA — netlify/functions/submit-answer.js
// POST { gameId, playerId, questionIndex, selectedIndex }
//   -> { isCorrect, points, correctIndex, newScore }
//
// Scoring uses the server's own clock against `question_started_at` (never
// a timestamp the client could send), so nobody can fake a fast answer.
// Writing the row is what Supabase Realtime picks up and fans out to the
// host screen (live "answered" counter) and to the player's own score chip.
// ============================================================================

const { getAdminClient, jsonResponse, parseBody } = require('./supabaseAdmin');

const BASE_POINTS = 500;
const SPEED_BONUS = 500;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const { gameId, playerId, questionIndex, selectedIndex } = parseBody(event);
  if (!gameId || !playerId || typeof questionIndex !== 'number' || typeof selectedIndex !== 'number') {
    return jsonResponse(400, { error: 'Data jawaban tidak lengkap.' });
  }

  try {
    const supabase = getAdminClient();

    const { data: game, error: gameError } = await supabase
      .from('games')
      .select('*')
      .eq('id', gameId)
      .maybeSingle();
    if (gameError) throw gameError;
    if (!game) return jsonResponse(404, { error: 'Game tidak ditemukan.' });

    const isBracketPhase = game.status === 'bracket_question';
    const isQuizPhase = game.status === 'question';
    if (!isBracketPhase && !isQuizPhase) {
      return jsonResponse(409, { error: 'Bukan waktunya menjawab sekarang.' });
    }
    if (questionIndex !== game.current_question_index) {
      return jsonResponse(409, { error: 'Soal ini sudah lewat.' });
    }

    // In bracket phase, only the two players in the active match this round
    // may answer — everyone else is spectating.
    if (isBracketPhase) {
      const round = game.bracket?.rounds?.[game.bracket.currentRound] || [];
      const myMatch = round.find((m) => m.p1Id === playerId || m.p2Id === playerId);
      if (!myMatch || myMatch.isBye || myMatch.winnerId) {
        return jsonResponse(409, { error: 'Kamu tidak main di babak ini.' });
      }
    }

    const questionsList = game.questions || [];
    const question = questionsList[questionIndex % questionsList.length];
    if (!question) return jsonResponse(400, { error: 'Soal tidak ditemukan.' });

    const isCorrect = selectedIndex === question.correct_index;
    const elapsedSeconds = (Date.now() - new Date(game.question_started_at).getTime()) / 1000;
    const remainingFraction = Math.max(0, Math.min(1, 1 - elapsedSeconds / game.question_duration_seconds));
    const points = isCorrect ? Math.round(BASE_POINTS + SPEED_BONUS * remainingFraction) : 0;

    const { error: insertError } = await supabase.from('answers').insert({
      game_id: gameId,
      player_id: playerId,
      question_index: questionIndex,
      selected_index: selectedIndex,
      is_correct: isCorrect,
      points,
    });
    // 23505 = unique_violation -> this player already answered this question.
    if (insertError && insertError.code !== '23505') throw insertError;
    if (insertError && insertError.code === '23505') {
      return jsonResponse(409, { error: 'Kamu sudah menjawab soal ini.' });
    }

    const { data: updatedPlayer, error: rpcError } = await supabase.rpc('increment_player_score', {
      p_player_id: playerId,
      p_amount: points,
    });
    if (rpcError) throw rpcError;

    return jsonResponse(200, {
      isCorrect,
      points,
      correctIndex: question.correct_index,
      newScore: updatedPlayer ?? points,
    });
  } catch (err) {
    console.error('submit-answer error:', err);
    return jsonResponse(500, { error: err.message || 'Gagal mengirim jawaban.' });
  }
};
