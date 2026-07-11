/* ==========================================================================
   LOGIC ARENA — host.js
   Drives index.html: setup -> lobby (2 QR codes) -> live question flow ->
   reveal -> leaderboard -> (team mode: end) / (bracket mode: bracket tree
   rounds -> champion). All state changes come from Supabase Realtime
   (see app.js `subscribeToGame`) — this file never trusts its own local
   state as the source of truth, it only ever renders what the `games` row
   says right now.
   ========================================================================== */

(() => {
  const $ = (id) => document.getElementById(id);

  let gameId = null;
  let mode = 'team';
  let teamAName = 'Tim Gold';
  let teamBName = 'Tim Coffee';
  let stopCountdown = null;
  let currentQuestionIndex = -1;
  let answeredCount = 0;

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('is-active'));
    $(id).classList.add('is-active');
  }

  // ---- 1) Splash -----------------------------------------------------------
  $('btn-lets-play').addEventListener('click', () => showScreen('screen-setup'));
  $('btn-im-player').addEventListener('click', () => (window.location.href = '/player.html'));

  // ---- 2) Setup --------------------------------------------------------------
  document.querySelectorAll('.mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.mode-card').forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      mode = card.dataset.mode;
    });
  });

  $('btn-create-game').addEventListener('click', async () => {
    teamAName = $('input-team-a').value.trim() || 'Tim Gold';
    teamBName = $('input-team-b').value.trim() || 'Tim Coffee';
    $('setup-error').style.display = 'none';
    $('btn-create-game').disabled = true;
    $('btn-create-game').textContent = 'Membuat game...';
    try {
      const res = await LogicArena.callFunction('create-game', { mode, teamAName, teamBName });
      gameId = res.gameId;
      enterLobby();
    } catch (err) {
      $('setup-error').textContent = err.message;
      $('setup-error').style.display = 'block';
    } finally {
      $('btn-create-game').disabled = false;
      $('btn-create-game').textContent = 'Buat Game';
    }
  });

  // ---- 3) Lobby ----------------------------------------------------------------
  function enterLobby() {
    $('lobby-code').textContent = gameId;
    $('qr-label-a').textContent = teamAName;
    $('qr-label-b').textContent = teamBName;

    const urlA = LogicArena.playerJoinUrl(gameId, 'A');
    const urlB = LogicArena.playerJoinUrl(gameId, 'B');
    $('qr-img-a').src = LogicArena.qrImageUrl(urlA);
    $('qr-img-b').src = LogicArena.qrImageUrl(urlB);
    $('qr-url-a').textContent = urlA;
    $('qr-url-b').textContent = urlB;

    showScreen('screen-lobby');
    refreshRoster();
    LogicArena.subscribeToGame(gameId, {
      onGame: render,
      onPlayers: refreshRoster,
      onAnswers: onAnswerInserted,
    });
  }

  async function refreshRoster() {
    const players = await LogicArena.fetchPlayers(gameId);
    $('lobby-count').textContent = `${players.length} pemain`;
    const roster = $('lobby-roster');
    if (players.length === 0) {
      roster.innerHTML = '<span class="muted">Belum ada yang gabung. Ayo scan QR-nya! 👀</span>';
    } else {
      roster.innerHTML = players
        .map(
          (p) => `
        <span class="player-chip">
          <span class="player-avatar" style="background:${LogicArena.avatarColor(p.id)}">${LogicArena.initials(p.name)}</span>
          ${escapeHtml(p.name)}
        </span>`
        )
        .join('');
    }
    $('btn-start-game').disabled = players.length < 2;
    $('btn-start-game').textContent =
      players.length < 2 ? 'Mulai Game (minimal 2 pemain)' : `Mulai Game (${players.length} pemain)`;
  }

  $('btn-start-game').addEventListener('click', async () => {
    showScreen('screen-generating');
    try {
      await LogicArena.callFunction('get-questions', { gameId });
      // The `games` row update (status -> 'question') arrives via Realtime
      // and `render()` takes it from here.
    } catch (err) {
      LogicArena.showToast(err.message);
      showScreen('screen-lobby');
    }
  });

  // ---- Central render: always reacts to the latest `games` row ---------------
  function render(game) {
    if (!game) return;
    currentQuestionIndex = game.current_question_index;

    switch (game.status) {
      case 'lobby':
        break; // already handled by enterLobby
      case 'generating':
        showScreen('screen-generating');
        break;
      case 'question':
        renderQuestion(game);
        break;
      case 'reveal':
        renderReveal(game);
        break;
      case 'leaderboard':
        renderLeaderboard(game);
        break;
      case 'bracket_intro':
      case 'bracket_reveal':
        renderBracket(game);
        break;
      case 'bracket_question':
        renderBracket(game, true);
        break;
      case 'bracket_champion':
      case 'ended':
        renderEnd(game);
        break;
    }
  }

  // ---- 5) Question -------------------------------------------------------------
  function renderQuestion(game) {
    if (stopCountdown) stopCountdown();
    answeredCount = 0;
    $('q-answered-count').textContent = '0 terjawab';

    const q = game.questions[game.current_question_index];
    $('q-progress').textContent = `Soal ${game.current_question_index + 1}/${game.questions.length}`;
    $('q-text').textContent = q.question;

    const shapes = ['▲', '◆', '●', '■'];
    $('q-options-host').innerHTML = q.options
      .map((opt, i) => `<div class="option-btn opt-${i}"><span class="opt-shape">${shapes[i]}</span> ${escapeHtml(opt)}</div>`)
      .join('');

    showScreen('screen-question');
    stopCountdown = LogicArena.startCountdown({
      startedAt: game.question_started_at,
      durationSeconds: game.question_duration_seconds,
      onTick: (secondsLeft, fraction) => {
        $('q-timer-fill').style.width = `${Math.max(0, fraction * 100)}%`;
      },
      onDone: () => advance('reveal'),
    });
  }

  function onAnswerInserted(payload) {
    if (payload.eventType !== 'INSERT') return;
    if (payload.new.question_index !== currentQuestionIndex) return;
    answeredCount += 1;
    $('q-answered-count').textContent = `${answeredCount} terjawab`;
  }

  $('btn-reveal').addEventListener('click', () => advance('reveal'));

  // ---- 6) Reveal -----------------------------------------------------------------
  async function renderReveal(game) {
    if (stopCountdown) stopCountdown();
    const q = game.questions[game.current_question_index];
    $('reveal-answer-text').textContent = q.options[q.correct_index];

    if (game.mode === 'team') {
      $('reveal-team-battle').style.display = 'flex';
      const totals = await teamTotals(game);
      $('reveal-team-a-name').textContent = game.team_a_name;
      $('reveal-team-b-name').textContent = game.team_b_name;
      $('reveal-team-a-score').textContent = totals.A;
      $('reveal-team-b-score').textContent = totals.B;
    } else {
      $('reveal-team-battle').style.display = 'none';
    }

    const players = await LogicArena.fetchPlayers(gameId);
    $('reveal-top-players').innerHTML = topPlayersHtml(players, 3);
    showScreen('screen-reveal');
  }

  $('btn-next-question').addEventListener('click', () => advance('next'));

  // ---- 7) Leaderboard ---------------------------------------------------------
  async function renderLeaderboard(game) {
    const players = await LogicArena.fetchPlayers(gameId);
    if (game.mode === 'team') {
      $('lb-team-battle').style.display = 'flex';
      const totals = await teamTotals(game);
      $('lb-team-a-name').textContent = game.team_a_name;
      $('lb-team-b-name').textContent = game.team_b_name;
      $('lb-team-a-score').textContent = totals.A;
      $('lb-team-b-score').textContent = totals.B;
    } else {
      $('lb-team-battle').style.display = 'none';
    }
    $('lb-list').innerHTML = topPlayersHtml(players, 10);
    $('btn-generate-bracket').style.display = game.mode === 'bracket' ? 'inline-flex' : 'none';
    showScreen('screen-leaderboard');
  }

  $('btn-generate-bracket').addEventListener('click', () => advance('generate_bracket'));
  $('btn-end-game').addEventListener('click', () => advance('end'));

  // ---- 8) Bracket ---------------------------------------------------------------
  function renderBracket(game, showQuestionPanel) {
    if (stopCountdown) stopCountdown();
    const bracket = game.bracket;
    $('bracket-round-label').textContent = `Babak ${bracket.currentRound + 1} dari ${bracket.rounds.length}`;

    $('bracket-rounds').innerHTML = bracket.rounds
      .map(
        (round, ri) => `
      <div class="bracket-round">
        <div class="bracket-round-title">${ri === bracket.rounds.length - 1 ? 'Final' : `Babak ${ri + 1}`}</div>
        ${round
          .map(
            (m) => `
          <div class="bracket-match">
            <div class="bracket-slot ${slotClass(m, m.p1Id)}">${escapeHtml(m.p1Name || 'TBD')}</div>
            <div class="bracket-slot ${slotClass(m, m.p2Id)}">${escapeHtml(m.p2Name || (m.isBye ? 'BYE' : 'TBD'))}</div>
          </div>`
          )
          .join('')}
      </div>`
      )
      .join('');

    const questionCard = $('bracket-question-card');
    const timerTrack = $('bracket-timer-track');
    const actionBtn = $('btn-bracket-action');

    if (showQuestionPanel) {
      const q = game.questions[game.current_question_index % game.questions.length];
      $('bracket-q-text').textContent = q.question;
      questionCard.style.display = 'block';
      timerTrack.style.display = 'block';
      actionBtn.textContent = 'Tampilkan Pemenang Babak Ini';
      actionBtn.onclick = () => advance('bracket_reveal');
      stopCountdown = LogicArena.startCountdown({
        startedAt: game.question_started_at,
        durationSeconds: game.question_duration_seconds,
        onTick: (s, fraction) => ($('bracket-timer-fill').style.width = `${Math.max(0, fraction * 100)}%`),
        onDone: () => advance('bracket_reveal'),
      });
    } else {
      questionCard.style.display = 'none';
      timerTrack.style.display = 'none';
      if (game.status === 'bracket_reveal') {
        actionBtn.textContent = 'Lanjut ke Babak Berikutnya';
        actionBtn.onclick = () => advance('bracket_advance');
      } else {
        actionBtn.textContent = `Mulai Babak ${bracket.currentRound + 1}`;
        actionBtn.onclick = () => advance('bracket_round');
      }
    }
    showScreen('screen-bracket');
  }

  function slotClass(match, slotId) {
    if (!match.winnerId) return '';
    if (match.winnerId === slotId) return 'is-winner';
    return 'is-eliminated';
  }

  // ---- 9) End -------------------------------------------------------------------
  async function renderEnd(game) {
    if (stopCountdown) stopCountdown();
    const players = await LogicArena.fetchPlayers(gameId);
    let html = '';
    if (game.mode === 'bracket' && game.bracket) {
      const finalRound = game.bracket.rounds[game.bracket.rounds.length - 1];
      const championId = finalRound[0]?.winnerId;
      const champion = players.find((p) => p.id === championId);
      $('end-title').textContent = champion ? `🏆 ${champion.name} adalah Juaranya!` : 'Game selesai!';
    } else {
      $('end-title').textContent = 'Game selesai!';
      const totals = await teamTotals(game);
      const winner = totals.A === totals.B ? 'Seri!' : totals.A > totals.B ? game.team_a_name : game.team_b_name;
      html += `<h3 class="center-text">${totals.A === totals.B ? 'Hasil imbang!' : `${escapeHtml(winner)} menang!`}</h3>`;
      html += `<p class="center-text muted">${escapeHtml(game.team_a_name)} ${totals.A} — ${totals.B} ${escapeHtml(game.team_b_name)}</p>`;
    }
    html += topPlayersHtml(players, 10);
    $('end-summary').innerHTML = html;
    showScreen('screen-end');
  }

  $('btn-play-again').addEventListener('click', () => window.location.reload());

  // ---- Shared helpers -------------------------------------------------------------
  async function advance(action) {
    try {
      await LogicArena.callFunction('update-game-state', { gameId, action });
    } catch (err) {
      LogicArena.showToast(err.message);
    }
  }

  async function teamTotals(game) {
    const players = await LogicArena.fetchPlayers(gameId);
    const totals = { A: 0, B: 0 };
    for (const p of players) {
      if (p.team_group === 'A') totals.A += p.score;
      else if (p.team_group === 'B') totals.B += p.score;
    }
    return totals;
  }

  function topPlayersHtml(players, limit) {
    const sorted = [...players].sort((a, b) => b.score - a.score).slice(0, limit);
    return `<div class="leaderboard-list">${sorted
      .map(
        (p, i) => `
      <div class="leaderboard-row">
        <span class="leaderboard-rank">${i + 1}</span>
        <span class="player-avatar" style="background:${LogicArena.avatarColor(p.id)}">${LogicArena.initials(p.name)}</span>
        <span class="leaderboard-name">${escapeHtml(p.name)}</span>
        <span class="leaderboard-points">${p.score}</span>
      </div>`
      )
      .join('')}</div>`;
  }

  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
