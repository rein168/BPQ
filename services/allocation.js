// Pure court-allocation logic (no database), so it can be unit-tested.
//
// Input players must already be sorted by fairness: fewest games played
// first, then earliest arrival. The player at the head of that order has
// waited longest and always gets the next free court.

const SKILL_RANK = { Beginner: 1, Intermediate: 2, Advanced: 3 };

/**
 * Split players into two teams of similar strength with a snake draft on
 * skill: strongest to A, next two to B, next two to A... For doubles this is
 * 1st+4th vs 2nd+3rd. Ties keep fairness order (Array.prototype.sort is stable).
 */
function balanceTeams(players) {
  const ranked = [...players].sort(
    (a, b) => (SKILL_RANK[b.skill_level] || 0) - (SKILL_RANK[a.skill_level] || 0)
  );
  const teamA = [];
  const teamB = [];
  ranked.forEach((p, i) => {
    // Pattern A, B, B, A, A, B, B, A...
    const toA = i % 4 === 0 || i % 4 === 3;
    (toA ? teamA : teamB).push(p);
  });
  return { teamA, teamB };
}

/**
 * Plan which players go on which of the free courts.
 *
 * @param {object[]} waitingPlayers eligible players, fairness-sorted
 * @param {number} freeCourtCount   courts available to fill
 * @param {object} opts
 * @param {'grouped'|'open_mix'} opts.mixMode
 * @param {number} opts.playersPerCourt
 * @returns {{players: object[], teamA: object[], teamB: object[], type: string}[]}
 */
function planAssignments(waitingPlayers, freeCourtCount, { mixMode = 'grouped', playersPerCourt = 4 } = {}) {
  const pool = [...waitingPlayers];
  const games = [];

  const take = (picked, type) => {
    for (const p of picked) pool.splice(pool.indexOf(p), 1);
    games.push({ players: picked, ...balanceTeams(picked), type });
  };

  while (games.length < freeCourtCount && pool.length >= playersPerCourt) {
    const head = pool[0];

    if (mixMode === 'open_mix') {
      take(pool.slice(0, playersPerCourt), 'mixed');
      continue;
    }

    // Grouped: the longest-waiting player's level decides the game type.
    // Players who chose "mix me in" always go to a mixed game.
    const sameLevel = (p) => p.mix_preference !== 'mix_me_in' && p.skill_level === head.skill_level;
    if (head.mix_preference !== 'mix_me_in') {
      const group = pool.filter(sameLevel);
      if (group.length >= playersPerCourt) {
        take(group.slice(0, playersPerCourt), head.skill_level.toLowerCase());
        continue;
      }
    }

    // Mixed game around the head. Prefer players who opted into mixing or
    // whose level can't fill a court on its own, so we don't break up a group
    // that could play together; fill any remaining spots in fairness order.
    const levelCounts = {};
    for (const p of pool) {
      if (p.mix_preference !== 'mix_me_in') levelCounts[p.skill_level] = (levelCounts[p.skill_level] || 0) + 1;
    }
    const mixable = (p) => p.mix_preference === 'mix_me_in' || levelCounts[p.skill_level] < playersPerCourt;
    const rest = pool.slice(1);
    const preferred = rest.filter(mixable);
    const others = rest.filter((p) => !mixable(p));
    take([head, ...preferred, ...others].slice(0, playersPerCourt), 'mixed');
  }

  return games;
}

/**
 * Sort players for the queue: fewest games first, then earliest arrival.
 * @param {object[]} players
 * @param {Object<number, number>} gamesPlayed player id -> completed games
 */
function sortByFairness(players, gamesPlayed) {
  return [...players].sort((a, b) => {
    const gamesA = gamesPlayed[a.id] || 0;
    const gamesB = gamesPlayed[b.id] || 0;
    if (gamesA !== gamesB) return gamesA - gamesB;
    return (a.arrived_at || a.created_at) - (b.arrived_at || b.created_at);
  });
}

/**
 * Lowest "Court N" name not already used, so removing Court 2 of 3 and
 * adding one gives "Court 2" again instead of a second "Court 3".
 */
function nextCourtName(existingNames) {
  const taken = new Set(existingNames);
  let n = 1;
  while (taken.has('Court ' + n)) n++;
  return 'Court ' + n;
}

module.exports = { planAssignments, balanceTeams, sortByFairness, nextCourtName, SKILL_RANK };
