// ============================================================================
// LOGIC ARENA — netlify/functions/update-game-state.js
// POST { gameId, action } where action is one of:
//   'reveal'          quiz phase: show the correct answer for the current question
//   'next'            quiz phase: advance to the next question, or to the leaderboard
//   'generate_bracket'  bracket mode only: seed a single-elimination bracket from scores
//   'bracket_round'   bracket mode: start the current round's shared question
//   'bracket_reveal'  bracket mode: resolve the round's matches from submitted answers
//   'bracket_advance' bracket mode: pair up this round's winners into the next round
//                      (or crown a champion if only one winner remains)
//   'end'             team mode: finish the game
//
// This function is the only place that decides what happens next — the host
// screen just calls an action and then renders whatever the `games` row
// becomes, via the Realtime subscription in app.js.
// ============================================================================

const { getAdminClient, jsonResponse, parseBody } = require('./supabaseAdmin');
const { buildFirstRound, buildNextRound } = require('./bracket');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const { gameId, action } = parseBody(event);
  if (!gameId || !action) return jsonResponse(400, { error: 'gameId dan action wajib diisi.' });

  try {
    const supabase = getAdminClient();
    const { data: game, error: gameError } = await supabase.from('games').select('*').eq('id', gameId).maybeSingle();
    if (gameError) throw gameError;
    if (!game) return jsonResponse(404, { error: 'Game tidak ditemukan.' });

    switch (action) {
      case 'reveal':
        return await handleReveal(supabase, game);
      case 'next':
        return await handleNext(supabase, game);
      case 'generate_bracket':
        return await handleGenerateBracket(supabase, game);
      case 'bracket_round':
        return await handleBracketRound(supabase, game);
      case 'bracket_reveal':
        return await handleBracketReveal(supabase, game);
      case 'bracket_advance':
        return await handleBracketAdvance(supabase, game);
      case 'end':
        await supabase.from('games').update({ status: 'ended' }).eq('id', gameId);
        return jsonResponse(200, { ok: true });
      default:
        return jsonResponse(400, { error: `Action "${action}" tidak dikenal.` });
    }
  } catch (err) {
    console.error('update-game-state error:', err);
    return jsonResponse(500, { error: err.message || 'Gagal mengubah status game.' });
  }
};

async function handleReveal(supabase, game) {
  await supabase.from('games').update({ status: 'reveal' }).eq('id', game.id);
  return jsonResponse(200, { ok: true });
}

async function handleNext(supabase, game) {
  const nextIndex = game.current_question_index + 1;
  if (nextIndex >= game.questions.length) {
    await supabase.from('games').update({ status: 'leaderboard' }).eq('id', game.id);
  } else {
    await supabase
      .from('games')
      .update({ status: 'question', current_question_index: nextIndex, question_started_at: new Date().toISOString() })
      .eq('id', game.id);
  }
  return jsonResponse(200, { ok: true });
}

async function handleGenerateBracket(supabase, game) {
  if (game.mode !== 'bracket') return jsonResponse(400, { error: 'Game ini bukan mode bracket.' });

  const { data: players, error } = await supabase
    .from('players')
    .select('id, name, score')
    .eq('game_id', game.id)
    .order('score', { ascending: false });
  if (error) throw error;
  if (!players || players.length < 2) {
    return jsonResponse(400, { error: 'Minimal 2 pemain untuk membuat bracket.' });
  }

  const firstRound = buildFirstRound(players);
  const bracket = { rounds: [firstRound], currentRound: 0 };

  await supabase
    .from('games')
    .update({ bracket, status: 'bracket_intro', current_question_index: -1 })
    .eq('id', game.id);

  return jsonResponse(200, { ok: true });
}

async function handleBracketRound(supabase, game) {
  const bracket = game.bracket;
  if (!bracket) return jsonResponse(400, { error: 'Bracket belum dibuat.' });

  await supabase
    .from('games')
    .update({
      status: 'bracket_question',
      current_question_index: bracket.currentRound,
      question_started_at: new Date().toISOString(),
    })
    .eq('id', game.id);

  return jsonResponse(200, { ok: true });
}

async function handleBracketReveal(supabase, game) {
  const bracket = game.bracket;
  if (!bracket) return jsonResponse(400, { error: 'Bracket belum dibuat.' });

  const round = bracket.rounds[bracket.currentRound];
  const questionIndex = bracket.currentRound;

  const { data: answers, error } = await supabase
    .from('answers')
    .select('player_id, is_correct, answered_at')
    .eq('game_id', game.id)
    .eq('question_index', questionIndex);
  if (error) throw error;

  const byPlayer = new Map((answers || []).map((a) => [a.player_id, a]));

  const resolvedRound = round.map((match) => {
    if (match.winnerId || match.isBye) return match; // byes already resolved at creation
    const a1 = byPlayer.get(match.p1Id);
    const a2 = byPlayer.get(match.p2Id);

    let winnerId = null;
    if (a1?.is_correct && !a2?.is_correct) winnerId = match.p1Id;
    else if (!a1?.is_correct && a2?.is_correct) winnerId = match.p2Id;
    else if (a1?.is_correct && a2?.is_correct) {
      // both correct -> whoever answered first wins
      winnerId = new Date(a1.answered_at) <= new Date(a2.answered_at) ? match.p1Id : match.p2Id;
    } else {
      // neither answered correctly (or didn't answer at all) -> coin flip so
      // the bracket can still progress live rather than stalling the game
      winnerId = Math.random() < 0.5 ? match.p1Id : match.p2Id;
    }
    const winnerName = winnerId === match.p1Id ? match.p1Name : match.p2Name;
    return { ...match, winnerId, winnerName };
  });

  const rounds = [...bracket.rounds];
  rounds[bracket.currentRound] = resolvedRound;

  await supabase
    .from('games')
    .update({ bracket: { ...bracket, rounds }, status: 'bracket_reveal' })
    .eq('id', game.id);

  return jsonResponse(200, { ok: true });
}

async function handleBracketAdvance(supabase, game) {
  const bracket = game.bracket;
  if (!bracket) return jsonResponse(400, { error: 'Bracket belum dibuat.' });

  const currentRound = bracket.rounds[bracket.currentRound];
  if (currentRound.length === 1) {
    // Final match just resolved -> we have a champion.
    await supabase.from('games').update({ status: 'bracket_champion' }).eq('id', game.id);
    return jsonResponse(200, { ok: true, champion: true });
  }

  const nextRound = buildNextRound(currentRound);
  const rounds = [...bracket.rounds, nextRound];

  await supabase
    .from('games')
    .update({ bracket: { rounds, currentRound: bracket.currentRound + 1 }, status: 'bracket_intro' })
    .eq('id', game.id);

  return jsonResponse(200, { ok: true });
}
