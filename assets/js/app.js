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
const db = getDatabase(fbApp);

// -----------------------------------------------------------------
// Session state
// -----------------------------------------------------------------
const session = {
  code: null,
  name: null,
  isTest: false,
  isAdmin: false,
  predictions: null,
};

// Leaderboard stays hidden from players until you flip this to false (reveal after the final).
const LEADERBOARD_LOCKED = true;

const SESSION_KEY = "fwc26-login";
const PREDICTION_LOCK_MS = 60 * 60 * 1000;
const UK_SUMMER_OFFSET_MINUTES = 60;

const TEAM_CODES = Object.keys(TEAMS);

const BRACKET_ROUNDS = [
  { id: "r32", label: "Round of 32", pickCount: 32, scoreKey: "r32Team", per: SCORING.r32Team },
  { id: "r16", label: "Round of 16", pickCount: 16, scoreKey: "r16Team", per: SCORING.r16Team },
  { id: "qf", label: "Quarter-finals", pickCount: 8, scoreKey: "qfTeam", per: SCORING.qfTeam },
  { id: "sf", label: "Semi-finals", pickCount: 4, scoreKey: "sfTeam", per: SCORING.sfTeam },
  { id: "finalists", label: "Finalists", pickCount: 2, scoreKey: "finalTeam", per: SCORING.finalTeam },
];

const PLAYER_BRACKET_ROUNDS = BRACKET_ROUNDS.filter((round) => round.id !== "r32");

// -----------------------------------------------------------------
// Tiny helpers
// -----------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function show(viewId) {
  ["view-login", "view-predictions", "view-admin"].forEach((id) => {
    $("#" + id).classList.toggle("hidden", id !== viewId);
  });
  window.scrollTo(0, 0);
}

function flagUrl(iso, size = "w40") {
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
  return d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
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
  return GROUP_MATCHES.some((m) => m.id === match.id);
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

  localStorage.setItem(SESSION_KEY, JSON.stringify({
    code: session.code,
    name: session.name,
  }));
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
  await update(ref(db, `codes/${code}`), {
    claimed: true,
    name,
    claimedAt: serverTimestamp(),
  });
}

async function fetchPredictions(code) {
  const snap = await get(ref(db, `predictions/${code}`));
  return snap.exists() ? snap.val() : null;
}

async function savePredictions(code, payload) {
  await update(ref(db, `predictions/${code}`), {
    ...payload,
    updatedAt: serverTimestamp(),
  });
}

async function fetchResults() {
  const snap = await get(ref(db, "results/global"));
  return snap.exists() ? snap.val() : {
    groups: {},
    bracket: {},
    champion: null,
    third: null,
  };
}

async function saveResults(payload) {
  await update(ref(db, "results/global"), {
    ...payload,
    updatedAt: serverTimestamp(),
  });
}

async function fetchAllPredictions() {
  const snap = await get(ref(db, "predictions"));
  const out = [];

  snap.forEach((d) => {
    out.push({
      code: d.key,
      ...d.val(),
    });
  });

  return out;
}

async function fetchAllCodes() {
  const snap = await get(ref(db, "codes"));
  const out = [];

  snap.forEach((d) => {
    out.push({
      code: d.key,
      ...d.val(),
    });
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

function clearLoginError() {
  $("#login-error").hidden = true;
}

function prepareLoginForm() {
  const nameInput = $("#login-name");

  if (nameInput) {
    nameInput.required = false;
    nameInput.removeAttribute("required");
    nameInput.placeholder = "First time only";
  }

  const notes = $$(".login-card .login-sub");

  if (notes[0]) {
    notes[0].textContent = "Enter your access code to open your predictions. Add your name only the first time you use a new code.";
  }

  if (notes[1]) {
    notes[1].textContent = "Already used your code? You can leave the name box blank.";
  }
}

async function attemptLogin(rawCode, rawName) {
  clearLoginError();

  const code = rawCode.trim().toUpperCase();
  const name = rawName.trim();

  if (!code) {
    showLoginError("Please enter your access code.");
    return;
  }

  if (code === "TEST") {
    session.code = "TEST";
    session.name = name || "Test player";
    session.isTest = true;
    session.predictions = (await fetchPredictions("TEST")) || { groups: {}, bracket: {} };

    await launchApp();
    return;
  }

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

  if (!codeDoc.claimed) {
    if (!name) {
      showLoginError("Please enter your name the first time you use a new code.");
      return;
    }

    try {
      await claimCode(code, name);
    } catch (e) {
      showLoginError("Couldn't claim that code. Try again.");
      console.error(e);
      return;
    }
  }

  session.code = code;
  session.name = codeDoc.claimed ? (codeDoc.name || name || "Player") : name;
  session.isTest = false;
  session.predictions = (await fetchPredictions(code)) || { groups: {}, bracket: {} };

  rememberLogin();
  await launchApp();
}

async function launchApp() {
  $("#user-name-display").textContent = session.name + (session.isTest ? " ★" : "");

  show("view-predictions");

  // Group stage is closed: hide its tab entirely and open straight onto the bracket.
  const groupsTabBtn = document.querySelector('#app-tabs [data-tab="groups"]');
  if (groupsTabBtn) groupsTabBtn.style.display = "none";

  $$("#app-tabs .app-tab").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === "bracket"));
  $("#tab-groups").classList.add("hidden");
  $("#tab-bracket").classList.remove("hidden");
  $("#tab-leaderboard").classList.add("hidden");

  await renderBracketTab();
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

  $$(".match-row", root).forEach(wireMatchRow);
  updateGroupsProgress();
}

function renderMatchRow(m) {
  const pred = (session.predictions.groups || {})[m.id] || {};
  const winner = pred.winner;
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

      session.predictions.groups = session.predictions.groups || {};

      const pick = btn.dataset.pick.toUpperCase();

      session.predictions.groups[id] = {
        ...(session.predictions.groups[id] || {}),
        winner: pick,
      };

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

      const side = input.dataset.side === "home" ? "scoreHome" : "scoreAway";
      const value = input.value === "" ? null : Math.max(0, Math.min(20, parseInt(input.value, 10) || 0));

      session.predictions.groups = session.predictions.groups || {};

      session.predictions.groups[id] = {
        ...(session.predictions.groups[id] || {}),
        [side]: value,
      };

      const p = session.predictions.groups[id];

      if (typeof p.scoreHome === "number" && typeof p.scoreAway === "number") {
        const inferred = p.scoreHome > p.scoreAway
          ? "HOME"
          : p.scoreHome < p.scoreAway
            ? "AWAY"
            : "DRAW";

        p.winner = inferred;

        $$(".outcome-btn", row).forEach((b) => {
          b.classList.toggle("is-selected", b.dataset.pick.toUpperCase() === inferred);
        });
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
    await savePredictions(session.code, {
      name: session.name,
      groups: session.predictions.groups,
    });
  } catch (e) {
    console.error(e);
  }

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
// KNOCKOUT BRACKET — score predictor, winners auto-advance
//   Scoring per match:  +7 correct winner,  +7 exact score (max 14)
//   Whole bracket locks at one fixed UTC instant (same worldwide).
// -----------------------------------------------------------------
const KNOCKOUT_LOCK_UTC = Date.UTC(2026, 5, 28, 19, 0, 0); // 28 Jun 2026, 20:00 UK (BST) = 19:00 UTC
const KNOCKOUT_LOCK_LABEL = "8:00 PM UK · Sun 28 Jun";
function isKnockoutLocked() { return Date.now() >= KNOCKOUT_LOCK_UTC; }

const KO_WIN_POINTS = 7;
const KO_EXACT_POINTS = 7;

// Bracket structure. home/away is either {team} (fixed R32), {win:id} or {lose:id}.
const KO_MATCHES = [
  { id: "r32-1",  round: "R32", home: { team: "RSA" }, away: { team: "CAN" } },
  { id: "r32-2",  round: "R32", home: { team: "GER" }, away: { team: "PAR" } },
  { id: "r32-3",  round: "R32", home: { team: "BRA" }, away: { team: "JPN" } },
  { id: "r32-4",  round: "R32", home: { team: "CIV" }, away: { team: "NOR" } },
  { id: "r32-5",  round: "R32", home: { team: "NED" }, away: { team: "MAR" } },
  { id: "r32-6",  round: "R32", home: { team: "FRA" }, away: { team: "SWE" } },
  { id: "r32-7",  round: "R32", home: { team: "MEX" }, away: { team: "ECU" } },
  { id: "r32-8",  round: "R32", home: { team: "ENG" }, away: { team: "COD" } },
  { id: "r32-9",  round: "R32", home: { team: "POR" }, away: { team: "CRO" } },
  { id: "r32-10", round: "R32", home: { team: "ESP" }, away: { team: "AUT" } },
  { id: "r32-11", round: "R32", home: { team: "USA" }, away: { team: "BIH" } },
  { id: "r32-12", round: "R32", home: { team: "BEL" }, away: { team: "SEN" } },
  { id: "r32-13", round: "R32", home: { team: "COL" }, away: { team: "GHA" } },
  { id: "r32-14", round: "R32", home: { team: "AUS" }, away: { team: "EGY" } },
  { id: "r32-15", round: "R32", home: { team: "SUI" }, away: { team: "ALG" } },
  { id: "r32-16", round: "R32", home: { team: "ARG" }, away: { team: "CPV" } },

  // Round of 16 wiring follows the official FIFA bracket (matches 89–96).
  { id: "r16-1", round: "R16", home: { win: "r32-2"  }, away: { win: "r32-6"  } },
  { id: "r16-2", round: "R16", home: { win: "r32-1"  }, away: { win: "r32-5"  } },
  { id: "r16-3", round: "R16", home: { win: "r32-3"  }, away: { win: "r32-4"  } },
  { id: "r16-4", round: "R16", home: { win: "r32-7"  }, away: { win: "r32-8"  } },
  { id: "r16-5", round: "R16", home: { win: "r32-9"  }, away: { win: "r32-10" } },
  { id: "r16-6", round: "R16", home: { win: "r32-11" }, away: { win: "r32-12" } },
  { id: "r16-7", round: "R16", home: { win: "r32-16" }, away: { win: "r32-14" } },
  { id: "r16-8", round: "R16", home: { win: "r32-13" }, away: { win: "r32-15" } },

  // Quarter-finals (matches 97–100).
  { id: "qf-1", round: "QF", home: { win: "r16-1" }, away: { win: "r16-2" } },
  { id: "qf-2", round: "QF", home: { win: "r16-5" }, away: { win: "r16-6" } },
  { id: "qf-3", round: "QF", home: { win: "r16-3" }, away: { win: "r16-4" } },
  { id: "qf-4", round: "QF", home: { win: "r16-7" }, away: { win: "r16-8" } },

  { id: "sf-1", round: "SF", home: { win: "qf-1" }, away: { win: "qf-2" } },
  { id: "sf-2", round: "SF", home: { win: "qf-3" }, away: { win: "qf-4" } },

  { id: "third", round: "THIRD", home: { lose: "sf-1" }, away: { lose: "sf-2" } },
  { id: "final", round: "FINAL", home: { win:  "sf-1" }, away: { win:  "sf-2" } },
];

const KO_BY_ID = Object.fromEntries(KO_MATCHES.map((m) => [m.id, m]));

const KO_SHORT = {
  "r32-1": "R32-1", "r32-2": "R32-2", "r32-3": "R32-3", "r32-4": "R32-4",
  "r32-5": "R32-5", "r32-6": "R32-6", "r32-7": "R32-7", "r32-8": "R32-8",
  "r32-9": "R32-9", "r32-10": "R32-10", "r32-11": "R32-11", "r32-12": "R32-12",
  "r32-13": "R32-13", "r32-14": "R32-14", "r32-15": "R32-15", "r32-16": "R32-16",
  "r16-1": "R16-1", "r16-2": "R16-2", "r16-3": "R16-3", "r16-4": "R16-4",
  "r16-5": "R16-5", "r16-6": "R16-6", "r16-7": "R16-7", "r16-8": "R16-8",
  "qf-1": "QF1", "qf-2": "QF2", "qf-3": "QF3", "qf-4": "QF4",
  "sf-1": "SF1", "sf-2": "SF2", "third": "3rd play-off", "final": "Final",
};

const KO_ROUND_ORDER = ["R32", "R16", "QF", "SF", "THIRD", "FINAL"];
const KO_ROUND_LABEL = {
  R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals",
  SF: "Semi-finals", THIRD: "Third-place play-off", FINAL: "Final",
};

function koName(code) { return code && TEAMS[code] ? TEAMS[code].name : "—"; }
function koFlag(code) { return code && TEAMS[code] ? flagUrl(TEAMS[code].iso) : ""; }

function koDecideWinner(pred, home, away) {
  if (!home || !away) return null;
  const h = toScoreNumber(pred && pred.h);
  const a = toScoreNumber(pred && pred.a);
  if (h === null || a === null) return null;
  if (h > a) return home;
  if (a > h) return away;
  if (pred.pen === "home") return home;
  if (pred.pen === "away") return away;
  return null;
}

// Resolve every match's participants + winner/loser from a set of predictions.
function koResolveAll(ko) {
  ko = ko || {};
  const cache = {};

  function side(ref) {
    if (ref.team) return ref.team;
    const src = teams(ref.win || ref.lose);
    if (ref.win) return src.winner;
    return src.loser;
  }

  function teams(id) {
    if (cache[id]) return cache[id];
    cache[id] = { home: null, away: null, winner: null, loser: null }; // guard against loops
    const m = KO_BY_ID[id];
    const home = side(m.home);
    const away = side(m.away);
    const winner = koDecideWinner(ko[id], home, away);
    const loser = winner ? (winner === home ? away : home) : null;
    const r = { home, away, winner, loser };
    cache[id] = r;
    return r;
  }

  KO_MATCHES.forEach((m) => teams(m.id));
  return cache;
}

// New knockout scoring: compares a player's bracket to the actual (admin) bracket.
function scoreKnockout(playerKo, resultsKo) {
  let total = 0;
  let correct = 0;

  const P = koResolveAll(playerKo || {});
  const R = koResolveAll(resultsKo || {});

  for (const m of KO_MATCHES) {
    const r = R[m.id];
    const rp = (resultsKo || {})[m.id] || {};
    const rH = toScoreNumber(rp.h);
    const rA = toScoreNumber(rp.a);

    if (!r.winner || rH === null || rA === null) continue; // result not entered yet

    const p = P[m.id];
    const pp = (playerKo || {})[m.id] || {};
    const pH = toScoreNumber(pp.h);
    const pA = toScoreNumber(pp.a);

    if (p.winner && p.winner === r.winner) {
      total += KO_WIN_POINTS;
      correct += 1;
    }

    if (p.home && p.away && pH !== null && pA !== null) {
      const sameMatch =
        (p.home === r.home && p.away === r.away) ||
        (p.home === r.away && p.away === r.home);

      if (sameMatch) {
        const pg = { [p.home]: pH, [p.away]: pA };
        const rg = { [r.home]: rH, [r.away]: rA };
        if (pg[r.home] === rg[r.home] && pg[r.away] === rg[r.away]) {
          total += KO_EXACT_POINTS;
          correct += 1;
        }
      }
    }
  }

  return { total, correct };
}

// -----------------------------------------------------------------
// Bracket renderer (shared by player + admin)
// -----------------------------------------------------------------
function koTbdLabel(ref) {
  const src = KO_SHORT[ref.win || ref.lose] || "TBD";
  return (ref.win ? "Winner of " : "Loser of ") + src;
}

function koMatchCard(m, resolved, ko, locked) {
  const t = resolved[m.id];
  const pred = ko[m.id] || {};
  const ready = !!(t.home && t.away);
  const h = toScoreNumber(pred.h);
  const a = toScoreNumber(pred.a);
  const isDraw = ready && h !== null && a !== null && h === a;
  const dis = (locked || !ready) ? "disabled" : "";
  const winSide = t.winner ? (t.winner === t.home ? "home" : "away") : null;

  const row = (sideKey) => {
    const code = sideKey === "home" ? t.home : t.away;
    const ref = sideKey === "home" ? m.home : m.away;
    const win = winSide === sideKey ? "is-win" : "";
    const val = sideKey === "home" ? (pred.h ?? "") : (pred.a ?? "");
    const label = ready ? koName(code) : koTbdLabel(ref);

    return `
      <div class="kb-row ${ready ? "" : "kb-row--tbd"} ${win}">
        ${ready
          ? `<img class="kb-flag" src="${koFlag(code)}" alt="" loading="lazy" />`
          : `<span class="kb-flag kb-flag--tbd"></span>`}
        <span class="kb-team">${label}</span>
        <input class="kb-score" type="number" inputmode="numeric" min="0" max="20"
               value="${val}" data-match="${m.id}" data-side="${sideKey}" ${dis} />
      </div>`;
  };

  const pen = (isDraw)
    ? `<div class="kb-pen">
         <span class="kb-pen__label">Pens won by</span>
         <button type="button" class="kb-pen__btn ${pred.pen === "home" ? "is-active" : ""}" data-match="${m.id}" data-pen-pick="home" ${dis}>${koName(t.home)}</button>
         <button type="button" class="kb-pen__btn ${pred.pen === "away" ? "is-active" : ""}" data-match="${m.id}" data-pen-pick="away" ${dis}>${koName(t.away)}</button>
       </div>`
    : "";

  return `
    <div class="kb-match" data-match="${m.id}">
      <div class="kb-match__no">${KO_SHORT[m.id]}</div>
      ${row("home")}
      ${row("away")}
      ${pen}
    </div>`;
}

function paintKoBracket(root, opts) {
  const ko = opts.ko;
  const locked = opts.isLocked();
  const resolved = koResolveAll(ko);

  root.innerHTML = KO_ROUND_ORDER.map((rd) => {
    const ms = KO_MATCHES.filter((m) => m.round === rd);
    return `
      <section class="kb-round">
        <h3 class="kb-round__title">${KO_ROUND_LABEL[rd]}</h3>
        <div class="kb-matches">${ms.map((m) => koMatchCard(m, resolved, ko, locked)).join("")}</div>
      </section>`;
  }).join("");

  if (locked) return;

  $$(".kb-score", root).forEach((inp) => {
    inp.addEventListener("change", () => {
      const id = inp.dataset.match;
      const v = inp.value === "" ? null : Math.max(0, Math.min(20, parseInt(inp.value, 10) || 0));
      ko[id] = ko[id] || {};
      ko[id][inp.dataset.side === "home" ? "h" : "a"] = v;
      opts.onSave();
      paintKoBracket(root, opts);
    });
  });

  $$("[data-pen-pick]", root).forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.match;
      ko[id] = ko[id] || {};
      ko[id].pen = btn.dataset.penPick;
      opts.onSave();
      paintKoBracket(root, opts);
    });
  });
}

// -----------------------------------------------------------------
// PLAYER bracket tab
// -----------------------------------------------------------------
function ensureKo() {
  session.predictions = session.predictions || {};
  session.predictions.ko = session.predictions.ko || {};
  return session.predictions.ko;
}

function koIntroHtml() {
  const locked = isKnockoutLocked();
  return `
    <h2 class="panel-title">Knockout bracket</h2>
    <p class="panel-sub">
      Predict the <strong>score</strong> of every match. The winner you pick automatically advances to the
      next round, all the way to the Final — so build your whole bracket from the Round of 32 to the trophy.
      Drew it? Tap who goes through on penalties.
    </p>
    <div class="scoring-key">
      <span><i class="dot-orange"></i>Correct winner <strong>+7</strong></span>
      <span><i class="dot-blue"></i>Exact score <strong>+7 more</strong> (14 max per match)</span>
    </div>
    <p class="panel-sub" style="margin-top:12px">
      ${locked
        ? "🔒 Predictions are now locked."
        : `🔒 Everything locks at <strong>${KNOCKOUT_LOCK_LABEL}</strong>. That's one fixed moment worldwide — 9 PM in France, etc. — so changing your phone's location or using a VPN can't get you extra time.`}
    </p>`;
}

const koSaveDebounced = debounce(async () => {
  if (isKnockoutLocked()) { renderBracketTab(); return; }
  setSaveStatus("bracket", true);
  try {
    await savePredictions(session.code, { name: session.name, ko: session.predictions.ko });
  } catch (e) {
    console.error(e);
  }
  setSaveStatus("bracket", false);
  updateUserScoreDisplay();
}, 600);

async function renderBracketTab() {
  const intro = document.querySelector("#tab-bracket .panel-intro");
  if (intro) intro.innerHTML = koIntroHtml();

  const status = $("#bracket-save-status");
  if (status) {
    status.textContent = isKnockoutLocked()
      ? "Locked — predictions are final"
      : `Saved automatically · locks ${KNOCKOUT_LOCK_LABEL}`;
  }

  paintKoBracket($("#bracket-container"), {
    ko: ensureKo(),
    isLocked: () => isKnockoutLocked(),
    onSave: () => koSaveDebounced(),
  });
}

async function saveKoResults(ko) {
  await update(ref(db, "results/global"), { ko, updatedAt: serverTimestamp() });
}

// -----------------------------------------------------------------
// SCORING
// -----------------------------------------------------------------
const GROUP_OUTCOME_POINTS = 6;
const GROUP_ONE_SCORE_POINTS = 7;
const GROUP_EXACT_BONUS_POINTS = 14;

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

function scoreOnePerson(p, results) {
  let total = 0;
  let correct = 0;

  const gp = p.groups || {};
  const gr = results.groups || {};

  for (const [id, pred] of Object.entries(gp)) {
    const r = gr[id];
    if (!r || !pred) continue;

    const predHome = toScoreNumber(pred.scoreHome);
    const predAway = toScoreNumber(pred.scoreAway);
    const realHome = toScoreNumber(r.scoreHome);
    const realAway = toScoreNumber(r.scoreAway);

    const hasPredictedScore = predHome !== null && predAway !== null;
    const hasRealScore = realHome !== null && realAway !== null;

    const predictedWinner = pred.winner || inferWinnerFromScores(predHome, predAway);
    const realWinner = r.winner || inferWinnerFromScores(realHome, realAway);

    if (!realWinner && !hasRealScore) continue;

    const exactScore =
      hasPredictedScore &&
      hasRealScore &&
      predHome === realHome &&
      predAway === realAway;

    const oneTeamScoreCorrect =
      hasPredictedScore &&
      hasRealScore &&
      !exactScore &&
      (predHome === realHome || predAway === realAway);

    const correctOutcome =
      exactScore ||
      (
        predictedWinner &&
        realWinner &&
        predictedWinner === realWinner
      );

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

  const koPts = scoreKnockout(p.ko, results.ko);
  total += koPts.total;
  correct += koPts.correct;

  return { total, correct };
}

async function computeLeaderboard() {
  const [preds, results] = await Promise.all([
    fetchAllPredictions(),
    fetchResults(),
  ]);

  const rows = preds
    .filter((p) => p.code !== "TEST")
    .map((p) => ({
      code: p.code,
      name: p.name || "—",
      ...scoreOnePerson(p, results),
    }));

  rows.sort((a, b) => b.total - a.total || b.correct - a.correct);

  return rows;
}

async function renderLeaderboardTab() {
  const root = $("#leaderboard-container");

  if (LEADERBOARD_LOCKED && !session.isAdmin) {
    root.innerHTML = `
      <div class="ko-empty">
        <div class="ko-empty__badge">🔒</div>
        <h3 class="ko-empty__title">Locked</h3>
        <p class="ko-empty__text">Final results will be revealed after the Final. No peeking — let the suspense build.</p>
        <div class="ko-empty__meta">Standings hidden until the trophy is lifted</div>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="leaderboard-row leaderboard-row--head">
      <div class="lb-rank">#</div>
      <div>Player</div>
      <div class="lb-correct">Correct</div>
      <div class="lb-pts">Points</div>
    </div>
    <div class="leaderboard-row">
      <div></div>
      <div>Loading…</div>
      <div></div>
      <div></div>
    </div>`;

  const rows = await computeLeaderboard();

  let bodyHtml = "";

  if (session.isTest) {
    const topScore = rows.length ? rows[0].total : 0;

    bodyHtml += renderLeaderboardRow({
      code: "TEST",
      name: session.name + " ★",
      correct: 999,
      total: topScore + 1000,
    }, 1, true);
  }

  rows.forEach((r, i) => {
    bodyHtml += renderLeaderboardRow(
      r,
      session.isTest ? i + 2 : i + 1,
      r.code === session.code && !session.isTest,
    );
  });

  if (!rows.length && !session.isTest) {
    bodyHtml = `
      <div class="leaderboard-row">
        <div></div>
        <div style="opacity:.6">No predictions yet.</div>
        <div></div>
        <div></div>
      </div>`;
  }

  root.innerHTML = `
    <div class="leaderboard-row leaderboard-row--head">
      <div class="lb-rank">#</div>
      <div>Player</div>
      <div class="lb-correct">Correct</div>
      <div class="lb-pts">Points</div>
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
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
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
  session.isAdmin = true;

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
        <div class="lb-rank">#</div>
        <div>Player</div>
        <div class="lb-correct">Correct</div>
        <div class="lb-pts">Points</div>
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
    stats[match.id] = {
      total: players.length,
      HOME: [],
      DRAW: [],
      AWAY: [],
      missing: 0,
    };
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

  if (resultsPanel?.parentNode) {
    resultsPanel.parentNode.insertBefore(panel, resultsPanel.nextSibling);
  } else {
    tools.appendChild(panel);
  }
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

  results.groups = results.groups || {};

  const groupRows = GROUP_MATCHES.map((m) => {
    const r = results.groups[m.id] || {};
    const sh = r.scoreHome ?? "";
    const sa = r.scoreAway ?? "";
    const w = r.winner || "";

    const btn = (val, lab) => `
      <button type="button" class="outcome-btn ${w === val ? "is-selected" : ""}" data-result-pick="${val}" data-match="${m.id}">${lab}</button>`;

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

  root.innerHTML = `
    <h4 style="font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;color:var(--ink-mute);margin:24px 0 8px;text-transform:uppercase">Group stage results</h4>
    ${groupRows}
    <h4 style="font-family:var(--font-mono);font-size:11px;letter-spacing:.2em;color:var(--ink-mute);margin:32px 0 8px;text-transform:uppercase">Knockout results — enter the real scores</h4>
    <p class="panel-sub" style="margin-bottom:14px">Type the actual score of each match; winners advance automatically and players are scored against this. The Final winner is the champion; the play-off winner takes 3rd.</p>
    <div id="admin-ko" class="kb-bracket"></div>`;

  // ---- group results wiring ----
  const adminGroupsDirty = {};

  const saveGroupsDebounced = debounce(async () => {
    const merged = await fetchResults();
    merged.groups = { ...(merged.groups || {}), ...adminGroupsDirty };
    await saveResults(merged);
    renderAdminLeaderboard();
  }, 600);

  $$(".result-row .outcome-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mid = btn.dataset.match;
      $$(`.result-row[data-result-match="${mid}"] .outcome-btn`).forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      adminGroupsDirty[mid] = {
        ...(adminGroupsDirty[mid] || results.groups[mid] || {}),
        winner: btn.dataset.resultPick,
      };
      saveGroupsDebounced();
    });
  });

  $$(".result-row .score-input").forEach((input) => {
    input.addEventListener("input", () => {
      const mid = input.dataset.match;
      const side = input.dataset.resultSide === "home" ? "scoreHome" : "scoreAway";
      const val = input.value === "" ? null : parseInt(input.value, 10) || 0;
      adminGroupsDirty[mid] = { ...(adminGroupsDirty[mid] || results.groups[mid] || {}), [side]: val };

      const p = adminGroupsDirty[mid];
      if (typeof p.scoreHome === "number" && typeof p.scoreAway === "number") {
        p.winner = p.scoreHome > p.scoreAway ? "HOME" : p.scoreHome < p.scoreAway ? "AWAY" : "DRAW";
        $$(`.result-row[data-result-match="${mid}"] .outcome-btn`).forEach((b) => {
          b.classList.toggle("is-selected", b.dataset.resultPick === p.winner);
        });
      }
      saveGroupsDebounced();
    });
  });

  // ---- knockout results wiring (same bracket, admin mode, never locked) ----
  const koAdmin = results.ko ? { ...results.ko } : {};
  const saveKoDebounced = debounce(async () => {
    await saveKoResults(koAdmin);
    renderAdminLeaderboard();
  }, 600);

  paintKoBracket($("#admin-ko"), {
    ko: koAdmin,
    isLocked: () => false,
    onSave: () => saveKoDebounced(),
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

  const claimed = codes.filter((c) => c.claimed).length;
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

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes = new Set();

  while (codes.size < 100) {
    let c = "";

    for (let i = 0; i < 6; i++) {
      c += chars[Math.floor(Math.random() * chars.length)];
    }

    codes.add(c);
  }

  const list = [...codes].sort();

  out.textContent += "Writing to database…\n";

  const codeMap = {};

  list.forEach((code) => {
    codeMap[code] = {
      claimed: false,
      createdAt: serverTimestamp(),
    };
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

  $("#login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    attemptLogin($("#login-code").value, $("#login-name").value);
  });

  $("#btn-signout").addEventListener("click", () => {
    forgetLogin();

    session.code = null;
    session.name = null;
    session.predictions = null;
    session.isTest = false;

    show("view-login");

    $("#login-code").value = "";
    $("#login-name").value = "";
  });

  const modal = $("#modal-no-code");

  $("#btn-no-code").addEventListener("click", () => {
    const subject = encodeURIComponent("FWC26 Pool — Please send me a code");
    const body = encodeURIComponent(
`Hi Ethan,

Could I have a code for the World Cup 2026 predictions pool, please? I know it's free to enter and the winner gets a prize.

My name: 

Thanks!`,
    );

    $("#no-code-mailto").href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    $("#no-code-email-display").textContent = CONTACT_EMAIL;

    modal.classList.remove("hidden");
  });

  $$("[data-close-modal]").forEach((el) => {
    el.addEventListener("click", () => modal.classList.add("hidden"));
  });

  $("#btn-admin").addEventListener("click", gotoAdmin);

  $("#btn-admin-back").addEventListener("click", () => {
    show("view-login");
  });

  $("#admin-pw-form").addEventListener("submit", (e) => {
    e.preventDefault();

    if ($("#admin-pw").value === ADMIN_PASSWORD) {
      unlockAdmin();
    } else {
      $("#admin-pw-error").textContent = "Wrong password.";
      $("#admin-pw-error").hidden = false;
    }
  });

  $("#btn-seed-codes").addEventListener("click", seedCodes);

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

  $$(".app-tabs--admin .app-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".app-tabs--admin .app-tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");

      const t = btn.dataset.adminTab;

      ["leaderboard", "results", "graphs", "codes", "setup"].forEach((key) => {
        $("#admin-tab-" + key).classList.toggle("hidden", key !== t);
      });

      if (t === "leaderboard") renderAdminLeaderboard();
      if (t === "results") renderAdminResults();
      if (t === "graphs") renderAdminGraphs();
      if (t === "codes") renderAdminCodes();
    });
  });
}

document.addEventListener("DOMContentLoaded", init);
