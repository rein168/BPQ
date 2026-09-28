const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planAssignments, balanceTeams, sortByFairness, nextCourtName } = require('../services/allocation');

// Build fairness-ordered players: p('A', 'Advanced') etc.
let nextId = 1;
function p(name, skill_level, mix_preference = 'same_level') {
  return { id: nextId++, name, skill_level, mix_preference };
}
const names = (players) => players.map((x) => x.name).sort();

test('grouped: longest-waiting beginners get the court before advanced', () => {
  const queue = [
    p('B1', 'Beginner'), p('B2', 'Beginner'), p('B3', 'Beginner'), p('B4', 'Beginner'),
    p('A1', 'Advanced'), p('A2', 'Advanced'), p('A3', 'Advanced'), p('A4', 'Advanced'),
  ];
  const games = planAssignments(queue, 1);
  assert.equal(games.length, 1);
  assert.equal(games[0].type, 'beginner');
  assert.deepEqual(names(games[0].players), ['B1', 'B2', 'B3', 'B4']);
});

test('grouped: fills each court from the level of whoever waited longest', () => {
  const queue = [
    p('I1', 'Intermediate'), p('A1', 'Advanced'), p('I2', 'Intermediate'), p('A2', 'Advanced'),
    p('I3', 'Intermediate'), p('A3', 'Advanced'), p('I4', 'Intermediate'), p('A4', 'Advanced'),
  ];
  const games = planAssignments(queue, 2);
  assert.deepEqual(games.map((g) => g.type), ['intermediate', 'advanced']);
});

test('grouped: head whose level cannot fill a court gets a mixed game', () => {
  const queue = [
    p('B1', 'Beginner'), p('A1', 'Advanced'), p('A2', 'Advanced'), p('A3', 'Advanced'),
    p('A4', 'Advanced'), p('I1', 'Intermediate'), p('I2', 'Intermediate'),
  ];
  const games = planAssignments(queue, 1);
  assert.equal(games[0].type, 'mixed');
  assert.ok(games[0].players.some((x) => x.name === 'B1'), 'longest-waiting player plays');
  // Don't break up the four advanced who can play together: use the intermediates
  assert.deepEqual(names(games[0].players), ['A1', 'B1', 'I1', 'I2']);
});

test('grouped: "mix me in" head goes to a mixed game', () => {
  const queue = [
    p('I1', 'Intermediate', 'mix_me_in'), p('I2', 'Intermediate'), p('I3', 'Intermediate'),
    p('I4', 'Intermediate'), p('I5', 'Intermediate'), p('B1', 'Beginner'),
  ];
  const games = planAssignments(queue, 1);
  assert.equal(games[0].type, 'mixed');
  assert.ok(games[0].players.some((x) => x.name === 'I1'));
});

test('stops when fewer than four players are left', () => {
  const queue = [p('A', 'Beginner'), p('B', 'Beginner'), p('C', 'Beginner')];
  assert.deepEqual(planAssignments(queue, 2), []);
});

test('never assigns more games than free courts', () => {
  const queue = Array.from({ length: 12 }, (_, i) => p('X' + i, 'Intermediate'));
  assert.equal(planAssignments(queue, 2).length, 2);
});

test('no player is placed twice', () => {
  const skills = ['Beginner', 'Intermediate', 'Advanced'];
  const queue = Array.from({ length: 13 }, (_, i) => p('Y' + i, skills[i % 3], i % 4 === 0 ? 'mix_me_in' : 'same_level'));
  const games = planAssignments(queue, 3);
  const ids = games.flatMap((g) => g.players.map((x) => x.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(games.length, 3);
});

test('open mix: first four in fairness order regardless of level', () => {
  const queue = [p('A1', 'Advanced'), p('B1', 'Beginner'), p('I1', 'Intermediate'), p('B2', 'Beginner'), p('A2', 'Advanced')];
  const games = planAssignments(queue, 1, { mixMode: 'open_mix' });
  assert.deepEqual(names(games[0].players), ['A1', 'B1', 'B2', 'I1']);
});

test('balanceTeams: strongest and weakest pair up against the middle two', () => {
  const four = [p('A', 'Advanced'), p('A2', 'Advanced'), p('B', 'Beginner'), p('B2', 'Beginner')];
  const { teamA, teamB } = balanceTeams(four);
  assert.deepEqual(names(teamA), ['A', 'B2']);
  assert.deepEqual(names(teamB), ['A2', 'B']);
});

test('balanceTeams: singles puts one player on each side', () => {
  const { teamA, teamB } = balanceTeams([p('S1', 'Beginner'), p('S2', 'Advanced')]);
  assert.equal(teamA.length, 1);
  assert.equal(teamB.length, 1);
  assert.equal(teamA[0].name, 'S2');
});

test('singles: two players per court', () => {
  const queue = [p('S1', 'Beginner'), p('S2', 'Beginner'), p('S3', 'Beginner')];
  const games = planAssignments(queue, 2, { playersPerCourt: 2 });
  assert.equal(games.length, 1);
  assert.equal(games[0].players.length, 2);
});

test('sortByFairness: fewest games first, then earliest arrival', () => {
  const a = { id: 1, arrived_at: 300 };
  const b = { id: 2, arrived_at: 100 };
  const c = { id: 3, arrived_at: 200 };
  const sorted = sortByFairness([a, b, c], { 1: 0, 2: 1, 3: 0 });
  assert.deepEqual(sorted.map((x) => x.id), [3, 1, 2]);
});

test('nextCourtName: reuses the lowest free number', () => {
  assert.equal(nextCourtName(['Court 1', 'Court 3']), 'Court 2');
  assert.equal(nextCourtName(['Court 1', 'Court 2']), 'Court 3');
  assert.equal(nextCourtName([]), 'Court 1');
});
