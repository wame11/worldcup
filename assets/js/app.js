// =================================================================
// FWC 26 PREDICTIONS POOL — main app
// =================================================================

import {
  initializeApp,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-app.js";
import {
  getDatabase, ref, get, set, update, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.0/firebase-database.js";

import { firebaseConfig, ADMIN_PASSWORD, CONTACT_EMAIL } from "./firebase-config.js";
import { TEAMS, GROUPS, GROUP_MATCHES, KNOCKOUT_MATCHES, SCORING } from "./data.js";

// -----------------------------------------------------------------
// Firebase init
// -----------------------------------------------------------------
const fbApp = initializeApp(firebaseConfig);
const db    = getDatabase(fbApp);

// -----------------------------------------------------------------
// Session state
// -----------------------------------------------------------------
const session = {
  code:     null,    // their access code (or "TEST")
  name:     null,    // their display name
  isTest:   false,
  predictions: null, // their predictions doc
};
const SESSION_KEY = "fwc26-login";
const PREDICTION_LOCK_MS = 60 * 60 * 1000;
const UK_SUMMER_OFFSET_MINUTES = 60; // World Cup 2026 runs while the UK is on BST.

const TEAM_CODES = Object.keys(TEAMS);
const BRACKET_ROUNDS = [
  { id: "r32",      label: "Round of 32",   pickCount: 32, scoreKey: "r32Team",   per: SCORING.r32Team   },
  { id: "r16",      label: "Round of 16",   pickCount: 16, scoreKey: "r16Team",   per: SCORING.r16Team   },
  { id: "qf",       label: "Quarter-finals", pickCount: 8,  scoreKey: "qfTeam",    per: SCORING.qfTeam    },
  { id: "sf",       label: "Semi-finals",   pickCount: 4,  scoreKey: "sfTeam",    per: SCORING.sfTeam    },
  { id: "finalists",label: "Finalists",     pickCount: 2,  scoreKey: "finalTeam", per: SCORING.finalTeam },
];
const PLAYER_BRACKET_ROUNDS = BRACKET_ROUNDS.filter((round) => round.id !== "r32");

// -----------------------------------------------------------------
// Tiny helpers
// -----------------------------------------------------------------
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function show(viewId) {
  ["view-login", "view-predictions", "view-admin"].forEach((id) => {
    $("#" + id).classList.toggle("hidden", id !== viewId);
  });
  window.scrollTo(0, 0);
}

function flagUrl(iso, size = "w40") {
  // gb-eng / gb-sct have their own pages on flagcdn
  return `https://flagcdn.com/${size}/${iso}.png`;
}

function teamChip(code, opts = {}) {
  const t = TEAMS[code];
  if (!t) return code;
  const cls = opts.class || "";
  return `
    <span class="match-row__team match-row__team--${opts.side || "home"} ${cls}">
      <img class="team-flag" src="${flagUrl(t.iso)}" alt="${t.name}" loading="lazy" />
      <span class="team-code">${code}</span>
    </span>`;
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function ukKickoffTimestamp(match) {
  const [year, month, day] = match.date.split("-").map(Number);
  const [hour, minute] = match.time.split(":").map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - (UK_SUMMER_OFFSET_MINUTES * 60 * 1000);
}

function kickoffDateTime(match) {
  return new Date(ukKickoffTimestamp(match));
}

function predictionLockTimestamp(match) {
  return ukKickoffTimestamp(match) - PREDICTION_LOCK_MS;
}

function isMatchLocked(match) {
  return Date.now() >= predictionLockTimestamp(match);
}

function firstKickoff(matches) {
  return matches
    .map(kickoffDateTime)
    .sort((a, b) => a - b)[0];
}

function isBracketPredictionLocked() {
  const firstR32 = firstKickoff(KNOCKOUT_MATCHES.filter((m) => m.round === "R32"));
  return firstR32 && Date.now() >= (firstR32.getTime() - PREDICTION_LOCK_MS);
}

// Debounced save helper
function debounce(fn, ms = 600) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object") return Object.values(value).filter(Boolean);
  return [];
}

function confirmedKnockoutTeams(results) {
  const selected = new Set(asList(results.bracket?.r32));
  return TEAM_CODES.filter((code) => selected.has(code));
}

function groupMatchById(id) {
  return GROUP_MATCHES.find((m) => m.id === Number(id));
}

function hasSavedLogin() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return Boolean(saved?.code);
  } catch {
    forgetLogin();
    return false;
  }
}

function showLoadingMessage(text = "Loading") {
  const loading = $("#loading");
  if (!loading) return;

  if (!$("#loading-spinner-style")) {
    const style = document.createElement("style");
    style.id = "loading-spinner-style";
    style.textContent = `
      .loading-spinner {
        width: 42px;
        height: 42px;
        border: 3px solid rgba(244,237,224,0.22);
        border-top-color: var(--orange);
        border-radius: 50%;
        animation: loading-spin .8s linear infinite;
      }
      .loading-text {
        font-family: var(--font-mono);
        font-size: 12px;
        letter-spacing: .22em;
        text-transform: uppercase;
      }
      @keyframes loading-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }

  loading.classList.remove("is-fading");
  loading.innerHTML = `
    <div class="loading-spinner" aria-hidden="true"></div>
    <div class="loading-text">${escapeHtml(text)}</div>`;
}

function hideLoading() {
  const loading = $("#loading");
  if (!loading) return;
  loading.classList.add("is-fading");
  setTimeout(() => loading.remove(), 400);
}

function rememberLogin() {
  if (!session.code || !session.name || session.isTest) return;
  localStorage.setItem(SESSION_KEY, JSON.stringify({ code: session.code, name: session.name }));
}

function forgetLogin() {
  localStorage.removeItem(SESSION_KEY);
}

async function restoreLogin() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    forgetLogin();
    return false;
  }
  if (!saved?.code) return false;

  const codeDoc = await fetchCodeDoc(saved.code);
  if (!codeDoc) {
    forgetLogin();
    return false;
  }

  session.code = saved.code;
  session.name = codeDoc.name || saved.name || "Player";
  session.isTest = false;
  session.predictions = (await fetchPredictions(saved.code)) || { groups: {}, bracket: {} };
  await launchApp();
  return true;
}

// -----------------------------------------------------------------
// Realtime Database data layer
// -----------------------------------------------------------------
async function fetchCodeDoc(code) {
  const snap = await get(ref(db, `codes/${code}`));
  return snap.exists() ? snap.val() : null;
}

async function claimCode(code, name) {
  await update(ref(db, `codes/${code}`), { claimed: true, name, claimedAt: serverTimestamp() });
}

async function fetchPredictions(code) {
  const snap = await get(ref(db, `predictions/${code}`));
  return snap.exists() ? snap.val() : null;
}

async function savePredictions(code, payload) {
  await update(ref(db, `predictions/${code}`), { ...payload, updatedAt: serverTimestamp() });
}

async function fetchResults() {
  const snap = await get(ref(db, "results/global"));
  return snap.exists() ? snap.val() : { groups: {}, bracket: {}, champion: null, third: null };
}

async function saveResults(payload) {
  await update(ref(db, "results/global"), { ...payload, updatedAt: serverTimestamp() });
}

async function fetchAllPredictions() {
  const snap = await get(ref(db, "predictions"));
  const out = [];
  snap.forEach((d) => {
    out.push({ code: d.key, ...d.val() });
  });
  return out;
}

async function fetchAllCodes() {
  const snap = await get(ref(db, "codes"));
  const out = [];
  snap.forEach((d) => {
    out.push({ code: d.key, ...d.val() });
  });
  return out;
}

// -----------------------------------------------------------------
// LOGIN FLOW
// -----------------------------------------------------------------
function showLoginError(msg) {
  const el = $("#login-error");
  el.textContent = msg;
  el.hidden = false;
}
function clearLoginError() { $("#login-error").hidden = true; }

function prepareLoginForm() {
  const nameInput = $("#login-name");
  if (nameInput) {
    nameInput.required = false;
    nameInput.removeAttribute("required");
    nameInput.placeholder = "First time only";
  }

  const notes = $$(".login-card .login-sub");
  if (notes[0]) notes[0].textContent = "Enter your access code to open your predictions. Add your name only the first time you use a new code.";
  if (notes[1]) notes[1].textContent = "Already used your code? You can leave the name box blank.";
}

async function attemptLogin(rawCode, rawName) {
  clearLoginError();
  const code = rawCode.trim().toUpperCase();
  const name = rawName.trim();
  if (!code) { showLoginError("Please enter your access code."); return; }

  // Secret test login
  if (code === "TEST") {
    session.code   = "TEST";
    session.name   = name || "Test player";
    session.isTest = true;
    // Initialise / ensure an in-memory predictions object for the tester
    session.predictions = (await fetchPredictions("TEST")) || { groups: {}, bracket: {} };
    await launchApp();
    return;
  }

  // Verify the code exists in the database
  let codeDoc;
  try {
    codeDoc = await fetchCodeDoc(code);
  } catch (e) {
    showLoginError("Couldn't reach the server. Check your connection and try again.");
    console.error(e);
    return;
  }
  if (!codeDoc) {
    showLoginError("That code doesn't look right. Double-check the letters / numbers.");
    return;
  }

  // Claim if first time
  if (!codeDoc.claimed) {
    if (!name) {
      showLoginError("Please enter your name the first time you use a new code.");
      return;
    }
    try { await claimCode(code, name); }
    catch (e) { showLoginError("Couldn't claim that code. Try again."); console.error(e); return; }
  }

  session.code   = code;
  session.name   = codeDoc.claimed ? (codeDoc.name || name || "Player") : name;
  session.isTest = false;
  session.predictions = (await fetchPredictions(code)) || { groups: {}, bracket: {} };
  rememberLogin();
  await launchApp();
}

async function launchApp() {
  $("#user-name-display").textContent = session.name + (session.isTest ? " ★" : "");
  show("view-predictions");
  renderGroupsTab();
  await renderBracketTab();
  renderLeaderboardTab();
  updateUserScoreDisplay();
}

// -----------------------------------------------------------------
// GROUP STAGE PREDICTIONS
// -----------------------------------------------------------------
function renderGroupsTab() {
  const root = $("#groups-container");
  const groupKeys = Object.keys(GROUPS);
  root.innerHTML = groupKeys.map((g) => {
    const matches = GROUP_MATCHES.filter((m) => m.group === g);
    return `
      <div class="group-card">
        <div class="group-card__header">
          <div class="group-card__title">Group ${g}</div>
          <div class="group-card__teams">${GROUPS[g].join(" · ")}</div>
        </div>
        <div class="group-card__matches">
          ${matches.map(renderMatchRow).join("")}
        </div>
      </div>`;
  }).join("");

  // Wire up inputs
  $$(".match-row", root).forEach(wireMatchRow);

  updateGroupsProgress();
}

function renderMatchRow(m) {
  const pred = (session.predictions.groups || {})[m.id] || {};
  const winner = pred.winner; // "HOME" | "DRAW" | "AWAY"
  const sh = pred.scoreHome ?? "";
  const sa = pred.scoreAway ?? "";
  const locked = isMatchLocked(m);
  const disabled = locked ? "disabled" : "";
  const lockedLabel = locked ? " · Locked" : "";

  const outcomeBtn = (val, label) => `
    <button type="button" class="outcome-btn ${winner === val ? "is-selected" : ""}" data-pick="${val.toLowerCase()}" ${disabled}>${label}</button>`;

  return `
    <div class="match-row" data-match-id="${m.id}" data-locked="${locked}">
      <div class="match-row__num">${String(m.id).padStart(2, "0")}</div>
      <div class="match-row__date">${formatDate(m.date)} · ${m.time} UK${lockedLabel}</div>
      ${teamChip(m.home, { side: "home" })}
      <div class="match-row__pick">
        <input class="score-input" data-side="home" type="number" min="0" max="20" value="${sh}" inputmode="numeric" aria-label="${m.home} score" ${disabled} />
        <span class="score-dash">—</span>
        <input class="score-input" data-side="away" type="number" min="0" max="20" value="${sa}" inputmode="numeric" aria-label="${m.away} score" ${disabled} />
      </div>
      ${teamChip(m.away, { side: "away" })}
      <div class="match-row__outcome">
        ${outcomeBtn("HOME", m.home + " win")}
        ${outcomeBtn("DRAW", "Draw")}
        ${outcomeBtn("AWAY", m.away + " win")}
      </div>
    </div>`;
}

function wireMatchRow(row) {
  if (row.dataset.locked === "true") return;
  const id = Number(row.dataset.matchId);
  const match = groupMatchById(id);
  const debouncedSave = debounce(() => persistGroupPrediction(id), 400);

  $$(".outcome-btn", row).forEach((btn) => {
    btn.addEventListener("click", () => {
      if (match && isMatchLocked(match)) {
        $("#groups-save-status").textContent = "Locked 1 hour before UK kick-off";
        renderGroupsTab();
        return;
      }
      $$(".outcome-btn", row).forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      // Sync into session
      session.predictions.groups = session.predictions.groups || {};
      const pick = btn.dataset.pick.toUpperCase();
      session.predictions.groups[id] = { ...(session.predictions.groups[id] || {}), winner: pick };
      debouncedSave();
      updateGroupsProgress();
    });
  });

  $$(".score-input", row).forEach((input) => {
    input.addEventListener("input", () => {
      if (match && isMatchLocked(match)) {
        $("#groups-save-status").textContent = "Locked 1 hour before UK kick-off";
        renderGroupsTab();
        return;
      }
      const side  = input.dataset.side === "home" ? "scoreHome" : "scoreAway";
      const value = input.value === "" ? null : Math.max(0, Math.min(20, parseInt(input.value, 10) || 0));
      session.predictions.groups = session.predictions.groups || {};
      session.predictions.groups[id] = { ...(session.predictions.groups[id] || {}), [side]: value };

      // Auto-infer outcome from score if both filled
      const p = session.predictions.groups[id];
      if (typeof p.scoreHome === "number" && typeof p.scoreAway === "number") {
        const inferred = p.scoreHome > p.scoreAway ? "HOME"
                        : p.scoreHome < p.scoreAway ? "AWAY" : "DRAW";
        p.winner = inferred;
        $$(".outcome-btn", row).forEach((b) => b.classList.toggle("is-selected", b.dataset.pick.toUpperCase() === inferred));
      }
      debouncedSave();
      updateGroupsProgress();
    });
  });
}

async function persistGroupPrediction(id) {
  const match = groupMatchById(id);
  if (match && isMatchLocked(match)) {
    $("#groups-save-status").textContent = "Locked 1 hour before UK kick-off";
    renderGroupsTab();
    return;
  }

  setSaveStatus("groups", true);
  try {
    await savePredictions(session.code, { name: session.name, groups: session.predictions.groups });
  } catch (e) { console.error(e); }
  setSaveStatus("groups", false);
  updateUserScoreDisplay();
}

function updateGroupsProgress() {
  const total = GROUP_MATCHES.length;
  const groups = session.predictions.groups || {};
  const done = Object.values(groups).filter((p) => p.winner).length;
  $("#groups-progress").textContent = `${done} / ${total} predicted`;
}

function setSaveStatus(scope, saving) {
  const el = $(`#${scope}-save-status`);
  if (!el) return;
  el.textContent = saving ? "Saving…" : "Saved";
  el.classList.toggle("is-saving", saving);
}

// -----------------------------------------------------------------
// BRACKET PREDICTIONS
// -----------------------------------------------------------------
async function renderBracketTab() {
  const root = $("#bracket-container");
  const b = session.predictions.bracket || {};
  const results = await fetchResults();
  const knockoutTeams = confirmedKnockoutTeams(results);
  const bracketLocked = isBracketPredictionLocked();

  if (knockoutTeams.length < 32) {
    root.innerHTML = `
      <div class="bracket-section">
        <div class="bracket-section__head">
          <div class="bracket-section__title">Knockout not open yet</div>
          <div class="bracket-section__meta">${knockoutTeams.length} / 32 teams confirmed</div>
        </div>
        <p class="panel-sub" style="margin-bottom:0">
          The bracket will open after admin confirms the 32 teams that reach the knockout stage.
        </p>
      </div>`;
    $("#bracket-save-status").textContent = "Locked until admin confirms the Round of 32";
    return;
  }

  $("#bracket-save-status").textContent = bracketLocked ? "Locked 1 hour before first Round of 32 UK kick-off" : "Saved automatically";
  root.dataset.locked = bracketLocked ? "true" : "false";
  const sections = PLAYER_BRACKET_ROUNDS.map((r) => bracketSection(r, asList(b[r.id]), knockoutTeams, bracketLocked)).join("");
  const finals = bracketFinals(b, knockoutTeams, bracketLocked);
  root.innerHTML = sections + finals;
  if (!bracketLocked) wireBracket(root);
}

function bracketSection(round, picks, teamCodes = TEAM_CODES, locked = false) {
  const lockedClass = locked ? "is-locked" : "";
  const disabled = locked ? "disabled" : "";
  return `
    <div class="bracket-section" data-round="${round.id}">
      <div class="bracket-section__head">
        <div class="bracket-section__title">${round.label}</div>
        <div class="bracket-section__meta">Pick ${round.pickCount} · ${round.per} pts each</div>
      </div>
      <div class="team-picker">
        ${teamCodes.map((code) => {
          const sel = picks.includes(code) ? "is-selected" : "";
          const t = TEAMS[code];
          return `
            <button class="team-chip ${sel} ${lockedClass}" type="button" data-team="${code}" ${disabled}>
              <img class="team-flag" src="${flagUrl(t.iso)}" alt="" loading="lazy" />
              <span class="team-chip__name">${t.name}</span>
            </button>`;
        }).join("")}
      </div>
      <div class="picker-status" data-status="${round.id}">
        Picked <strong>${picks.length} / ${round.pickCount}</strong>
      </div>
    </div>`;
}

function bracketFinals(b, teamCodes = TEAM_CODES, locked = false) {
  const disabled = locked ? "disabled" : "";
  const opts = (selected) => teamCodes.map((c) =>
    `<option value="${c}" ${selected === c ? "selected" : ""}>${TEAMS[c].name} (${c})</option>`).join("");
  return `
    <div class="bracket-section">
      <div class="bracket-section__head">
        <div class="bracket-section__title">Trophy picks</div>
        <div class="bracket-section__meta">Champion +${SCORING.champion} · 3rd place +${SCORING.third}</div>
      </div>
      <div class="final-pick-row">
        <div class="final-pick">
          <div class="final-pick__label">🏆 Champion</div>
          <select id="final-champion" ${disabled}>
            <option value="">— pick —</option>${opts(b.champion)}
          </select>
        </div>
        <div class="final-pick">
          <div class="final-pick__label">🥉 3rd place (Bronze final winner)</div>
          <select id="final-third" ${disabled}>
            <option value="">— pick —</option>${opts(b.third)}
          </select>
        </div>
      </div>
    </div>`;
}

function wireBracket(root) {
  // Section pickers
  $$(".bracket-section[data-round]", root).forEach((section) => {
    const roundId = section.dataset.round;
    const round = BRACKET_ROUNDS.find((r) => r.id === roundId);
    const status = $(`[data-status="${roundId}"]`, section);

    $$(".team-chip", section).forEach((chip) => {
      chip.addEventListener("click", () => {
        if (isBracketPredictionLocked()) {
          renderBracketTab();
          return;
        }
        const team = chip.dataset.team;
        session.predictions.bracket = session.predictions.bracket || {};
        const picks = new Set(asList(session.predictions.bracket[roundId]));
        if (picks.has(team)) picks.delete(team);
        else {
          if (picks.size >= round.pickCount) return; // full
          picks.add(team);
        }
        session.predictions.bracket[roundId] = [...picks];
        chip.classList.toggle("is-selected");
        const n = picks.size;
        status.innerHTML = `Picked <strong>${n} / ${round.pickCount}</strong>`;
        status.classList.toggle("is-full", n === round.pickCount);
        bracketSaveDebounced();
      });
    });
  });

  // Champion / 3rd
  const b = session.predictions.bracket || {};
  if (b.champion) $("#final-champion").value = b.champion;
  if (b.third)    $("#final-third").value    = b.third;
  $("#final-champion").addEventListener("change", (e) => {
    if (isBracketPredictionLocked()) {
      renderBracketTab();
      return;
    }
    session.predictions.bracket = session.predictions.bracket || {};
    session.predictions.bracket.champion = e.target.value || null;
    bracketSaveDebounced();
  });
  $("#final-third").addEventListener("change", (e) => {
    if (isBracketPredictionLocked()) {
      renderBracketTab();
      return;
    }
    session.predictions.bracket = session.predictions.bracket || {};
    session.predictions.bracket.third = e.target.value || null;
    bracketSaveDebounced();
  });
}

const bracketSaveDebounced = debounce(async () => {
  if (isBracketPredictionLocked()) {
    $("#bracket-save-status").textContent = "Locked 1 hour before first Round of 32 UK kick-off";
    renderBracketTab();
    return;
  }

  setSaveStatus("bracket", true);
  try { await savePredictions(session.code, { name: session.name, bracket: session.predictions.bracket }); }
  catch (e) { console.error(e); }
  setSaveStatus("bracket", false);
  updateUserScoreDisplay();
}, 600);

// -----------------------------------------------------------------
// SCORING
// -----------------------------------------------------------------
function scoreOnePerson(p, results) {
  let total = 0, correct = 0;

  // Group stage
  const gp = p.groups || {};
  const gr = results.groups || {};
  for (const [id, pred] of Object.entries(gp)) {
    const r = gr[id];
    if (!r || !r.winner) continue;
    if (pred.winner && pred.winner === r.winner) {
      total += SCORING.groupOutcome;
      correct += 1;
      if (
        typeof pred.scoreHome === "number" && typeof pred.scoreAway === "number" &&
        typeof r.scoreHome === "number"     && typeof r.scoreAway === "number" &&
        pred.scoreHome === r.scoreHome && pred.scoreAway === r.scoreAway
      ) {
        total += SCORING.groupExactBonus;
        correct += 1;
      }
    }
  }

  // Bracket
  const bp = p.bracket || {};
  const br = results.bracket || {};
  for (const round of PLAYER_BRACKET_ROUNDS) {
    const picks   = asList(bp[round.id]);
    const actual  = asList(br[round.id]);
    if (!actual.length) continue;
    const hits = picks.filter((t) => actual.includes(t)).length;
    total   += hits * round.per;
    correct += hits;
  }

  // Trophy picks
  if (results.champion && bp.champion === results.champion) { total += SCORING.champion; correct += 1; }
  if (results.third    && bp.third    === results.third)    { total += SCORING.third;    correct += 1; }

  return { total, correct };
}

async function computeLeaderboard() {
  const [preds, results] = await Promise.all([fetchAllPredictions(), fetchResults()]);
  const rows = preds
    .filter((p) => p.code !== "TEST") // hide the test row from the standard table; we'll add it back if relevant
    .map((p) => ({ code: p.code, name: p.name || "—", ...scoreOnePerson(p, results) }));

  rows.sort((a, b) => b.total - a.total || b.correct - a.correct);
  return rows;
}

async function renderLeaderboardTab() {
  const root = $("#leaderboard-container");
  root.innerHTML = `<div class="leaderboard-row leaderboard-row--head">
    <div class="lb-rank">#</div><div>Player</div>
    <div class="lb-correct">Correct</div><div class="lb-pts">Points</div>
  </div><div class="leaderboard-row"><div></div><div>Loading…</div><div></div><div></div></div>`;

  const rows = await computeLeaderboard();
  const meRow = rows.find((r) => r.code === session.code);

  // Test user gets shown at top if they're the viewer
  let bodyHtml = "";
  if (session.isTest) {
    const topScore = rows.length ? rows[0].total : 0;
    bodyHtml += renderLeaderboardRow({ code: "TEST", name: session.name + " ★", correct: 999, total: topScore + 1000 }, 1, true);
  }
  rows.forEach((r, i) => {
    bodyHtml += renderLeaderboardRow(r, session.isTest ? i + 2 : i + 1, r.code === session.code && !session.isTest);
  });

  if (!rows.length && !session.isTest) {
    bodyHtml = `<div class="leaderboard-row"><div></div><div style="opacity:.6">No predictions yet.</div><div></div><div></div></div>`;
  }

  root.innerHTML = `
    <div class="leaderboard-row leaderboard-row--head">
      <div class="lb-rank">#</div><div>Player</div>
      <div class="lb-correct">Correct</div><div class="lb-pts">Points</div>
    </div>
    ${bodyHtml}`;
}

function renderLeaderboardRow(r, rank, isMe) {
  return `
    <div class="leaderboard-row ${isMe ? "leaderboard-row--me" : ""}">
      <div class="lb-rank ${rank === 1 ? "lb-rank--1" : ""}">${rank}</div>
      <div class="lb-name">${escapeHtml(r.name)}</div>
      <div class="lb-correct">${r.correct}</div>
      <div class="lb-pts">${r.total}</div>
    </div>`;
}

async function updateUserScoreDisplay() {
  if (session.isTest) {
    $("#user-score-display").textContent = "∞ pts ★";
    return;
  }
  const results = await fetchResults();
  const { total } = scoreOnePerson(session.predictions, results);
  $("#user-score-display").textContent = `${total} pts`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// -----------------------------------------------------------------
// ADMIN
// -----------------------------------------------------------------
function gotoAdmin() {
  show("view-admin");
  $("#admin-gate").classList.remove("hidden");
  $("#admin-tools").classList.add("hidden");
  $("#admin-pw").value = "";
  $("#admin-pw-error").hidden = true;
}

function unlockAdmin() {
  $("#admin-gate").classList.add("hidden");
  $("#admin-tools").classList.remove("hidden");
  renderAdminLeaderboard();
  renderAdminResults();
  renderAdminCodes();
}

async function renderAdminLeaderboard() {
  const root = $("#admin-leaderboard");
  root.innerHTML = `<div style="opacity:.6">Loading…</div>`;
  const rows = await computeLeaderboard();
  if (!rows.length) {
    root.innerHTML = `<div style="opacity:.6">No predictions submitted yet.</div>`;
    return;
  }
  root.innerHTML = `
    <div class="leaderboard">
      <div class="leaderboard-row leaderboard-row--head">
        <div class="lb-rank">#</div><div>Player</div>
        <div class="lb-correct">Correct</div><div class="lb-pts">Points</div>
      </div>
      ${rows.map((r, i) => renderLeaderboardRow(r, i + 1, false)).join("")}
    </div>`;
}

function ensureAdminPredictionGraphStyles() {
  if ($("#admin-prediction-graph-style")) return;
  const style = document.createElement("style");
  style.id = "admin-prediction-graph-style";
  style.textContent = `
    .admin-prediction-graph {
      background: rgba(255,255,255,0.55);
      border: 1px solid var(--paper-line);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .admin-graphs-group { margin-top: 28px; }
    .admin-graphs-group:first-child { margin-top: 0; }
    .admin-graphs-group__title {
      font-family: var(--font-display);
      font-size: 28px;
      font-weight: 900;
      color: var(--navy);
      margin: 0 0 10px;
    }
    .admin-graphs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
    }
    .prediction-game-card {
      background: rgba(255,255,255,0.55);
      border: 1.5px solid var(--paper-line);
      border-radius: 8px;
      overflow: hidden;
    }
    .prediction-game-card__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--navy);
      color: var(--paper);
      padding: 10px 12px;
    }
    .prediction-game-card__teams {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 700;
    }
    .prediction-game-card__meta {
      font-family: var(--font-mono);
      font-size: 10px;
      color: rgba(244,237,224,.72);
      white-space: nowrap;
    }
    .prediction-game-card .admin-prediction-graph {
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .admin-prediction-graph__title {
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: .14em;
      text-transform: uppercase;
      color: var(--ink-mute);
      margin-bottom: 8px;
    }
    .prediction-graph-row {
      display: grid;
      grid-template-columns: 86px minmax(120px, 1fr) 42px;
      gap: 8px;
      align-items: start;
      margin-top: 8px;
    }
    .prediction-graph-label,
    .prediction-graph-count {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      color: var(--navy);
    }
    .prediction-graph-count { text-align: right; }
    .prediction-graph-bar {
      height: 10px;
      background: rgba(11,29,58,.12);
      border-radius: 999px;
      overflow: hidden;
      margin-top: 2px;
    }
    .prediction-graph-fill {
      height: 100%;
      background: var(--orange);
    }
    .prediction-graph-names {
      grid-column: 2 / -1;
      color: var(--ink-soft);
      font-size: 12px;
      line-height: 1.35;
      max-height: 64px;
      overflow: auto;
      padding-right: 4px;
    }
    .prediction-graph-missing {
      margin-top: 8px;
      color: var(--ink-mute);
      font-size: 12px;
    }
    @media (max-width: 700px) {
      .admin-graphs-grid { grid-template-columns: 1fr; }
      .prediction-game-card__head { align-items: flex-start; flex-direction: column; }
      .prediction-graph-row { grid-template-columns: 72px 1fr 34px; }
      .prediction-graph-names { grid-column: 1 / -1; }
    }
  `;
  document.head.appendChild(style);
}

function predictionScoreLabel(pred) {
  if (typeof pred.scoreHome === "number" && typeof pred.scoreAway === "number") {
    return ` (${pred.scoreHome}-${pred.scoreAway})`;
  }
  return "";
}

function buildGroupPredictionStats(predictions) {
  const players = predictions.filter((p) => p.code !== "TEST");
  const stats = {};
  GROUP_MATCHES.forEach((match) => {
    stats[match.id] = { total: players.length, HOME: [], DRAW: [], AWAY: [], missing: 0 };
  });

  players.forEach((player) => {
    const groups = player.groups || {};
    GROUP_MATCHES.forEach((match) => {
      const pred = groups[match.id];
      const bucket = stats[match.id];
      if (!pred || !["HOME", "DRAW", "AWAY"].includes(pred.winner)) {
        bucket.missing += 1;
        return;
      }
      bucket[pred.winner].push({
        name: player.name || player.code || "Player",
        score: predictionScoreLabel(pred),
      });
    });
  });

  return stats;
}

function renderPredictionNameList(items) {
  if (!items.length) return `<span style="opacity:.55">None</span>`;
  return items
    .map((item) => `<span>${escapeHtml(item.name)}${escapeHtml(item.score)}</span>`)
    .join(", ");
}

function renderAdminPredictionGraph(match, stats) {
  if (!stats || !stats.total) {
    return `
      <div class="admin-prediction-graph">
        <div class="admin-prediction-graph__title">Prediction graph</div>
        <div class="prediction-graph-missing">No saved predictions yet.</div>
      </div>`;
  }

  const choices = [
    { key: "HOME", label: `${match.home} win` },
    { key: "DRAW", label: "Draw" },
    { key: "AWAY", label: `${match.away} win` },
  ];

  return `
    <div class="admin-prediction-graph">
      <div class="admin-prediction-graph__title">Prediction graph (${stats.total} players)</div>
      ${choices.map((choice) => {
        const items = stats[choice.key] || [];
        const percent = Math.round((items.length / stats.total) * 100);
        return `
          <div class="prediction-graph-row">
            <div class="prediction-graph-label">${choice.label}</div>
            <div>
              <div class="prediction-graph-bar">
                <div class="prediction-graph-fill" style="width:${percent}%"></div>
              </div>
            </div>
            <div class="prediction-graph-count">${items.length}</div>
            <div class="prediction-graph-names">${renderPredictionNameList(items)}</div>
          </div>`;
      }).join("")}
      ${stats.missing ? `<div class="prediction-graph-missing">${stats.missing} players have not picked this game yet.</div>` : ""}
    </div>`;
}

function renderAdminGraphCard(match, stats) {
  return `
    <div class="prediction-game-card">
      <div class="prediction-game-card__head">
        <div class="prediction-game-card__teams">
          <span>${String(match.id).padStart(2, "0")}</span>
          <img class="team-flag" src="${flagUrl(TEAMS[match.home].iso)}" alt="" />
          <span>${match.home} v ${match.away}</span>
          <img class="team-flag" src="${flagUrl(TEAMS[match.away].iso)}" alt="" />
        </div>
        <div class="prediction-game-card__meta">${formatDate(match.date)} · ${match.time} UK</div>
      </div>
      ${renderAdminPredictionGraph(match, stats)}
    </div>`;
}

function ensureAdminGraphsTab() {
  const tabs = $(".app-tabs--admin");
  const tools = $("#admin-tools");
  if (!tabs || !tools || $('[data-admin-tab="graphs"]', tabs)) return;

  const btn = document.createElement("button");
  btn.className = "app-tab";
  btn.type = "button";
  btn.dataset.adminTab = "graphs";
  btn.textContent = "Prediction graphs";
  const setupTab = $('[data-admin-tab="setup"]', tabs);
  tabs.insertBefore(btn, setupTab || null);

  const panel = document.createElement("div");
  panel.className = "admin-panel hidden";
  panel.id = "admin-tab-graphs";
  panel.innerHTML = `
    <h3 class="panel-title">Prediction graphs</h3>
    <p class="panel-sub">Read-only view of what players have predicted for each group game.</p>
    <div id="admin-graphs"></div>`;
  const resultsPanel = $("#admin-tab-results");
  if (resultsPanel?.parentNode) resultsPanel.parentNode.insertBefore(panel, resultsPanel.nextSibling);
  else tools.appendChild(panel);
}

async function renderAdminGraphs() {
  ensureAdminPredictionGraphStyles();
  const root = $("#admin-graphs");
  if (!root) return;
  root.innerHTML = `<div style="opacity:.6">Loading…</div>`;
  const predictions = await fetchAllPredictions();
  const predictionStats = buildGroupPredictionStats(predictions);
  const groupKeys = Object.keys(GROUPS);

  root.innerHTML = groupKeys.map((group) => {
    const matches = GROUP_MATCHES.filter((m) => m.group === group);
    return `
      <section class="admin-graphs-group">
        <h4 class="admin-graphs-group__title">Group ${group}</h4>
        <div class="admin-graphs-grid">
          ${matches.map((match) => renderAdminGraphCard(match, predictionStats[match.id])).join("")}
        </div>
      </section>`;
  }).join("");
}

async function renderAdminResults() {
  const root = $("#admin-results");
  const results = await fetchResults();
  results.groups  = results.groups  || {};
  results.bracket = results.bracket || {};

  const groupRows = GROUP_MATCHES.map((m) => {
    const r = results.groups[m.id] || {};
    const sh = r.scoreHome ?? "";
    const sa = r.scoreAway ?? "";
    const w  = r.winner || "";
    const btn = (val, lab) =>
      `<button type="button" class="outcome-btn ${w === val ? "is-selected" : ""}" data-result-pick="${val}" data-match="${m.id}">${lab}</button>`;
    return `
      <div class="result-row" data-result-match="${m.id}">
        <div class="result-row__num">${m.id}</div>
        <div class="result-row__teams">
          <img class="team-flag" src="${flagUrl(TEAMS[m.home].iso)}" alt="" />
          ${m.home} v ${m.away}
          <img class="team-flag" src="${flagUrl(TEAMS[m.away].iso)}" alt="" />
        </div>
        <div class="result-row__inputs">
          <input class="score-input" data-result-side="home" data-match="${m.id}" type="number" min="0" value="${sh}" />
          <span class="score-dash">—</span>
          <input class="score-input" data-result-side="away" data-match="${m.id}" type="number" min="0" value="${sa}" />
        </div>
        <div class="result-row__outcome">
          ${btn("HOME", "H")}${btn("DRAW", "D")}${btn("AWAY", "A")}
        </div>
      </div>`;
  }).join("");

  const bracketRows = BRACKET_ROUNDS.map((round) => {
    const picks = asList(results.bracket[round.id]);
    return `
      <div class="bracket-section" data-result-round="${round.id}" style="margin-top:24px">
        <div class="bracket-section__head">
          <div class="bracket-section__title">${round.label}</div>
          <div class="bracket-section__meta">Pick the ${round.pickCount} teams that ACTUALLY reached this round</div>
        </div>
        <div class="team-picker">
          ${TEAM_CODES.map((c) => {
            const sel = picks.includes(c) ? "is-selected" : "";
            return `<button class="team-chip ${sel}" type="button" data-result-team="${c}" data-result-round-chip="${round.id}">
              <img class="team-flag" src="${flagUrl(TEAMS[c].iso)}" alt="" />
              <span class="team-chip__name">${TEAMS[c].name}</span>
            </button>`;
          }).join("")}
        </div>
        <div class="picker-status">Picked <strong data-result-count="${round.id}">${picks.length} / ${round.pickCount}</strong></div>
      </div>`;
  }).join("");

  const trophyOpts = TEAM_CODES.map((c) => `<option value="${c}">${TEAMS[c].name} (${c})</option>`).join("");

  root.innerHTML = `
    <h4 style="font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;color:var(--ink-mute);margin:24px 0 8px;text-transform:uppercase">Group stage results</h4>
    ${groupRows}
    <h4 style="font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;color:var(--ink-mute);margin:24px 0 8px;text-transform:uppercase">Knockout actuals</h4>
    ${bracketRows}
    <div class="bracket-section" style="margin-top:24px">
      <div class="bracket-section__head">
        <div class="bracket-section__title">Trophy results</div>
      </div>
      <div class="final-pick-row">
        <div class="final-pick">
          <div class="final-pick__label">🏆 Champion</div>
          <select id="result-champion">
            <option value="">—</option>${trophyOpts}
          </select>
        </div>
        <div class="final-pick">
          <div class="final-pick__label">🥉 3rd place</div>
          <select id="result-third">
            <option value="">—</option>${trophyOpts}
          </select>
        </div>
      </div>
    </div>`;

  if (results.champion) $("#result-champion").value = results.champion;
  if (results.third)    $("#result-third").value    = results.third;

  // Wire group result inputs
  const adminResultsDirty = { groups: {}, bracket: {}, champion: undefined, third: undefined };
  const saveAdminDebounced = debounce(async () => {
    const merged = await fetchResults();
    merged.groups  = { ...(merged.groups  || {}), ...adminResultsDirty.groups };
    merged.bracket = { ...(merged.bracket || {}), ...adminResultsDirty.bracket };
    if (adminResultsDirty.champion !== undefined) merged.champion = adminResultsDirty.champion;
    if (adminResultsDirty.third    !== undefined) merged.third    = adminResultsDirty.third;
    await saveResults(merged);
    renderAdminLeaderboard();
  }, 600);

  $$(".result-row .outcome-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mid = btn.dataset.match;
      $$(`.result-row[data-result-match="${mid}"] .outcome-btn`).forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      adminResultsDirty.groups[mid] = { ...(adminResultsDirty.groups[mid] || results.groups[mid] || {}), winner: btn.dataset.resultPick };
      saveAdminDebounced();
    });
  });
  $$(".result-row .score-input").forEach((input) => {
    input.addEventListener("input", () => {
      const mid = input.dataset.match;
      const side = input.dataset.resultSide === "home" ? "scoreHome" : "scoreAway";
      const val = input.value === "" ? null : parseInt(input.value, 10) || 0;
      adminResultsDirty.groups[mid] = { ...(adminResultsDirty.groups[mid] || results.groups[mid] || {}), [side]: val };
      // Infer outcome if both filled
      const p = adminResultsDirty.groups[mid];
      if (typeof p.scoreHome === "number" && typeof p.scoreAway === "number") {
        p.winner = p.scoreHome > p.scoreAway ? "HOME" : p.scoreHome < p.scoreAway ? "AWAY" : "DRAW";
        $$(`.result-row[data-result-match="${mid}"] .outcome-btn`).forEach((b) => b.classList.toggle("is-selected", b.dataset.resultPick === p.winner));
      }
      saveAdminDebounced();
    });
  });

  // Bracket chips
  $$("[data-result-round-chip]").forEach((chip) => {
    chip.addEventListener("click", () => {
      const round = chip.dataset.resultRoundChip;
      const team  = chip.dataset.resultTeam;
      const roundObj = BRACKET_ROUNDS.find((r) => r.id === round);
      const source = Object.prototype.hasOwnProperty.call(adminResultsDirty.bracket, round)
        ? adminResultsDirty.bracket[round]
        : results.bracket[round];
      const arr = new Set(asList(source));
      if (arr.has(team)) arr.delete(team);
      else {
        if (arr.size >= roundObj.pickCount) return;
        arr.add(team);
      }
      adminResultsDirty.bracket[round] = [...arr];
      chip.classList.toggle("is-selected");
      const cnt = $(`[data-result-count="${round}"]`);
      if (cnt) cnt.textContent = `${arr.size} / ${roundObj.pickCount}`;
      saveAdminDebounced();
    });
  });

  $("#result-champion")?.addEventListener("change", (e) => {
    adminResultsDirty.champion = e.target.value || null;
    saveAdminDebounced();
  });
  $("#result-third")?.addEventListener("change", (e) => {
    adminResultsDirty.third = e.target.value || null;
    saveAdminDebounced();
  });
}

async function renderAdminCodes() {
  const root = $("#admin-codes");
  root.innerHTML = `<div style="opacity:.6">Loading…</div>`;
  const codes = await fetchAllCodes();
  if (!codes.length) {
    root.innerHTML = `<p style="color:var(--ink-soft)">No codes seeded yet. Use the <strong>Setup</strong> tab to create some.</p>`;
    return;
  }
  codes.sort((a, b) => a.code.localeCompare(b.code));
  const claimed   = codes.filter((c) => c.claimed).length;
  const unclaimed = codes.length - claimed;
  root.innerHTML = `
    <p style="color:var(--ink-soft)"><strong>${codes.length}</strong> codes · <strong>${claimed}</strong> claimed · <strong>${unclaimed}</strong> unclaimed.</p>
    <div class="admin-codes-grid">
      ${codes.map((c) => `
        <div class="code-chip ${c.claimed ? "is-claimed" : ""}">
          ${c.code}
          <span class="code-chip__name">${c.claimed ? escapeHtml(c.name || "—") : "free"}</span>
        </div>`).join("")}
    </div>`;
}

async function seedCodes() {
  const out = $("#seed-output");
  out.textContent = "Generating 100 codes…\n";
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ambiguous chars stripped
  const codes = new Set();
  while (codes.size < 100) {
    let c = "";
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    codes.add(c);
  }
  const list = [...codes].sort();
  out.textContent += "Writing to database…\n";
  const codeMap = {};
  list.forEach((code) => {
    codeMap[code] = { claimed: false, createdAt: serverTimestamp() };
  });
  try {
    await set(ref(db, "codes"), codeMap);
    out.textContent += `\n✓ Seeded ${list.length} codes. Distribute these (copy and save them somewhere safe — they're shown here just this once in plain form):\n\n${list.join("\n")}\n`;
  } catch (e) {
    out.textContent += `\n✗ Failed: ${e.message}`;
    console.error(e);
  }
  renderAdminCodes();
}

// -----------------------------------------------------------------
// EVENT WIRING
// -----------------------------------------------------------------
function init() {
  prepareLoginForm();
  ensureAdminGraphsTab();
  localStorage.removeItem("fwc26-admin-login");

  // Hide loader
  if (hasSavedLogin()) {
    showLoadingMessage("Loading");
    setTimeout(async () => {
      try {
        if (await restoreLogin()) {
          hideLoading();
          return;
        }
      } catch (e) {
        console.error(e);
        forgetLogin();
      }
      show("view-login");
      hideLoading();
    }, 600);
  } else {
    setTimeout(() => {
      show("view-login");
      hideLoading();
    }, 600);
  }

  // Login form
  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    attemptLogin($("#login-code").value, $("#login-name").value);
  });

  // Sign out
  $("#btn-signout").addEventListener("click", () => {
    forgetLogin();
    session.code = session.name = session.predictions = null;
    session.isTest = false;
    show("view-login");
    $("#login-code").value = ""; $("#login-name").value = "";
  });

  // No code modal
  const modal = $("#modal-no-code");
  $("#btn-no-code").addEventListener("click", () => {
    const subject = encodeURIComponent("FWC26 Pool — Please send me a code");
    const body = encodeURIComponent(
`Hi Ethan,

Could I have a code for the World Cup 2026 predictions pool, please? I know it's free to enter and the winner gets a prize.

My name: 

Thanks!`
    );
    $("#no-code-mailto").href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    $("#no-code-email-display").textContent = CONTACT_EMAIL;
    modal.classList.remove("hidden");
  });
  $$("[data-close-modal]").forEach((el) => el.addEventListener("click", () => modal.classList.add("hidden")));

  // Admin
  $("#btn-admin").addEventListener("click", gotoAdmin);
  $("#btn-admin-back").addEventListener("click", () => show("view-login"));
  $("#admin-pw-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if ($("#admin-pw").value === ADMIN_PASSWORD) unlockAdmin();
    else { $("#admin-pw-error").textContent = "Wrong password."; $("#admin-pw-error").hidden = false; }
  });
  $("#btn-seed-codes").addEventListener("click", seedCodes);

  // Tabs (predictions)
  $$("#app-tabs .app-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#app-tabs .app-tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const t = btn.dataset.tab;
      ["groups", "bracket", "leaderboard"].forEach((key) => {
        $("#tab-" + key).classList.toggle("hidden", key !== t);
      });
      if (t === "bracket") renderBracketTab();
      if (t === "leaderboard") renderLeaderboardTab();
    });
  });

  // Tabs (admin)
  $$(".app-tabs--admin .app-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".app-tabs--admin .app-tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const t = btn.dataset.adminTab;
      ["leaderboard", "results", "graphs", "codes", "setup"].forEach((key) => {
        $("#admin-tab-" + key).classList.toggle("hidden", key !== t);
      });
      if (t === "leaderboard") renderAdminLeaderboard();
      if (t === "results")     renderAdminResults();
      if (t === "graphs")      renderAdminGraphs();
      if (t === "codes")       renderAdminCodes();
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
