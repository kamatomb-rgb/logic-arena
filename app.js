/* ==========================================================================
   LOGIC ARENA — app.js
   Shared client-side core: Supabase Realtime client + helpers used by both
   the Host screen (index.html/host.js) and the Player controller
   (player.html/player.js).

   Real-time sync in this project does NOT use Server-Sent Events or a
   long-lived Netlify Function. Netlify Functions are stateless and cannot
   hold an open connection to broadcast to other clients (there is no shared
   memory between two separate invocations), so a "submit-answer" call from
   Player A's phone has no way to push data into an SSE stream already held
   open by the Host's browser. Instead, all real-time fan-out happens
   through Supabase Realtime (Postgres Changes over WebSocket), and Netlify
   Functions are only used for the pieces that must run on a trusted server
   (the Gemini API key, and score/game-state writes). See README.md for the
   full explanation.
   ========================================================================== */

const LogicArena = (() => {
  // Filled in from /public/config.js (see that file for setup instructions).
  const SUPABASE_URL = window.LOGIC_ARENA_CONFIG?.SUPABASE_URL || '';
  const SUPABASE_ANON_KEY = window.LOGIC_ARENA_CONFIG?.SUPABASE_ANON_KEY || '';

  let supabase = null;

  function getClient() {
    if (supabase) return supabase;
    if (!window.supabase || !SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error(
        'Supabase belum dikonfigurasi. Isi SUPABASE_URL & SUPABASE_ANON_KEY di public/config.js'
      );
      return null;
    }
    supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      realtime: { params: { eventsPerSecond: 10 } },
    });
    return supabase;
  }

  // ---- Netlify Functions helper -----------------------------------------
  // Calls through the /api/* redirect defined in netlify.toml, which maps
  // to /.netlify/functions/* — kept as a separate indirection so the public
  // URL doesn't leak the Netlify-specific path.
  async function callFunction(name, body) {
    const res = await fetch(`/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* no body */
    }
    if (!res.ok) {
      const message = data?.error || `Gagal memanggil ${name} (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  // ---- Realtime subscriptions --------------------------------------------
  // One channel per game code carries updates for the `games`, `players`
  // and `answers` rows tied to that game. Postgres Changes is used (rather
  // than Broadcast) because it needs no extra trigger setup and comfortably
  // handles the player counts a party game like this will ever see.
  function subscribeToGame(gameId, handlers = {}) {
    const client = getClient();
    if (!client) return null;

    const channel = client.channel(`game:${gameId}`);

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'games', filter: `id=eq.${gameId}` },
      (payload) => handlers.onGame && handlers.onGame(payload.new)
    );

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players', filter: `game_id=eq.${gameId}` },
      (payload) => handlers.onPlayers && handlers.onPlayers(payload)
    );

    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'answers', filter: `game_id=eq.${gameId}` },
      (payload) => handlers.onAnswers && handlers.onAnswers(payload)
    );

    channel.subscribe();
    return channel;
  }

  async function fetchGame(gameId) {
    const client = getClient();
    if (!client) return null;
    const { data, error } = await client.from('games').select('*').eq('id', gameId).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function fetchPlayers(gameId) {
    const client = getClient();
    if (!client) return [];
    const { data, error } = await client
      .from('players')
      .select('*')
      .eq('game_id', gameId)
      .order('joined_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // ---- QR codes -----------------------------------------------------------
  // Uses the free api.qrserver.com image endpoint so no client-side QR
  // library needs to be bundled. Swap for a local library later if you need
  // to work fully offline.
  function qrImageUrl(dataUrl, size = 320) {
    const encoded = encodeURIComponent(dataUrl);
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encoded}`;
  }

  function playerJoinUrl(gameId, group) {
    const url = new URL('/player.html', window.location.origin);
    url.searchParams.set('game', gameId);
    url.searchParams.set('group', group); // 'A' | 'B'
    return url.toString();
  }

  // ---- Small UI utils -------------------------------------------------------
  function showToast(message, ms = 2600) {
    let el = document.getElementById('la-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'la-toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('is-visible'), ms);
  }

  function initials(name) {
    return (name || '?').trim().slice(0, 2).toUpperCase();
  }

  function avatarColor(seedString) {
    const palette = ['#EF476F', '#118AB2', '#FFD166', '#06D6A0', '#6F4E37', '#9B5DE5'];
    let hash = 0;
    for (const ch of seedString || 'x') hash = (hash * 31 + ch.charCodeAt(0)) % 997;
    return palette[hash % palette.length];
  }

  // Countdown driven by a shared server timestamp so every device (host +
  // every phone) agrees on the remaining time regardless of clock drift on
  // any single device — everyone computes from the same `startedAt`.
  function startCountdown({ startedAt, durationSeconds, onTick, onDone }) {
    const startMs = new Date(startedAt).getTime();
    const endMs = startMs + durationSeconds * 1000;
    const tick = () => {
      const remaining = Math.max(0, endMs - Date.now());
      onTick && onTick(remaining / 1000, remaining / (durationSeconds * 1000));
      if (remaining <= 0) {
        clearInterval(timer);
        onDone && onDone();
      }
    };
    const timer = setInterval(tick, 150);
    tick();
    return () => clearInterval(timer);
  }

  function getOrCreatePlayerId(gameId) {
    const key = `la_player_${gameId}`;
    let id = sessionStorage.getItem(key);
    return id || null;
  }

  function savePlayerId(gameId, playerId) {
    sessionStorage.setItem(`la_player_${gameId}`, playerId);
  }

  return {
    getClient,
    callFunction,
    subscribeToGame,
    fetchGame,
    fetchPlayers,
    qrImageUrl,
    playerJoinUrl,
    showToast,
    initials,
    avatarColor,
    startCountdown,
    getOrCreatePlayerId,
    savePlayerId,
  };
})();
