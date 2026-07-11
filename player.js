/* ==========================================================================
   LOGIC ARENA — player.js
   Drives player.html: join (via ?game=&group= from the QR, or typed
   manually) -> waiting -> answer questions -> feedback -> (bracket mode:
   match result / spectate) -> game over.
   ========================================================================== */

(() => {
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  let gameId = (params.get('game') || '').toUpperCase();
  let group = (params.get('group') || 'A').toUpperCase();
  let playerId = null;
  let playerName = '';
  let stopCountdown = null;
  let hasAnsweredCurrent = false;
  let lastRenderedQuestionIndex = null;

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('is-active'));
    $(id).classList.add('is-active');
  }

  // ---- Join screen setup -----------------------------------------------------
  $('input-game-code').value = gameId;
  if (params.get('group')) {
    setGroupBadge(group);
  } else {
    renderGroupToggle();
  }

  function setGroupBadge(g) {
    const badge = $('group-badge');
    badge.textContent = g === 'B' ? 'Grup B' : 'Grup A';
    badge.className = `qr-team-label ${g === 'B' ? 'team-b' : 'team-a'}`;
  }

  function renderGroupToggle() {
    const field = $('group-field');
    field.innerHTML = `
      <label>Pilih grup kamu</label>
      <div class="row">
        <button type="button" class="btn btn-sm" id="toggle-group-a" style="background:var(--gold);color:var(--coffee-dark);flex:1;">Grup A</button>
        <button type="button" class="btn btn-sm" id="toggle-group-b" style="background:var(--coffee);color:var(--paper);flex:1;">Grup B</button>
      </div>`;
    $('toggle-group-a').addEventListener('click', () => (group = 'A'));
    $('toggle-group-b').addEventListener('click', () => (group = 'B'));
  }

  $('btn-join').addEventListener('click', async () => {
    gameId = $('input-game-code').value.trim().toUpperCase();
    playerName = $('input-player-name').value.trim();
    $('join-error').style.display = 'none';

    if (!gameId || !playerName) {
      showJoinError('Isi kode game & nama kamu dulu ya.');
      return;
    }

    $('btn-join').disabled = true;
    $('btn-join').textContent = 'Gabung...';
    try {
      const res = await LogicArena.callFunction('join-game', { gameId, name: playerName, teamGroup: group });
      playerId = res.playerId;
      LogicArena.savePlayerId(gameId, playerId);
      $('pq-score').textContent = 'Skor: 0';
      startListening();
    } catch (err) {
      showJoinError(err.message);
    } finally {
      $('btn-join').disabled = false;
      $('btn-join').textContent = 'Gabung Sekarang';
    }
  });

  function showJoinError(msg) {
    $('join-error').textContent = msg;
    $('join-error').style.display = 'block';
  }

  function startListening() {
    showScreen('screen-waiting');
    $('waiting-title').textContent = 'Kamu masuk! Menunggu host mulai...';
    LogicArena.subscribeToGame(gameId, {
      onGame: render,
      onAnswers: () => {},
    });
    LogicArena.getClient()
      .from('players')
      .select('score')
      .eq('id', playerId)
      .maybeSingle()
      .then(({ data }) => data && updateScoreDisplays(data.score));

    // Keep this player's own score chip live too.
    LogicArena.getClient()
      .channel(`player:${playerId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'players', filter: `id=eq.${playerId}` },
        (payload) => updateScoreDisplays(payload.new.score)
      )
      .subscribe();
  }

  function updateScoreDisplays(score) {
    $('pq-score').textContent = `Skor: ${score}`;
    $('waiting-score').textContent = score;
    $('feedback-score').textContent = score;
  }

  // ---- Central render ----------------------------------------------------------
  function render(game) {
    if (!game) return;
    switch (game.status) {
      case 'lobby':
        $('waiting-title').textContent = 'Kamu masuk! Menunggu host mulai...';
        $('waiting-sub').textContent = 'Lihat layar utama buat ikutin jalannya game.';
        showScreen('screen-waiting');
        break;
      case 'generating':
        $('waiting-title').textContent = 'Host lagi meracik soal...';
        $('waiting-sub').textContent = 'Gemini lagi cari tren terbaru buat bikin soal logika.';
        showScreen('screen-waiting');
        break;
      case 'question':
        renderQuestion(game, false);
        break;
      case 'reveal':
        renderFeedback(game);
        break;
      case 'leaderboard':
        $('waiting-title').textContent = 'Ronde soal selesai!';
        $('waiting-sub').textContent = 'Lihat layar utama buat papan skor lengkapnya.';
        showScreen('screen-waiting');
        break;
      case 'bracket_intro':
        $('waiting-title').textContent = 'Bracket sudah dibuat 🏆';
        $('waiting-sub').textContent = 'Lihat layar utama buat susunan babaknya, tunggu babak kamu dimulai.';
        showScreen('screen-waiting');
        break;
      case 'bracket_question':
        renderQuestion(game, true);
        break;
      case 'bracket_reveal':
        renderBracketResult(game);
        break;
      case 'bracket_champion':
      case 'ended':
        showScreen('screen-over');
        break;
    }
  }

  // ---- Question / match answering ------------------------------------------------
  function renderQuestion(game, isBracket) {
    const qIndex = isBracket ? game.current_question_index % game.questions.length : game.current_question_index;

    if (isBracket) {
      const round = game.bracket.rounds[game.bracket.currentRound];
      const myMatch = round.find((m) => m.p1Id === playerId || m.p2Id === playerId);
      if (!myMatch || myMatch.isBye || myMatch.winnerId) {
        $('waiting-title').textContent = myMatch?.isBye
          ? 'Kamu dapat bye ronde ini — otomatis lanjut! 🎉'
          : 'Kamu nonton babak ini';
        $('waiting-sub').textContent = 'Lihat layar utama buat jalannya pertandingan.';
        showScreen('screen-waiting');
        return;
      }
    }

    if (lastRenderedQuestionIndex !== game.current_question_index) {
      hasAnsweredCurrent = false;
      lastRenderedQuestionIndex = game.current_question_index;
    }
    if (hasAnsweredCurrent) {
      showScreen('screen-answered');
      return;
    }

    const q = game.questions[qIndex];
    $('pq-progress').textContent = isBracket
      ? `Babak ${game.bracket.currentRound + 1}`
      : `Soal ${game.current_question_index + 1}/${game.questions.length}`;

    const shapes = ['▲', '◆', '●', '■'];
    $('pq-options').innerHTML = q.options
      .map((opt, i) => `<button class="option-btn opt-${i}" data-i="${i}"><span class="opt-shape">${shapes[i]}</span> ${escapeHtml(opt)}</button>`)
      .join('');

    document.querySelectorAll('#pq-options .option-btn').forEach((btn) => {
      btn.addEventListener('click', () => submitAnswer(game, Number(btn.dataset.i)));
    });

    showScreen('screen-question');
    if (stopCountdown) stopCountdown();
    stopCountdown = LogicArena.startCountdown({
      startedAt: game.question_started_at,
      durationSeconds: game.question_duration_seconds,
      onTick: (s, fraction) => ($('pq-timer-fill').style.width = `${Math.max(0, fraction * 100)}%`),
      onDone: () => {
        if (!hasAnsweredCurrent) showScreen('screen-answered');
      },
    });
  }

  async function submitAnswer(game, selectedIndex) {
    if (hasAnsweredCurrent) return;
    hasAnsweredCurrent = true;
    document.querySelectorAll('#pq-options .option-btn').forEach((b) => (b.disabled = true));
    showScreen('screen-answered');
    try {
      const res = await LogicArena.callFunction('submit-answer', {
        gameId,
        playerId,
        questionIndex: game.current_question_index,
        selectedIndex,
      });
      renderInstantFeedback(res);
    } catch (err) {
      LogicArena.showToast(err.message);
    }
  }

  function renderInstantFeedback(res) {
    $('feedback-emoji').textContent = res.isCorrect ? '✅' : '❌';
    $('feedback-title').textContent = res.isCorrect ? 'Benar!' : 'Kurang tepat!';
    $('feedback-points').textContent = res.isCorrect ? `+${res.points} poin` : '+0 poin';
    updateScoreDisplays(res.newScore);
    showScreen('screen-feedback');
  }

  function renderFeedback(game) {
    // Fallback path (e.g. page refresh mid-reveal): we already showed instant
    // feedback right after submitting, so just make sure we're not stuck on
    // the "answered, waiting" screen.
    if (document.getElementById('screen-answered').classList.contains('is-active')) {
      showScreen('screen-waiting');
      $('waiting-title').textContent = 'Jawaban benar sudah tampil di layar utama';
      $('waiting-sub').textContent = 'Bentar lagi lanjut ke soal berikutnya.';
    }
  }

  function renderBracketResult(game) {
    const round = game.bracket.rounds[game.bracket.currentRound];
    const myMatch = round.find((m) => m.p1Id === playerId || m.p2Id === playerId);
    if (!myMatch) {
      showScreen('screen-waiting');
      $('waiting-title').textContent = 'Lihat layar utama buat hasil babak ini';
      return;
    }
    const won = myMatch.winnerId === playerId;
    $('bracket-result-emoji').textContent = won ? '🏆' : '💔';
    $('bracket-result-title').textContent = won ? 'Kamu menang babak ini!' : 'Kamu tersingkir, makasih udah main!';
    $('bracket-result-sub').textContent = won
      ? 'Tunggu host mulai babak berikutnya.'
      : 'Tetap semangat nonton sampai final ya!';
    showScreen('screen-bracket-result');
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
