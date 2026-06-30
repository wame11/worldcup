import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import { getDatabase, ref, get } from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const APP_NAME = "leaderboard-scoring-v2";
const app = getApps().some((item) => item.name === APP_NAME)
  ? getApp(APP_NAME)
  : initializeApp(firebaseConfig, APP_NAME);
const db = getDatabase(app);

const SESSION_KEY = "fwc26-login";

const GROUP_OUTCOME_POINTS = 6;
const GROUP_ONE_SCORE_POINTS = 7;
const GROUP_EXACT_BONUS_POINTS = 14;
const KO_WIN_POINTS = 15;
const KO_EXACT_POINTS = 20;

const KO_MATCHES = [
  { id: "r32-1",  home: { team: "RSA" }, away: { team: "CAN" } },
  { id: "r32-2",  home: { team: "GER" }, away: { team: "PAR" } },
  { id: "r32-3",  home: { team: "BRA" }, away: { team: "JPN" } },
  { id: "r32-4",  home: { team: "CIV" }, away: { team: "NOR" } },
  { id: "r32-5",  home: { team: "NED" }, away: { team: "MAR" } },
  { id: "r32-6",  home: { team: "FRA" }, away: { team: "SWE" } },
  { id: "r32-7",  home: { team: "MEX" }, away: { team: "ECU" } },
  { id: "r32-8",  home: { team: "ENG" }, away: { team: "COD" } },
  { id: "r32-9",  home: { team: "POR" }, away: { team: "CRO" } },
  { id: "r32-10", home: { team: "ESP" }, away: { team: "AUT" } },
  { id: "r32-11", home: { team: "USA" }, away: { team: "BIH" } },
  { id: "r32-12", home: { team: "BEL" }, away: { team: "SEN" } },
  { id: "r32-13", home: { team: "COL" }, away: { team: "GHA" } },
  { id: "r32-14", home: { team: "AUS" }, away: { team: "EGY" } },
  { id: "r32-15", home: { team: "SUI" }, away: { team: "ALG" } },
  { id: "r32-16", home: { team: "ARG" }, away: { team: "CPV" } },
  { id: "r16-1", home: { win: "r32-2"  }, away: { win: "r32-6"  } },
  { id: "r16-2", home: { win: "r32-1"  }, away: { win: "r32-5"  } },
  { id: "r16-3", home: { win: "r32-3"  }, away: { win: "r32-4"  } },
  { id: "r16-4", home: { win: "r32-7"  }, away: { win: "r32-8"  } },
  { id: "r16-5", home: { win: "r32-9"  }, away: { win: "r32-10" } },
  { id: "r16-6", home: { win: "r32-11" }, away: { win: "r32-12" } },
  { id: "r16-7", home: { win: "r32-16" }, away: { win: "r32-14" } },
  { id: "r16-8", home: { win: "r32-13" }, away: { win: "r32-15" } },
  { id: "qf-1", home: { win: "r16-1" }, away: { win: "r16-2" } },
  { id: "qf-2", home: { win: "r16-5" }, away: { win: "r16-6" } },
  { id: "qf-3", home: { win: "r16-3" }, away: { win: "r16-4" } },
  { id: "qf-4", home: { win: "r16-7" }, away: { win: "r16-8" } },
  { id: "sf-1", home: { win: "qf-1" }, away: { win: "qf-2" } },
  { id: "sf-2", home: { win: "qf-3" }, away: { win: "qf-4" } },
  { id: "third", home: { lose: "sf-1" }, away: { lose: "sf-2" } },
  { id: "final", home: { win: "sf-1" }, away: { win: "sf-2" } },
];

const KO_BY_ID = Object.fromEntries(KO_MATCHES.map((match) => [match.id, match]));

let cachedLeaderboard = null;
let cachedAt = 0;
let refreshTimer = null;
let rendering = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function readSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function toScoreNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function inferWinnerFromScores(homeScore, awayScore) {
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return "HOME";
  if (homeScore < awayScore) return "AWAY";
  return "DRAW";
}

function koDecideWinner(pred, home, away) {
  if (!home || !away) return null;
  const homeScore = toScoreNumber(pred && pred.h);
  const awayScore = toScoreNumber(pred && pred.a);
  if (homeScore === null || awayScore === null) return null;
  if (homeScore > awayScore) return home;
  if (awayScore > homeScore) return away;
  if (pred.pen === "home") return home;
  if (pred.pen === "away") return away;
  return null;
}

function koResolveAll(ko = {}) {
  const cache = {};

  function resolveSide(sideRef) {
    if (sideRef.team) return sideRef.team;
    const source = resolveMatch(sideRef.win || sideRef.lose);
    return sideRef.win ? source.winner : source.loser;
  }

  function resolveMatch(id) {
    if (cache[id]) return cache[id];
    cache[id] = { home: null, away: null, winner: null, loser: null };
    const match = KO_BY_ID[id];
    const home = resolveSide(match.home);
    const away = resolveSide(match.away);
    const winner = koDecideWinner(ko[id], home, away);
    const loser = winner ? (winner === home ? away : home) : null;
    cache[id] = { home, away, winner, loser };
    return cache[id];
  }

  KO_MATCHES.forEach((match) => resolveMatch(match.id));
  return cache;
}

function scoreKnockout(playerKo, resultsKo) {
  let total = 0;
  let correct = 0;
  const player = koResolveAll(playerKo || {});
  const real = koResolveAll(resultsKo || {});

  for (const match of KO_MATCHES) {
    const realMatch = real[match.id];
    const realPred = (resultsKo || {})[match.id] || {};
    const realHome = toScoreNumber(realPred.h);
    const realAway = toScoreNumber(realPred.a);
    if (!realMatch.winner || realHome === null || realAway === null) continue;

    const playerMatch = player[match.id];
    const playerPred = (playerKo || {})[match.id] || {};
    const playerHome = toScoreNumber(playerPred.h);
    const playerAway = toScoreNumber(playerPred.a);

    if (playerMatch.winner && playerMatch.winner === realMatch.winner) {
      total += KO_WIN_POINTS;
      correct += 1;
    }

    if (playerMatch.home && playerMatch.away && playerHome !== null && playerAway !== null) {
      const sameMatch =
        (playerMatch.home === realMatch.home && playerMatch.away === realMatch.away) ||
        (playerMatch.home === realMatch.away && playerMatch.away === realMatch.home);

      if (sameMatch) {
        const playerGoals = { [playerMatch.home]: playerHome, [playerMatch.away]: playerAway };
        const realGoals = { [realMatch.home]: realHome, [realMatch.away]: realAway };
        if (
          playerGoals[realMatch.home] === realGoals[realMatch.home] &&
          playerGoals[realMatch.away] === realGoals[realMatch.away]
        ) {
          total += KO_EXACT_POINTS;
          correct += 1;
        }
      }
    }
  }

  return { total, correct };
}

function scoreOnePerson(player, results) {
  let total = 0;
  let correct = 0;
  const groupPredictions = player.groups || {};
  const groupResults = results.groups || {};

  for (const [id, pred] of Object.entries(groupPredictions)) {
    const result = groupResults[id];
    if (!result || !pred) continue;

    const predHome = toScoreNumber(pred.scoreHome);
    const predAway = toScoreNumber(pred.scoreAway);
    const realHome = toScoreNumber(result.scoreHome);
    const realAway = toScoreNumber(result.scoreAway);
    const hasPredictedScore = predHome !== null && predAway !== null;
    const hasRealScore = realHome !== null && realAway !== null;
    const predictedWinner = pred.winner || inferWinnerFromScores(predHome, predAway);
    const realWinner = result.winner || inferWinnerFromScores(realHome, realAway);

    if (!realWinner && !hasRealScore) continue;

    const exactScore = hasPredictedScore && hasRealScore && predHome === realHome && predAway === realAway;
    const oneTeamScoreCorrect =
      hasPredictedScore &&
      hasRealScore &&
      !exactScore &&
      (predHome === realHome || predAway === realAway);
    const correctOutcome = exactScore || (predictedWinner && realWinner && predictedWinner === realWinner);

    if (correctOutcome) {
      total += GROUP_OUTCOME_POINTS;
      correct += 1;
    }

    if (exactScore) {
      total += GROUP_EXACT_BONUS_POINTS;
      correct += 1;
    } else if (oneTeamScoreCorrect) {
      total += GROUP_ONE_SCORE_POINTS;
      correct += 1;
    }
  }

  const knockout = scoreKnockout(player.ko, results.ko);
  return { total: total + knockout.total, correct: correct + knockout.correct };
}

async function fetchAllPredictions() {
  const snap = await get(ref(db, "predictions"));
  const predictions = [];
  snap.forEach((child) => predictions.push({ code: child.key, ...child.val() }));
  return predictions;
}

async function fetchPrediction(code) {
  if (!code) return null;
  const snap = await get(ref(db, `predictions/${code}`));
  return snap.exists() ? { code, ...snap.val() } : null;
}

async function fetchResults() {
  const snap = await get(ref(db, "results/global"));
  return snap.exists() ? snap.val() : { groups: {}, ko: {} };
}

async function computeLeaderboard() {
  if (cachedLeaderboard && Date.now() - cachedAt < 1500) return cachedLeaderboard;
  const [predictions, results] = await Promise.all([fetchAllPredictions(), fetchResults()]);
  const rows = predictions
    .filter((player) => player.code !== "TEST")
    .map((player) => ({
      code: player.code,
      name: player.name || "-",
      ...scoreOnePerson(player, results),
    }))
    .sort((a, b) => b.total - a.total || b.correct - a.correct);

  cachedLeaderboard = { rows, results };
  cachedAt = Date.now();
  return cachedLeaderboard;
}

function rowHtml(row, rank, isMe) {
  return `
    <div class="leaderboard-row ${isMe ? "leaderboard-row--me" : ""}">
      <div class="lb-rank ${rank === 1 ? "lb-rank--1" : ""}">${rank}</div>
      <div class="lb-name">${escapeHtml(row.name)}</div>
      <div class="lb-correct">${row.correct}</div>
      <div class="lb-pts">${row.total}</div>
    </div>`;
}

async function renderLeaderboard(root) {
  if (!root || rendering) return;
  if (root.id === "admin-leaderboard" && document.querySelector("#admin-tools")?.classList.contains("hidden")) return;
  if (root.id === "leaderboard-container") {
    const text = root.textContent.trim();
    if (!text || text.includes("Locked")) return;
  }

  rendering = true;
  try {
    const { rows } = await computeLeaderboard();
    const saved = readSession();
    const signature = rows.map((row) => `${row.code}:${row.correct}:${row.total}`).join("|");
    const alreadyPatched = root.querySelector("[data-ko-scoring-patch='true']");
    if (alreadyPatched && root.dataset.koScoringSignature === signature) return;

    let body = rows
      .map((row, index) => rowHtml(row, index + 1, row.code === saved.code))
      .join("");

    if (!body) {
      body = `
        <div class="leaderboard-row">
          <div></div>
          <div style="opacity:.6">No predictions yet.</div>
          <div></div>
          <div></div>
        </div>`;
    }

    const table = `
      <div class="leaderboard-row leaderboard-row--head" data-ko-scoring-patch="true">
        <div class="lb-rank">#</div>
        <div>Player</div>
        <div class="lb-correct">Correct</div>
        <div class="lb-pts">Points</div>
      </div>
      ${body}`;

    root.dataset.koScoringSignature = signature;
    root.innerHTML = root.id === "admin-leaderboard"
      ? `<div class="leaderboard" data-ko-scoring-patch="true">${table}</div>`
      : table;
  } catch (error) {
    console.error("Could not refresh leaderboard scoring.", error);
  } finally {
    rendering = false;
  }
}

async function updateUserScoreDisplay() {
  const display = document.querySelector("#user-score-display");
  const saved = readSession();
  if (!display || !saved.code || saved.code === "TEST") return;

  try {
    const [player, results] = await Promise.all([fetchPrediction(saved.code), fetchResults()]);
    if (!player) return;
    const score = scoreOnePerson(player, results);
    display.textContent = `${score.total} pts`;
  } catch (error) {
    console.error("Could not refresh user score.", error);
  }
}

function patchScoringLabels() {
  document.querySelectorAll(".scoring-key span").forEach((span) => {
    if (span.textContent.includes("Correct winner")) {
      span.innerHTML = `<i class="dot-orange"></i>Correct winner <strong>+15</strong>`;
    }
    if (span.textContent.includes("Exact score")) {
      span.innerHTML = `<i class="dot-blue"></i>Exact score <strong>+20 bonus</strong> (35 max per match)`;
    }
  });
}

function scheduleRefresh(delay = 250) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    cachedLeaderboard = null;
    refreshVisible();
  }, delay);
}

function refreshVisible() {
  patchScoringLabels();
  renderLeaderboard(document.querySelector("#admin-leaderboard"));
  renderLeaderboard(document.querySelector("#leaderboard-container"));
  updateUserScoreDisplay();
}

function watch(id) {
  const node = document.getElementById(id);
  if (!node) return;
  new MutationObserver(() => scheduleRefresh()).observe(node, { childList: true, subtree: true });
}

function init() {
  ["admin-leaderboard", "leaderboard-container", "tab-bracket"].forEach(watch);
  document.querySelectorAll("[data-tab='leaderboard'], [data-admin-tab='leaderboard'], [data-tab='bracket']").forEach((button) => {
    button.addEventListener("click", () => scheduleRefresh(500));
  });
  scheduleRefresh(1200);
  window.addEventListener("focus", () => scheduleRefresh(200));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
