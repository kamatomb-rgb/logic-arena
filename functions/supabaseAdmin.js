// ============================================================================
// LOGIC ARENA — netlify/functions/_lib/supabaseAdmin.js
// Server-side only. Uses the SECRET service_role key (bypasses RLS), which
// must only ever live in Netlify's environment variables — never ship it to
// the browser. Every function in this folder shares this one client.
// ============================================================================

const { createClient } = require('@supabase/supabase-js');

let client = null;

function getAdminClient() {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di Netlify Environment Variables.'
    );
  }

  client = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return client;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function parseBody(event) {
  try {
    return JSON.parse(event.body || '{}');
  } catch (_) {
    return {};
  }
}

const GAME_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid mix-ups

function generateGameCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += GAME_CODE_ALPHABET[Math.floor(Math.random() * GAME_CODE_ALPHABET.length)];
  }
  return code;
}

module.exports = { getAdminClient, jsonResponse, parseBody, generateGameCode };
