// ============================================================================
// LOGIC ARENA — netlify/functions/_lib/bracket.js
// Standard single-elimination seeding so the top scorers from the quiz round
// don't meet each other until as late as possible in the bracket (the same
// seeding order used by real tournaments: for 8 seeds -> 1v8, 4v5, 2v7, 3v6).
// ============================================================================

function nextPowerOfTwo(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Recursively builds the classic seed order, e.g. seedOrder(8) => [1,8,4,5,2,7,3,6]
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const len = order.length * 2;
    const next = [];
    for (const s of order) {
      next.push(s, len + 1 - s);
    }
    order = next;
  }
  return order;
}

// players: array sorted by score desc, e.g. [{id, name, score}, ...]
// Returns the first round of matches, padding with byes as needed.
function buildFirstRound(players) {
  const size = nextPowerOfTwo(Math.max(players.length, 2));
  const order = seedOrder(size);
  // order holds 1-based seed numbers; seed 1 = players[0] (highest score), etc.
  const bySeed = (seed) => players[seed - 1] || null;

  const matches = [];
  for (let i = 0; i < order.length; i += 2) {
    const p1 = bySeed(order[i]);
    const p2 = bySeed(order[i + 1]);
    if (p1 && !p2) {
      matches.push({ p1Id: p1.id, p1Name: p1.name, p2Id: null, p2Name: null, winnerId: p1.id, winnerName: p1.name, isBye: true });
    } else if (!p1 && p2) {
      matches.push({ p1Id: p2.id, p1Name: p2.name, p2Id: null, p2Name: null, winnerId: p2.id, winnerName: p2.name, isBye: true });
    } else if (p1 && p2) {
      matches.push({ p1Id: p1.id, p1Name: p1.name, p2Id: p2.id, p2Name: p2.name, winnerId: null, winnerName: null, isBye: false });
    }
    // both null (shouldn't happen given nextPowerOfTwo sizing) -> skip
  }
  return matches;
}

// Pairs up the winners of the previous round, in order, for the next round.
function buildNextRound(previousRoundMatches) {
  const winners = previousRoundMatches.map((m) => ({ id: m.winnerId, name: m.winnerName }));
  const matches = [];
  for (let i = 0; i < winners.length; i += 2) {
    const w1 = winners[i];
    const w2 = winners[i + 1];
    if (w1 && !w2) {
      matches.push({ p1Id: w1.id, p1Name: w1.name, p2Id: null, p2Name: null, winnerId: w1.id, winnerName: w1.name, isBye: true });
    } else {
      matches.push({ p1Id: w1.id, p1Name: w1.name, p2Id: w2.id, p2Name: w2.name, winnerId: null, winnerName: null, isBye: false });
    }
  }
  return matches;
}

module.exports = { nextPowerOfTwo, seedOrder, buildFirstRound, buildNextRound };
