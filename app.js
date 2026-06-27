const STORAGE_KEY = "mahjong_app_ver1_proto";
const FIREBASE_SETTINGS_KEY = "mahjong_app_ver1_firebase";
const FIREBASE_SDK_VERSION = "10.12.5";
const DATE_FORMAT = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit" });
let storageAvailable = true;
let firebaseSettings = loadFirebaseSettings();
let firebaseStatus = "未接続";
let firebaseDb = null;
let firebaseUnsubscribe = null;
let firebaseApplyingRemote = false;
let firebaseWriteTimer = null;

function makeId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

const defaultState = () => ({
  players: [
    { id: makeId(), name: "しげ", order: 1, visible: true, carry: 0, carryTableFee: 0, deleted: false },
    { id: makeId(), name: "おくの", order: 2, visible: true, carry: 0, carryTableFee: 0, deleted: false },
    { id: makeId(), name: "ゆーや", order: 3, visible: true, carry: 0, carryTableFee: 0, deleted: false },
    { id: makeId(), name: "ひろくん", order: 4, visible: true, carry: 0, carryTableFee: 0, deleted: false }
  ],
  settings: {
    sanma: { rate: 5, start: 25000, return: 30000, uma: [10, 0, -10], oka: [15, 0, 0] },
    yonma: { rate: 5, start: 25000, return: 30000, uma: [20, 10, -10, -20], oka: [20, 0, 0, 0] },
    common: { tableFee: 0, rounding: "gosha6nyu", adminPassword: "admin", monitorMode: false }
  },
  sessions: [],
  history: [],
  currentSessionId: null,
  admin: false,
  ui: { showMoney: true, showPoint: true, autoScore: true }
});

let state = loadState();
let pendingTie = null;
let pendingEntryType = null;

document.addEventListener("DOMContentLoaded", () => {
  setupOpeningMovie();
  bindNavigation();
  bindActions();
  ensureSession();
  renderAll();
  initFirebaseSync();
});

function setupOpeningMovie() {
  const overlay = document.getElementById("openingOverlay");
  const video = document.getElementById("openingVideo");
  const skipButton = document.getElementById("skipOpeningButton");
  if (!overlay || !video || !skipButton) return;
  let closing = false;
  const showTitle = () => {
    if (closing) return;
    closing = true;
    overlay.classList.add("show-title");
    video.pause();
    window.setTimeout(() => overlay.classList.add("hide"), 3100);
    window.setTimeout(() => overlay.remove(), 4100);
  };
  video.addEventListener("ended", showTitle);
  video.addEventListener("error", showTitle);
  skipButton.addEventListener("click", showTitle);
  const playAttempt = video.play();
  if (playAttempt?.catch) playAttempt.catch(showTitle);
}

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    storageAvailable = false;
  }
  if (!raw) return defaultState();
  try {
    return normalizeState(JSON.parse(raw));
  } catch {
    return defaultState();
  }
}

function normalizeState(parsed = {}) {
  const base = defaultState();
  return {
    ...base,
    ...parsed,
    admin: false,
    settings: {
      sanma: { ...base.settings.sanma, ...(parsed.settings?.sanma || {}) },
      yonma: { ...base.settings.yonma, ...(parsed.settings?.yonma || {}) },
      common: { ...base.settings.common, ...(parsed.settings?.common || {}) }
    },
    ui: { ...base.ui, ...(parsed.ui || {}) },
    players: Array.isArray(parsed.players) ? parsed.players : base.players,
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : base.sessions,
    history: Array.isArray(parsed.history) ? parsed.history : base.history
  };
}

function saveState(action, detail = {}) {
  if (action) {
    state.history.unshift({
      id: makeId(),
      at: new Date().toISOString(),
      user: state.admin ? "admin" : "user",
      action,
      detail
    });
    state.history = state.history.slice(0, 500);
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageAvailable = false;
  }
  if (!firebaseApplyingRemote) queueFirebaseWrite();
  renderAll();
}

function loadFirebaseSettings() {
  const defaults = {
    enabled: false,
    apiKey: "",
    authDomain: "",
    projectId: "",
    storageBucket: "",
    messagingSenderId: "",
    appId: "",
    docPath: "mahjongApps/main"
  };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(FIREBASE_SETTINGS_KEY) || "{}")) };
  } catch {
    return defaults;
  }
}

function saveFirebaseSettings() {
  try {
    localStorage.setItem(FIREBASE_SETTINGS_KEY, JSON.stringify(firebaseSettings));
  } catch {
    storageAvailable = false;
  }
}

function firebaseConfigReady() {
  return Boolean(firebaseSettings.apiKey && firebaseSettings.authDomain && firebaseSettings.projectId && firebaseSettings.appId && firebaseSettings.docPath);
}

function sharedState() {
  return {
    players: deepClone(state.players),
    settings: deepClone(state.settings),
    sessions: deepClone(state.sessions),
    history: deepClone(state.history)
  };
}

function firebaseDocSegments() {
  return firebaseSettings.docPath.split("/").map(part => part.trim()).filter(Boolean);
}

async function initFirebaseSync() {
  if (firebaseUnsubscribe) {
    firebaseUnsubscribe();
    firebaseUnsubscribe = null;
  }
  firebaseDb = null;
  if (!firebaseSettings.enabled) {
    firebaseStatus = "Firebase未使用";
    renderAll();
    return;
  }
  if (!firebaseConfigReady() || firebaseDocSegments().length % 2 !== 0) {
    firebaseStatus = "Firebase設定未完了";
    renderAll();
    return;
  }
  firebaseStatus = "Firebase接続中";
  renderAll();
  try {
    const appModule = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`);
    const firestoreModule = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`);
    const existingApp = appModule.getApps().find(item => item.name === "mahjong-shared");
    if (existingApp) await appModule.deleteApp(existingApp);
    const app = appModule.initializeApp({
      apiKey: firebaseSettings.apiKey,
      authDomain: firebaseSettings.authDomain,
      projectId: firebaseSettings.projectId,
      storageBucket: firebaseSettings.storageBucket,
      messagingSenderId: firebaseSettings.messagingSenderId,
      appId: firebaseSettings.appId
    }, "mahjong-shared");
    firebaseDb = firestoreModule.getFirestore(app);
    const remoteDoc = firestoreModule.doc(firebaseDb, ...firebaseDocSegments());
    firebaseUnsubscribe = firestoreModule.onSnapshot(remoteDoc, snapshot => {
      if (!snapshot.exists()) {
        queueFirebaseWrite(0);
        return;
      }
      const remote = snapshot.data().state;
      if (!remote) return;
      const localAdmin = state.admin;
      const localUi = deepClone(state.ui);
      const localCurrentSessionId = state.currentSessionId;
      firebaseApplyingRemote = true;
      state = { ...normalizeState(remote), admin: localAdmin, ui: localUi, currentSessionId: localCurrentSessionId };
      ensureSession();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch {
        storageAvailable = false;
      }
      firebaseApplyingRemote = false;
      firebaseStatus = "Firebase同期中";
      renderAll();
    }, error => {
      firebaseStatus = `Firebaseエラー: ${error.message}`;
      renderAll();
    });
    firebaseStatus = "Firebase同期中";
    renderAll();
  } catch (error) {
    firebaseStatus = `Firebaseエラー: ${error.message}`;
    renderAll();
  }
}

function queueFirebaseWrite(delay = 400) {
  if (!firebaseSettings.enabled || !firebaseDb || !firebaseConfigReady()) return;
  clearTimeout(firebaseWriteTimer);
  firebaseWriteTimer = setTimeout(writeFirebaseState, delay);
}

async function writeFirebaseState() {
  if (!firebaseSettings.enabled || !firebaseDb || !firebaseConfigReady()) return;
  try {
    const { doc, setDoc, serverTimestamp } = await import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`);
    await setDoc(doc(firebaseDb, ...firebaseDocSegments()), {
      state: sharedState(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    firebaseStatus = "Firebase同期中";
    renderAll();
  } catch (error) {
    firebaseStatus = `Firebase保存エラー: ${error.message}`;
    renderAll();
  }
}

function bindNavigation() {
  document.querySelectorAll(".bottom-nav button").forEach(button => {
    button.addEventListener("click", () => showScreen(button.dataset.screen));
  });
}

function bindActions() {
  document.getElementById("adminButton").addEventListener("click", () => {
    if (state.admin) {
      state.admin = false;
      saveState("管理者ログアウト");
      return;
    }
    const password = prompt("管理者パスワードを入力してください。");
    if (password === state.settings.common.adminPassword) {
      state.admin = true;
      saveState("管理者ログイン");
    } else if (password !== null) {
      alert("パスワードが違います。");
    }
  });
  document.getElementById("newSessionButton").addEventListener("click", createSession);
  document.getElementById("latestSessionButton").addEventListener("click", openLatestSession);
  document.getElementById("sessionPickerButton").addEventListener("click", () => showScreen("homeScreen"));
  document.getElementById("finishSessionButton").addEventListener("click", finishSession);
  document.getElementById("addRoundButton").addEventListener("click", () => addRound(true));
  document.getElementById("autoScoreButton").addEventListener("click", () => {
    state.ui.autoScore = !state.ui.autoScore;
    const session = currentSession();
    if (state.ui.autoScore && canEditSession(session)) {
      const players = session.participantIds.map(id => state.players.find(player => player.id === id)).filter(Boolean);
      if (players.length === 3 || players.length === 4) {
        session.rounds.forEach(round => {
          if (round.status === "○") return;
          calculateAutoScore(session, round, players);
          validateRound(session, round);
        });
      }
    } else if (session) {
      session.rounds.forEach(round => { round.autoPlayerId = null; });
    }
    saveState();
  });
  document.getElementById("addPlayerButton").addEventListener("click", addPlayer);
  document.getElementById("saveSettingsButton").addEventListener("click", saveSettingsFromForm);
  document.getElementById("toggleMoneyButton").addEventListener("click", () => {
    state.ui.showMoney = !state.ui.showMoney;
    saveState();
  });
  document.getElementById("togglePointButton").addEventListener("click", () => {
    state.ui.showPoint = !state.ui.showPoint;
    saveState();
  });
  document.getElementById("addYakumanButton").addEventListener("click", () => addMoneyRow("yakuman"));
  document.getElementById("addTipButton").addEventListener("click", () => addMoneyRow("tips"));
  document.getElementById("entryDialog").addEventListener("close", handleEntryClose);
  document.getElementById("tieDialog").addEventListener("close", handleTieClose);
  document.getElementById("exportJsonButton").addEventListener("click", exportJson);
  document.getElementById("importJsonInput").addEventListener("change", importJson);
  document.getElementById("jumpTopButton").addEventListener("click", () => document.getElementById("trendBlock").scrollIntoView());
  document.getElementById("jumpLatestButton").addEventListener("click", () => document.querySelector("[data-latest-row]")?.scrollIntoView());
  document.getElementById("monthJump").addEventListener("change", event => {
    document.querySelector(`[data-month="${event.target.value}"]`)?.scrollIntoView();
  });
  document.getElementById("homeJumpTopButton").addEventListener("click", () => {
    document.querySelector("[data-home-session-row]")?.scrollIntoView();
  });
  document.getElementById("homeJumpLatestButton").addEventListener("click", () => {
    document.querySelector("[data-home-latest]")?.scrollIntoView();
  });
  document.getElementById("homeMonthJump").addEventListener("change", event => {
    document.querySelector(`[data-home-month="${event.target.value}"]`)?.scrollIntoView();
  });
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(screen => screen.classList.toggle("active", screen.id === id));
  document.querySelectorAll(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.screen === id));
  renderAll();
}

function activePlayers() {
  return state.players.filter(p => !p.deleted).sort((a, b) => a.order - b.order);
}

function visiblePlayers() {
  return activePlayers().filter(p => p.visible);
}

function playerName(id) {
  return state.players.find(p => p.id === id)?.name || "不明";
}

function ensureSession() {
  if (!state.currentSessionId && state.sessions.length) {
    const sessions = sortedSessions();
    state.currentSessionId = sessions[sessions.length - 1].id;
  }
}

function currentSession() {
  return state.sessions.find(s => s.id === state.currentSessionId) || null;
}

function sortedSessions() {
  return state.sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => {
      const dateCompare = String(a.session.date || "").localeCompare(String(b.session.date || ""));
      if (dateCompare !== 0) return dateCompare;
      const createdCompare = String(a.session.createdAt || "").localeCompare(String(b.session.createdAt || ""));
      return createdCompare !== 0 ? createdCompare : a.index - b.index;
    })
    .map(item => item.session);
}

function canEditSession(session) {
  if (!session) return false;
  if (state.settings.common.monitorMode && !state.admin) return false;
  return session.status !== "終了" || state.admin;
}

function createSession() {
  if (state.settings.common.monitorMode && !state.admin) {
    alert("モニターモード中は新規開催できません。");
    return;
  }
  const players = visiblePlayers();
  if (players.length < 3) {
    alert("参加可能な登録プレイヤーが3人以上必要です。");
    return;
  }
  const selected = players.slice(0, Math.min(players.length, 4)).map(p => p.id);
  const session = {
    id: makeId(),
    date: new Date().toISOString().slice(0, 10),
    createdAt: new Date().toISOString(),
    status: "進行中",
    participantIds: selected,
    settingsSnapshot: deepClone(state.settings),
    rounds: [],
    yakuman: [],
    tips: [],
    yakumanRows: [],
    tipRows: []
  };
  state.sessions.push(session);
  state.currentSessionId = session.id;
  addRound(false, session);
  saveState("開催追加", { date: session.date });
  showScreen("dailyScreen");
}

function openLatestSession() {
  if (!state.sessions.length) createSession();
  const sessions = sortedSessions();
  if (!sessions.length) return;
  state.currentSessionId = sessions[sessions.length - 1].id;
  showScreen("dailyScreen");
}

function addRound(shouldSave = true, session = currentSession()) {
  if (!canEditSession(session)) return;
  session.rounds.push({
    id: makeId(),
    scores: {},
    status: "－",
    message: "",
    result: null,
    tieOrder: {}
  });
  if (shouldSave) saveState("荘数追加", { sessionId: session.id });
}

function finishSession() {
  const session = currentSession();
  if (!session || session.status === "終了") return;
  const bad = session.rounds.some(r => r.status === "△" || r.status === "×");
  if (bad) {
    alert("△または×の荘があるため終了できません。");
    return;
  }
  const moneyErrors = moneyBalanceErrors(session);
  if (moneyErrors.length) {
    alert("役満または祝儀の合計が0ではない行があるため終了できません。");
    return;
  }
  if (!confirm("対局を終了します。よろしいですか？")) return;
  session.status = "終了";
  saveState("開催終了", { sessionId: session.id, date: session.date });
}

function addPlayer() {
  if (!state.admin) return;
  const name = prompt("プレイヤー名を入力してください。");
  if (!name) return;
  const maxOrder = Math.max(0, ...state.players.map(p => p.order || 0));
  state.players.push({ id: makeId(), name, order: maxOrder + 1, visible: true, carry: 0, carryTableFee: 0, deleted: false });
  saveState("プレイヤー追加", { name });
}

function renderAll() {
  document.getElementById("adminButton").textContent = state.admin ? "管理者ログアウト" : "管理者ログイン";
  const storageLabel = firebaseSettings.enabled ? firebaseStatus : (storageAvailable ? "ローカル保存" : "端末内一時保存");
  const monitorLabel = state.settings.common.monitorMode ? " / モニターモード" : "";
  document.getElementById("syncStatus").textContent = state.admin ? `管理者モード / ${storageLabel}${monitorLabel}` : `${storageLabel}${monitorLabel}`;
  document.getElementById("newSessionButton").disabled = state.settings.common.monitorMode && !state.admin;
  document.getElementById("addPlayerButton").disabled = !state.admin;
  document.getElementById("saveSettingsButton").disabled = !state.admin;
  document.getElementById("exportJsonButton").disabled = !state.admin;
  document.getElementById("importJsonInput").disabled = !state.admin;
  renderHome();
  renderDaily();
  renderTotal();
  renderPlayers();
  renderSettings();
  renderHistory();
}

function renderHome() {
  const list = document.getElementById("sessionList");
  list.innerHTML = "";
  if (!state.sessions.length) {
    list.innerHTML = `<div class="muted">開催がありません。</div>`;
    return;
  }
  const sessions = sortedSessions();
  sessions.forEach((session, index) => {
    const item = document.createElement("div");
    item.className = "list-item";
    item.dataset.homeSessionRow = session.id;
    item.dataset.homeMonth = session.date.slice(0, 7);
    if (index === sessions.length - 1) item.dataset.homeLatest = "true";
    const completedRounds = session.rounds.filter(round => round.status === "○").length;
    const eventLabels = sessionEventLabels(session);
    const metaItems = [`第${kanjiNumber(index + 1)}回`, session.status, `${session.participantIds.length}人`, `${completedRounds}荘`, ...eventLabels];
    item.innerHTML = `<div><strong>${session.date}</strong><div class="meta">${metaItems.join(" / ")}</div></div>`;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "開く";
    button.addEventListener("click", () => {
      state.currentSessionId = session.id;
      showScreen("dailyScreen");
    });
    item.append(button);
    list.append(item);
  });
}

function renderDaily() {
  const session = currentSession();
  if (!session) {
    document.getElementById("dailyMeta").textContent = "開催がありません。";
    return;
  }
  ensureMoneyRows(session);
  const finished = session.status === "終了";
  document.getElementById("dailyMeta").innerHTML = `
    <span class="daily-meta-item">${session.date}</span>
    <span class="session-status ${finished ? "finished" : "active"}">${session.status}</span>
    <span class="daily-meta-item">参加 ${session.participantIds.length}人</span>
  `;
  const editable = canEditSession(session);
  document.getElementById("finishSessionButton").disabled = finished || !editable;
  document.getElementById("addRoundButton").disabled = !editable;
  document.getElementById("addYakumanButton").disabled = !editable;
  document.getElementById("addTipButton").disabled = !editable;
  const autoButton = document.getElementById("autoScoreButton");
  autoButton.textContent = `自動入力 ${state.ui.autoScore ? "ON" : "OFF"}`;
  autoButton.classList.toggle("off", !state.ui.autoScore);
  autoButton.disabled = !editable;
  renderParticipantPanel(session);
  renderScoreTable(session);
  renderMoneyTable(session);
  renderPointTable(session);
  renderRankBlock(session);
  renderMoneyEntryTable(session, "yakumanRows", "yakumanList", "役満名等");
  renderMoneyEntryTable(session, "tipRows", "tipList", "祝儀メモ");
  renderFinalBlock(session);
}

function renderParticipantPanel(session) {
  const panel = document.getElementById("participantPanel");
  const editable = canEditSession(session);
  const checks = visiblePlayers().map(p => {
    const checked = session.participantIds.includes(p.id) ? "checked" : "";
    return `<label class="check-label"><input data-participant="${p.id}" type="checkbox" ${checked} ${editable ? "" : "disabled"}>${p.name}</label>`;
  }).join("");
  panel.innerHTML = `<h3>参加者選択</h3><div class="participant-grid">${checks}</div>`;
  panel.querySelectorAll("[data-participant]").forEach(input => {
    input.addEventListener("change", () => {
      if (!canEditSession(session)) return;
      const id = input.dataset.participant;
      if (input.checked) session.participantIds.push(id);
      else session.participantIds = session.participantIds.filter(pid => pid !== id);
      saveState("参加者変更", { sessionId: session.id });
    });
  });
}

function renderScoreTable(session) {
  const players = session.participantIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const editable = canEditSession(session);
  const autoEnabled = state.ui.autoScore && (players.length === 3 || players.length === 4);
  const html = [`<table><thead><tr><th class="fixed-col">状態</th><th class="fixed-col second">荘数</th>${players.map(p => `<th>${p.name}</th>`).join("")}<th>判定</th><th>削除</th></tr></thead><tbody>`];
  session.rounds.forEach((round, index) => {
    if (autoEnabled && round.status !== "○") calculateAutoScore(session, round, players);
    html.push(`<tr><td class="fixed-col ${statusClass(round.status)}">${round.status}</td><td class="fixed-col second">${index + 1}</td>`);
    players.forEach(p => {
      const value = round.scores[p.id] ?? "";
      const isAuto = autoEnabled && p.id === round.autoPlayerId;
      const negativeClass = Number(value) < 0 ? "negative-input" : "";
      const rank = round.status === "○" ? round.result?.find(result => result.playerId === p.id)?.displayRank : null;
      html.push(`<td><div class="score-cell-content"><span class="rank-badge">${rankSymbol(rank)}</span><input class="score-input ${negativeClass} ${isAuto ? "auto-score" : ""}" data-round="${round.id}" data-player="${p.id}" type="text" inputmode="numeric" value="${value}" ${editable ? "" : "disabled"}></div></td>`);
    });
    html.push(`<td class="${round.status === "×" ? "negative" : "muted"}">${round.message || ""}</td><td><button data-delete-round="${round.id}" type="button" ${editable ? "" : "disabled"}>削除</button></td></tr>`);
  });
  html.push("</tbody></table>");
  const scoreBlock = document.getElementById("scoreBlock");
  scoreBlock.innerHTML = html.join("");
  scoreBlock.querySelectorAll(".score-input").forEach(input => {
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      input.blur();
    });
    input.addEventListener("input", () => {
      if (!canEditSession(session)) return;
      const round = session.rounds.find(r => r.id === input.dataset.round);
      if (!round) return;
      if (round.autoPlayerId === input.dataset.player) round.autoPlayerId = null;
      const parsedScore = parseSignedNumberInput(input.value);
      if (parsedScore.empty) delete round.scores[input.dataset.player];
      if (parsedScore.incomplete) {
        updateNegativeInput(input);
        return;
      }
      if (!parsedScore.valid) return;
      round.scores[input.dataset.player] = parsedScore.value;
      updateNegativeInput(input);
      if (autoEnabled) {
        calculateAutoScore(session, round, players);
        scoreBlock.querySelectorAll(`[data-round="${round.id}"]`).forEach(roundInput => {
          roundInput.value = round.scores[roundInput.dataset.player] ?? "";
          roundInput.classList.toggle("auto-score", roundInput.dataset.player === round.autoPlayerId);
          updateNegativeInput(roundInput);
        });
      }
    });
    input.addEventListener("focus", () => {
      const round = session.rounds.find(r => r.id === input.dataset.round);
      if (round?.autoPlayerId === input.dataset.player) input.select();
      markEditing(session, input.dataset.round);
    });
    input.addEventListener("blur", () => {
      if (!canEditSession(session)) return;
      const round = session.rounds.find(r => r.id === input.dataset.round);
      if (!round) return;
      const parsedScore = parseSignedNumberInput(input.value);
      if (parsedScore.empty || parsedScore.incomplete || !parsedScore.valid) {
        delete round.scores[input.dataset.player];
        input.value = "";
      } else {
        round.scores[input.dataset.player] = parsedScore.value;
      }
      validateRound(session, round);
      ensureTrailingRound(session);
      saveState("荘数修正", { sessionId: session.id, roundId: round.id });
    });
  });
  scoreBlock.querySelectorAll("[data-delete-round]").forEach(button => {
    button.addEventListener("click", () => {
      if (!canEditSession(session)) return;
      session.rounds = session.rounds.filter(r => r.id !== button.dataset.deleteRound);
      if (!session.rounds.length) addRound(false, session);
      saveState("荘数削除", { sessionId: session.id });
    });
  });
}

function calculateAutoScore(session, round, players) {
  if (round.status === "○") return null;
  const playerIds = players.map(player => player.id);
  if (round.autoPlayerId && !playerIds.includes(round.autoPlayerId)) {
    delete round.scores[round.autoPlayerId];
    round.autoPlayerId = null;
  }
  if (round.autoPlayerId && playerIds.includes(round.autoPlayerId)) {
    const otherIds = playerIds.filter(id => id !== round.autoPlayerId);
    const hasAllOtherScores = otherIds.every(id => round.scores[id] !== undefined && round.scores[id] !== "");
    if (hasAllOtherScores) {
      const game = players.length === 3 ? "sanma" : "yonma";
      const totalPoints = session.settingsSnapshot[game].start * players.length;
      const enteredTotal = otherIds.reduce((sum, id) => sum + Number(round.scores[id] || 0), 0);
      round.scores[round.autoPlayerId] = totalPoints - enteredTotal;
      return round.autoPlayerId;
    }
    delete round.scores[round.autoPlayerId];
    round.autoPlayerId = null;
  }
  const blankIds = playerIds.filter(id => round.scores[id] === undefined || round.scores[id] === "");
  if (blankIds.length !== 1) return null;
  const autoPlayerId = blankIds[0];
  const otherIds = playerIds.filter(id => id !== autoPlayerId);
  const game = players.length === 3 ? "sanma" : "yonma";
  const totalPoints = session.settingsSnapshot[game].start * players.length;
  const enteredTotal = otherIds.reduce((sum, id) => sum + Number(round.scores[id] || 0), 0);
  round.scores[autoPlayerId] = totalPoints - enteredTotal;
  round.autoPlayerId = autoPlayerId;
  return autoPlayerId;
}

function rankSymbol(rank) {
  return ({ 1: "👑", 2: "②", 3: "③", 4: "④" })[rank] || "";
}

function kanjiNumber(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 9999) return String(value);
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const units = [
    { value: 1000, label: "千" },
    { value: 100, label: "百" },
    { value: 10, label: "十" }
  ];
  let remaining = number;
  let text = "";
  units.forEach(unit => {
    const count = Math.floor(remaining / unit.value);
    if (!count) return;
    text += `${count === 1 ? "" : digits[count]}${unit.label}`;
    remaining %= unit.value;
  });
  return text + digits[remaining];
}

function sessionEventLabels(session) {
  const labels = [];
  if (hasMoneyEntry(session.yakumanRows)) labels.push("役満");
  if (hasMoneyEntry(session.tipRows)) labels.push("祝儀");
  return labels;
}

function hasMoneyEntry(rows) {
  return (rows || []).some(row => {
    const hasMemo = String(row.memo || "").trim() !== "";
    const hasAmount = Object.values(row.amounts || {}).some(value => value !== "" && value !== null && value !== undefined && Number(value) !== 0);
    return hasMemo || hasAmount;
  });
}

function hasMoneyRowEntry(row) {
  const hasMemo = String(row.memo || "").trim() !== "";
  const hasAmount = Object.values(row.amounts || {}).some(value => value !== "" && value !== null && value !== undefined && Number(value) !== 0);
  return hasMemo || hasAmount;
}

function moneyRowTotal(row) {
  return Object.values(row.amounts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function moneyRowStatus(row) {
  if (!hasMoneyRowEntry(row)) return { status: "－", message: "" };
  const total = moneyRowTotal(row);
  if (total === 0) return { status: "○", message: "正常" };
  return { status: "×", message: `合計 ${total.toLocaleString()} / 必要 0` };
}

function moneyBalanceErrors(session) {
  ensureMoneyRows(session);
  return [
    ...session.yakumanRows.map(row => ({ type: "役満", row, ...moneyRowStatus(row) })),
    ...session.tipRows.map(row => ({ type: "祝儀", row, ...moneyRowStatus(row) }))
  ].filter(item => item.status === "×");
}

function updateNegativeInput(input) {
  input.classList.toggle("negative-input", input.value !== "" && Number(input.value) < 0);
}

function parseSignedNumberInput(value) {
  const text = String(value).trim();
  if (text === "") return { empty: true, incomplete: false, valid: false, value: null };
  if (text === "-") return { empty: false, incomplete: true, valid: false, value: null };
  if (!/^-?\d+$/.test(text)) return { empty: false, incomplete: false, valid: false, value: null };
  return { empty: false, incomplete: false, valid: true, value: Number(text) };
}

function markEditing(session, roundId) {
  const round = session.rounds.find(r => r.id === roundId);
  if (!round) return;
  round.status = "△";
  round.message = "編集中";
}

function ensureTrailingRound(session) {
  const last = session.rounds[session.rounds.length - 1];
  if (last && Object.keys(last.scores).length > 0) addRound(false, session);
}

function validateRound(session, round) {
  const entries = Object.entries(round.scores).filter(([, v]) => v !== "" && Number.isFinite(Number(v)));
  if (entries.length === 0) {
    round.status = "－";
    round.message = "";
    round.result = null;
    return;
  }
  if (entries.length < 3) {
    round.status = "×";
    round.message = "入力人数不足";
    round.result = null;
    return;
  }
  if (entries.length > 4) {
    round.status = "×";
    round.message = "1荘は3人または4人です";
    round.result = null;
    return;
  }
  const game = entries.length === 3 ? "sanma" : "yonma";
  const settings = session.settingsSnapshot[game];
  const expected = settings.start * entries.length;
  const total = entries.reduce((sum, [, score]) => sum + Number(score), 0);
  if (total !== expected) {
    round.status = "×";
    round.message = `${game === "sanma" ? "サンマ" : "ヨンマ"}合計 ${total.toLocaleString()} / 必要 ${expected.toLocaleString()}`;
    round.result = null;
    return;
  }
  const scores = entries.map(([playerId, score]) => ({ playerId, score: Number(score) }));
  const tiedScores = scores.filter(item => scores.filter(x => x.score === item.score).length > 1);
  if (tiedScores.length && !hasTieOrder(round, tiedScores)) {
    pendingTie = { sessionId: session.id, roundId: round.id, tiedScores };
    round.status = "△";
    round.message = "同点順位を選択してください";
    round.result = null;
    openTieDialog(tiedScores);
    return;
  }
  const ranked = rankScores(round, scores);
  round.result = calculateRoundResult(ranked, settings, session.settingsSnapshot.common, game);
  round.status = "○";
  round.message = game === "sanma" ? "正常サンマ" : "正常ヨンマ";
}

function hasTieOrder(round, tiedScores) {
  return tiedScores.every(item => round.tieOrder[item.playerId]);
}

function rankScores(round, scores) {
  return scores.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (round.tieOrder[a.playerId] || 99) - (round.tieOrder[b.playerId] || 99);
  }).map((item, index) => ({ ...item, rank: index + 1 }));
}

function calculateRoundResult(ranked, settings, common, game) {
  const rateYen = settings.rate * 10;
  const top = ranked[0]?.playerId;
  const scoreRounding = common.rounding === "excel" ? "gosha6nyu" : common.rounding;
  const results = ranked.map(item => {
    const roundedScore = roundScore(item.score, scoreRounding);
    const basePoint = (roundedScore - settings.return) / 1000;
    const uma = settings.uma[item.rank - 1] || 0;
    const oka = settings.oka[item.rank - 1] || 0;
    const point = basePoint + uma + oka;
    return {
      playerId: item.playerId,
      score: item.score,
      roundedScore,
      rank: game === "sanma" && item.rank === 3 ? 4 : item.rank,
      displayRank: item.rank,
      point,
      money: Math.round(point * rateYen),
      tableFee: item.playerId === top ? common.tableFee : 0,
      game
    };
  });
  if (common.rounding === "excel") {
    const topResult = results.find(result => result.playerId === top);
    const othersTotal = results
      .filter(result => result.playerId !== top)
      .reduce((sum, result) => sum + result.point, 0);
    topResult.point = Math.abs(othersTotal);
    topResult.money = Math.round(topResult.point * rateYen);
  }
  return results;
}

function roundScore(score, rounding) {
  const sign = score < 0 ? -1 : 1;
  const absolute = Math.abs(Number(score) || 0);
  const thousands = Math.floor(absolute / 1000) * 1000;
  const remainder = absolute - thousands;
  const threshold = rounding === "round" ? 500 : 600;
  return sign * (remainder >= threshold ? thousands + 1000 : thousands);
}

function openTieDialog(tiedScores) {
  document.getElementById("tieMessage").textContent = `${tiedScores.map(x => playerName(x.playerId)).join("、")} が同点です。上位から順に番号を選んでください。`;
  document.getElementById("tieChoices").innerHTML = tiedScores.map((item, index) => `
    <label>${playerName(item.playerId)}
      <select data-tie-player="${item.playerId}">
        ${tiedScores.map((_, rank) => `<option value="${rank + 1}" ${rank === index ? "selected" : ""}>${rank + 1}</option>`).join("")}
      </select>
    </label>
  `).join("");
  const dialog = document.getElementById("tieDialog");
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  const session = state.sessions.find(item => item.id === pendingTie?.sessionId);
  const round = session?.rounds.find(item => item.id === pendingTie?.roundId);
  if (!round) return;
  tiedScores.forEach((item, index) => {
    const answer = prompt(`${playerName(item.playerId)}の同点内順位を入力してください。`, String(index + 1));
    round.tieOrder[item.playerId] = Number(answer) || index + 1;
  });
  pendingTie = null;
  validateRound(session, round);
  saveState("同点順位確定", { roundId: round.id });
}

function handleTieClose(event) {
  if (!pendingTie || event.target.returnValue !== "apply") {
    pendingTie = null;
    return;
  }
  const session = state.sessions.find(s => s.id === pendingTie.sessionId);
  const round = session?.rounds.find(r => r.id === pendingTie.roundId);
  if (!round) return;
  document.querySelectorAll("[data-tie-player]").forEach(select => {
    round.tieOrder[select.dataset.tiePlayer] = Number(select.value);
  });
  pendingTie = null;
  validateRound(session, round);
  saveState("同点順位確定", { roundId: round.id });
}

function renderMoneyTable(session) {
  document.getElementById("toggleMoneyButton").textContent = state.ui.showMoney ? "折りたたみ" : "表示";
  document.getElementById("moneyBlock").style.display = state.ui.showMoney ? "block" : "none";
  renderResultTable("moneyBlock", session, "money", "円");
}

function renderPointTable(session) {
  document.getElementById("togglePointButton").textContent = state.ui.showPoint ? "折りたたみ" : "表示";
  document.getElementById("pointBlock").style.display = state.ui.showPoint ? "block" : "none";
  renderResultTable("pointBlock", session, "point", "P");
}

function renderResultTable(targetId, session, key, unit) {
  const players = session.participantIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const totals = Object.fromEntries(players.map(p => [p.id, 0]));
  const rows = session.rounds.filter(r => r.result).map((round, index) => {
    const values = Object.fromEntries(round.result.map(r => [r.playerId, r[key]]));
    players.forEach(p => totals[p.id] += values[p.id] || 0);
    return `<tr><td class="fixed-col">${index + 1}</td>${players.map(p => `<td>${formatNumber(values[p.id], unit)}</td>`).join("")}</tr>`;
  }).join("");
  document.getElementById(targetId).innerHTML = `<table><thead><tr><th class="fixed-col">荘数</th>${players.map(p => `<th>${p.name}</th>`).join("")}</tr></thead><tbody>${rows}<tr><th class="fixed-col">合計</th>${players.map(p => `<th>${formatNumber(totals[p.id], unit)}</th>`).join("")}</tr></tbody></table>`;
}

function renderRankBlock(session) {
  const players = session.participantIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const stats = aggregateSession(session);
  const rows = ["1位", "2位", "3位", "ラス"].map(label => {
    const key = label === "ラス" ? 4 : Number(label[0]);
    return `<tr><th class="fixed-col">${label}</th>${players.map(p => `<td>${stats.rankCounts[p.id]?.[key] || 0}</td>`).join("")}</tr>`;
  }).join("");
  document.getElementById("rankBlock").innerHTML = `<table><thead><tr><th class="fixed-col">項目</th>${players.map(p => `<th>${p.name}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function ensureMoneyRows(session) {
  if (!session.yakumanRows) session.yakumanRows = [];
  if (!session.tipRows) session.tipRows = [];
  if (session.yakuman?.length) {
    session.yakuman.forEach(entry => {
      session.yakumanRows.push({ id: makeId(), memo: entry.memo || "", amounts: { [entry.playerId]: entry.amount || 0 } });
    });
    session.yakuman = [];
  }
  if (session.tips?.length) {
    session.tips.forEach(entry => {
      session.tipRows.push({ id: makeId(), memo: entry.memo || "", amounts: { [entry.playerId]: entry.amount || 0 } });
    });
    session.tips = [];
  }
}

function addMoneyRow(type) {
  const session = currentSession();
  if (!canEditSession(session)) return;
  ensureMoneyRows(session);
  const key = type === "yakuman" ? "yakumanRows" : "tipRows";
  session[key].push({ id: makeId(), memo: "", amounts: {} });
  saveState(`${type === "yakuman" ? "役満" : "祝儀"}行追加`, { sessionId: session.id });
}

function renderMoneyEntryTable(session, key, targetId, memoLabel) {
  const container = document.getElementById(targetId);
  const editable = canEditSession(session);
  const players = session.participantIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const rows = session[key] || [];
  if (!rows.length) {
    container.innerHTML = `<div class="muted">入力なし</div>`;
    return;
  }
  const html = [`<div class="table-wrap"><table><thead><tr><th class="fixed-col">${memoLabel}</th>${players.map(p => `<th>${p.name}</th>`).join("")}<th>判定</th><th>削除</th></tr></thead><tbody>`];
  rows.forEach(row => {
    const rowStatus = moneyRowStatus(row);
    html.push(`<tr><td class="fixed-col"><input data-money-memo="${key}:${row.id}" value="${escapeHtml(row.memo || "")}" placeholder="自由入力" ${editable ? "" : "disabled"}></td>`);
    players.forEach(player => {
      const value = row.amounts?.[player.id] ?? "";
      html.push(`<td><input class="score-input ${Number(value) < 0 ? "negative-input" : ""}" data-money-amount="${key}:${row.id}:${player.id}" type="text" inputmode="numeric" value="${value}" ${editable ? "" : "disabled"}></td>`);
    });
    html.push(`<td class="${rowStatus.status === "×" ? "negative" : "muted"}"><span class="${statusClass(rowStatus.status)}">${rowStatus.status}</span> ${rowStatus.message}</td><td><button data-money-delete="${key}:${row.id}" type="button" ${editable ? "" : "disabled"}>削除</button></td></tr>`);
  });
  html.push(`</tbody></table></div>`);
  container.innerHTML = html.join("");
  container.querySelectorAll("[data-money-memo]").forEach(input => {
    input.addEventListener("change", () => {
      if (!canEditSession(session)) return;
      const [rowKey, rowId] = input.dataset.moneyMemo.split(":");
      const row = session[rowKey].find(item => item.id === rowId);
      row.memo = input.value;
      saveState(rowKey === "yakumanRows" ? "役満修正" : "祝儀修正", { sessionId: session.id });
    });
  });
  container.querySelectorAll("[data-money-amount]").forEach(input => {
    input.addEventListener("input", () => updateNegativeInput(input));
    input.addEventListener("change", () => {
      if (!canEditSession(session)) return;
      const [rowKey, rowId, playerId] = input.dataset.moneyAmount.split(":");
      const row = session[rowKey].find(item => item.id === rowId);
      if (!row.amounts) row.amounts = {};
      const parsedAmount = parseSignedNumberInput(input.value);
      if (parsedAmount.empty || parsedAmount.incomplete || !parsedAmount.valid) {
        delete row.amounts[playerId];
        input.value = "";
      } else {
        row.amounts[playerId] = parsedAmount.value;
      }
      saveState(rowKey === "yakumanRows" ? "役満修正" : "祝儀修正", { sessionId: session.id });
    });
  });
  container.querySelectorAll("[data-money-delete]").forEach(button => {
    button.addEventListener("click", () => {
      if (!canEditSession(session)) return;
      const [rowKey, rowId] = button.dataset.moneyDelete.split(":");
      session[rowKey] = session[rowKey].filter(item => item.id !== rowId);
      saveState(rowKey === "yakumanRows" ? "役満削除" : "祝儀削除", { sessionId: session.id });
    });
  });
}

function handleEntryClose(event) {
  if (event.target.returnValue !== "apply" || !pendingEntryType) return;
  pendingEntryType = null;
}

function renderFinalBlock(session) {
  const players = session.participantIds.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  const stats = aggregateSession(session);
  const finalValues = Object.fromEntries(players.map(p => [p.id, (stats.money[p.id] || 0) + (stats.yakuman[p.id] || 0) + (stats.tips[p.id] || 0)]));
  const finalRanks = rankByValue(players, finalValues);
  const rows = [
    ["金額履歴合計", p => stats.money[p.id] || 0],
    ["役満差引", p => stats.yakuman[p.id] || 0],
    ["祝儀差引", p => stats.tips[p.id] || 0],
    ["場代", p => stats.tableFee[p.id] || 0],
    ["最終収支", p => finalValues[p.id]]
  ].map(([label, fn]) => `<tr><th class="fixed-col">${label}</th>${players.map(p => {
    const rank = label === "最終収支" ? `<span class="final-rank-badge">${rankSymbol(finalRanks[p.id])}</span>` : "";
    return `<td>${rank}${formatNumber(fn(p), "円")}</td>`;
  }).join("")}</tr>`).join("");
  document.getElementById("finalBlock").innerHTML = `<table><thead><tr><th class="fixed-col">項目</th>${players.map(p => `<th>${p.name}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function rankByValue(players, values) {
  return players
    .map((player, order) => ({ playerId: player.id, value: Number(values[player.id] || 0), order }))
    .sort((a, b) => b.value - a.value || a.order - b.order)
    .reduce((ranks, item, index) => ({ ...ranks, [item.playerId]: index + 1 }), {});
}

function aggregateSession(session) {
  const ids = session.participantIds;
  const base = Object.fromEntries(ids.map(id => [id, 0]));
  const rankCounts = Object.fromEntries(ids.map(id => [id, { 1: 0, 2: 0, 3: 0, 4: 0 }]));
  const gameRanks = Object.fromEntries(ids.map(id => [id, { sanma: [], yonma: [] }]));
  const stats = {
    money: { ...base },
    point: { ...base },
    tableFee: { ...base },
    yakuman: { ...base },
    yakumanIncome: { ...base },
    yakumanExpense: { ...base },
    tips: { ...base },
    tipIncome: { ...base },
    tipExpense: { ...base },
    rankCounts,
    gameRanks,
    games: Object.fromEntries(ids.map(id => [id, { sanma: 0, yonma: 0 }]))
  };
  session.rounds.forEach(round => {
    round.result?.forEach(result => {
      stats.money[result.playerId] += result.money;
      stats.point[result.playerId] += result.point;
      stats.tableFee[result.playerId] += result.tableFee;
      stats.rankCounts[result.playerId][result.rank] += 1;
      stats.gameRanks[result.playerId][result.game].push(result.displayRank);
      stats.games[result.playerId][result.game] += 1;
    });
  });
  ensureMoneyRows(session);
  session.yakumanRows.forEach(row => {
    Object.entries(row.amounts || {}).forEach(([playerId, amount]) => {
      const value = Number(amount || 0);
      stats.yakuman[playerId] = (stats.yakuman[playerId] || 0) + value;
      if (value > 0) stats.yakumanIncome[playerId] = (stats.yakumanIncome[playerId] || 0) + value;
      if (value < 0) stats.yakumanExpense[playerId] = (stats.yakumanExpense[playerId] || 0) + value;
    });
  });
  session.tipRows.forEach(row => {
    Object.entries(row.amounts || {}).forEach(([playerId, amount]) => {
      const value = Number(amount || 0);
      stats.tips[playerId] = (stats.tips[playerId] || 0) + value;
      if (value > 0) stats.tipIncome[playerId] = (stats.tipIncome[playerId] || 0) + value;
      if (value < 0) stats.tipExpense[playerId] = (stats.tipExpense[playerId] || 0) + value;
    });
  });
  return stats;
}

function renderTotal() {
  const players = activePlayers();
  document.getElementById("trendAdminNote").hidden = !state.admin;
  renderTrend(players);
  renderPersonal(players);
}

function renderTrend(players) {
  const sessions = sortedSessions();
  const rows = sessions.map((session, index) => {
    const stats = aggregateSession(session);
    const latest = index === sessions.length - 1 ? "data-latest-row" : "";
    const openButton = `<button class="session-link" data-open-session="${session.id}" type="button">${session.date}</button>`;
    const dateCell = state.admin
      ? `<div class="date-cell-tools">${openButton}<input data-session-date="${session.id}" type="date" value="${session.date}" aria-label="${session.date}の開催日を変更"></div>`
      : openButton;
    const deleteCell = state.admin ? `<td><button data-session-delete="${session.id}" type="button">削除</button></td>` : "";
    return `<tr ${latest} data-month="${session.date.slice(0, 7)}"><th class="fixed-col">${dateCell}</th>${players.map(p => `<td title="金額履歴合計 + 役満差引 + 祝儀差引">${formatNumber((stats.money[p.id] || 0) + (stats.yakuman[p.id] || 0) + (stats.tips[p.id] || 0), "円")}</td>`).join("")}${deleteCell}</tr>`;
  }).join("");
  const totals = Object.fromEntries(players.map(p => [p.id, 0]));
  sessions.forEach(session => {
    const stats = aggregateSession(session);
    players.forEach(p => totals[p.id] += (stats.money[p.id] || 0) + (stats.yakuman[p.id] || 0) + (stats.tips[p.id] || 0));
  });
  const adminHead = state.admin ? "<th>操作</th>" : "";
  const adminFoot = state.admin ? "<th></th>" : "";
  document.getElementById("trendBlock").innerHTML = `<table><thead><tr><th class="fixed-col">開催日</th>${players.map(p => `<th>${p.name}</th>`).join("")}${adminHead}</tr></thead><tbody>${rows}<tr><th class="fixed-col">合計</th>${players.map(p => `<th>${formatNumber(totals[p.id], "円")}</th>`).join("")}${adminFoot}</tr></tbody></table>`;
  document.querySelectorAll("[data-open-session]").forEach(button => {
    button.addEventListener("click", () => {
      state.currentSessionId = button.dataset.openSession;
      showScreen("dailyScreen");
    });
  });
  document.querySelectorAll("[data-session-date]").forEach(input => {
    input.addEventListener("change", () => {
      if (!state.admin) return;
      const session = state.sessions.find(item => item.id === input.dataset.sessionDate);
      if (!session) return;
      if (!input.value) {
        alert("開催日は空欄にできません。");
        renderTotal();
        return;
      }
      session.date = input.value;
      saveState("開催日変更", { sessionId: session.id, date: session.date });
    });
  });
  document.querySelectorAll("[data-session-delete]").forEach(button => {
    button.addEventListener("click", () => {
      if (!state.admin) return;
      const session = state.sessions.find(item => item.id === button.dataset.sessionDelete);
      if (!session) return;
      if (!confirm(`${session.date} の開催を削除します。履歴には削除操作を残します。`)) return;
      state.sessions = state.sessions.filter(item => item.id !== session.id);
      if (state.currentSessionId === session.id) {
        const remainingSessions = sortedSessions();
        const latestSession = remainingSessions[remainingSessions.length - 1];
        state.currentSessionId = latestSession ? latestSession.id : null;
      }
      saveState("開催削除", { sessionId: session.id, date: session.date });
    });
  });
}

function renderPersonal(players) {
  const total = aggregateAll(players);
  const rows = [
    ["繰越金", "円", p => p.carry],
    ["繰越場代", "円", p => p.carryTableFee],
    ["場代抜き残高", "円", p => p.carry + total.final[p.id]],
    ["場代込残高", "円", p => p.carry + total.final[p.id] - total.tableFee[p.id] - p.carryTableFee],
    ["累計場代", "円", p => total.tableFee[p.id]],
    ["最高獲得額", "円", p => total.best[p.id]?.amount ?? 0],
    ["最高獲得日", "", p => total.best[p.id]?.date ?? ""],
    ["最低獲得額", "円", p => total.worst[p.id]?.amount ?? 0],
    ["最低獲得日", "", p => total.worst[p.id]?.date ?? ""],
    ["役満収入", "円", p => total.yakumanIncome[p.id]],
    ["役満支出", "円", p => total.yakumanExpense[p.id]],
    ["役満差引", "円", p => total.yakuman[p.id]],
    ["祝儀収入", "円", p => total.tipIncome[p.id]],
    ["祝儀支出", "円", p => total.tipExpense[p.id]],
    ["祝儀差引", "円", p => total.tips[p.id]],
    ["1位", "回", p => total.rankCounts[p.id][1]],
    ["2位", "回", p => total.rankCounts[p.id][2]],
    ["3位", "回", p => total.rankCounts[p.id][3]],
    ["ラス", "回", p => total.rankCounts[p.id][4]],
    ["ヨンマ荘数", "回", p => total.games[p.id].yonma],
    ["サンマ荘数", "回", p => total.games[p.id].sanma],
    ["参戦日数", "日", p => total.days[p.id].size],
    ["平均順位(ヨンマ)", "", p => average(total.gameRanks[p.id].yonma)],
    ["平均順位(サンマ)", "", p => average(total.gameRanks[p.id].sanma)]
  ].map(([label, unit, fn]) => {
    const rowClass = label === "場代抜き残高" ? "balance-before" : label === "場代込残高" ? "balance-after" : "";
    return `<tr class="${rowClass}"><th class="fixed-col">${label}</th>${players.map(p => `<td>${label === "繰越場代" ? formatCarryTableFee(fn(p)) : formatValue(fn(p), unit)}</td>`).join("")}</tr>`;
  }).join("");
  document.getElementById("personalBlock").innerHTML = `<table><thead><tr><th class="fixed-col">項目</th>${players.map(p => `<th>${p.name}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
  document.getElementById("checkBlock").innerHTML = `<span class="status-ok">整合</span> 集計値は保存せず、表示時に再計算しています。`;
}

function aggregateAll(players) {
  const ids = players.map(p => p.id);
  const zero = () => Object.fromEntries(ids.map(id => [id, 0]));
  const total = {
    final: zero(), tableFee: zero(), yakuman: zero(), yakumanIncome: zero(), yakumanExpense: zero(), tips: zero(), tipIncome: zero(), tipExpense: zero(),
    rankCounts: Object.fromEntries(ids.map(id => [id, { 1: 0, 2: 0, 3: 0, 4: 0 }])),
    games: Object.fromEntries(ids.map(id => [id, { sanma: 0, yonma: 0 }])),
    gameRanks: Object.fromEntries(ids.map(id => [id, { sanma: [], yonma: [] }])),
    days: Object.fromEntries(ids.map(id => [id, new Set()])),
    best: Object.fromEntries(ids.map(id => [id, null])),
    worst: Object.fromEntries(ids.map(id => [id, null]))
  };
  state.sessions.forEach(session => {
    const stats = aggregateSession(session);
    ids.forEach(id => {
      const final = (stats.money[id] || 0) + (stats.yakuman[id] || 0) + (stats.tips[id] || 0);
      total.final[id] += final;
      total.tableFee[id] += stats.tableFee[id] || 0;
      total.yakuman[id] += stats.yakuman[id] || 0;
      total.yakumanIncome[id] += stats.yakumanIncome[id] || 0;
      total.yakumanExpense[id] += stats.yakumanExpense[id] || 0;
      total.tips[id] += stats.tips[id] || 0;
      total.tipIncome[id] += stats.tipIncome[id] || 0;
      total.tipExpense[id] += stats.tipExpense[id] || 0;
      [1, 2, 3, 4].forEach(rank => total.rankCounts[id][rank] += stats.rankCounts[id]?.[rank] || 0);
      total.games[id].sanma += stats.games[id]?.sanma || 0;
      total.games[id].yonma += stats.games[id]?.yonma || 0;
      total.gameRanks[id].sanma.push(...(stats.gameRanks[id]?.sanma || []));
      total.gameRanks[id].yonma.push(...(stats.gameRanks[id]?.yonma || []));
      if (session.participantIds.includes(id)) total.days[id].add(session.date);
      if (final !== 0 || session.participantIds.includes(id)) {
        if (!total.best[id] || final > total.best[id].amount) total.best[id] = { amount: final, date: session.date };
        if (!total.worst[id] || final < total.worst[id].amount) total.worst[id] = { amount: final, date: session.date };
      }
    });
  });
  return total;
}

function renderPlayers() {
  const list = document.getElementById("playerList");
  const editable = state.admin;
  const rows = activePlayers().map(player => `
    <div class="list-item">
      <label>名前<input data-player-name="${player.id}" value="${player.name}" ${editable ? "" : "disabled"}></label>
      <label>表示順<input data-player-order="${player.id}" type="number" value="${player.order}" ${editable ? "" : "disabled"}></label>
      <label>表示<select data-player-visible="${player.id}" ${editable ? "" : "disabled"}><option value="true" ${player.visible ? "selected" : ""}>ON</option><option value="false" ${!player.visible ? "selected" : ""}>OFF</option></select></label>
      <label>繰越金<input class="carry-input ${Number(player.carry) < 0 ? "negative-input" : ""}" data-player-carry="${player.id}" type="text" inputmode="numeric" value="${player.carry}" ${editable ? "" : "disabled"}></label>
      <label>繰越場代<input class="carry-input ${Number(player.carryTableFee) < 0 ? "negative-input" : ""}" data-player-fee="${player.id}" type="text" inputmode="numeric" value="${player.carryTableFee}" ${editable ? "" : "disabled"}></label>
    </div>
  `).join("");
  list.innerHTML = rows;
  list.querySelectorAll(".carry-input").forEach(input => input.addEventListener("input", () => updateNegativeInput(input)));
  list.querySelectorAll("input,select").forEach(input => input.addEventListener("change", savePlayersFromForm));
}

function savePlayersFromForm() {
  if (!state.admin) return;
  activePlayers().forEach(player => {
    player.name = document.querySelector(`[data-player-name="${player.id}"]`).value;
    player.order = Number(document.querySelector(`[data-player-order="${player.id}"]`).value) || player.order;
    player.visible = document.querySelector(`[data-player-visible="${player.id}"]`).value === "true";
    player.carry = Number(document.querySelector(`[data-player-carry="${player.id}"]`).value) || 0;
    player.carryTableFee = Number(document.querySelector(`[data-player-fee="${player.id}"]`).value) || 0;
  });
  saveState("プレイヤー変更");
}

function renderSettings() {
  const form = document.getElementById("settingsForm");
  const disabled = state.admin ? "" : "disabled";
  form.innerHTML = ["sanma", "yonma"].map(game => {
    const label = game === "sanma" ? "サンマ" : "ヨンマ";
    const s = state.settings[game];
    return `<div class="setting-card"><h3>${label}設定</h3>
      <label>レート<input data-setting="${game}.rate" type="number" min="1" max="10" value="${s.rate}" ${disabled}></label>
      <label>持ち点<input data-setting="${game}.start" type="number" value="${s.start}" ${disabled}></label>
      <label>返し点<input data-setting="${game}.return" type="number" value="${s.return}" ${disabled}></label>
      ${s.uma.map((v, i) => `<label>ウマ${i + 1}位<input data-setting="${game}.uma.${i}" type="number" value="${v}" ${disabled}></label>`).join("")}
      ${s.oka.map((v, i) => `<label>オカ${i + 1}位<input data-setting="${game}.oka.${i}" type="number" value="${v}" ${disabled}></label>`).join("")}
    </div>`;
  }).join("") + `<div class="setting-card"><h3>共通設定</h3>
    <label>場代<input data-setting="common.tableFee" type="number" value="${state.settings.common.tableFee}" ${disabled}></label>
    <label>端数処理<select data-setting="common.rounding" ${disabled}>
      <option value="gosha6nyu" ${state.settings.common.rounding === "gosha6nyu" ? "selected" : ""}>五捨六入</option>
      <option value="round" ${state.settings.common.rounding === "round" ? "selected" : ""}>四捨五入</option>
      <option value="excel" ${state.settings.common.rounding === "excel" ? "selected" : ""}>エクセル合わせ</option>
    </select></label>
    <label class="check-label"><input data-setting="common.monitorMode" type="checkbox" ${state.settings.common.monitorMode ? "checked" : ""} ${disabled}>モニターモード</label>
    ${state.admin
      ? `<label>管理者パスワード<div class="password-field"><input id="adminPasswordInput" data-setting="common.adminPassword" type="password" value="${escapeHtml(state.settings.common.adminPassword)}" autocomplete="new-password"><button id="passwordToggleButton" class="password-toggle" type="button" title="パスワードを表示" aria-label="パスワードを表示" aria-pressed="false">👁</button></div></label>`
      : `<p class="muted">管理者パスワードは、管理者ログイン後に変更できます。</p>`}
  </div>
  <div class="setting-card"><h3>Firebase共有</h3>
    <label class="check-label"><input data-firebase-setting="enabled" type="checkbox" ${firebaseSettings.enabled ? "checked" : ""} ${disabled}>Firebaseを使用する</label>
    <label>apiKey<input data-firebase-setting="apiKey" value="${escapeHtml(firebaseSettings.apiKey)}" ${disabled}></label>
    <label>authDomain<input data-firebase-setting="authDomain" value="${escapeHtml(firebaseSettings.authDomain)}" ${disabled}></label>
    <label>projectId<input data-firebase-setting="projectId" value="${escapeHtml(firebaseSettings.projectId)}" ${disabled}></label>
    <label>storageBucket<input data-firebase-setting="storageBucket" value="${escapeHtml(firebaseSettings.storageBucket)}" ${disabled}></label>
    <label>messagingSenderId<input data-firebase-setting="messagingSenderId" value="${escapeHtml(firebaseSettings.messagingSenderId)}" ${disabled}></label>
    <label>appId<input data-firebase-setting="appId" value="${escapeHtml(firebaseSettings.appId)}" ${disabled}></label>
    <label>共有ドキュメント<input data-firebase-setting="docPath" value="${escapeHtml(firebaseSettings.docPath)}" placeholder="mahjongApps/main" ${disabled}></label>
    <p class="muted">同じFirebase設定と共有ドキュメントを使う端末同士で、リアルタイム共有します。</p>
    <p class="muted">現在: ${escapeHtml(firebaseStatus)}</p>
  </div>`;
  const passwordToggle = document.getElementById("passwordToggleButton");
  if (passwordToggle) {
    passwordToggle.addEventListener("click", () => {
      const passwordInput = document.getElementById("adminPasswordInput");
      const showing = passwordInput.type === "text";
      passwordInput.type = showing ? "password" : "text";
      passwordToggle.setAttribute("aria-pressed", String(!showing));
      passwordToggle.title = showing ? "パスワードを表示" : "パスワードを隠す";
      passwordToggle.setAttribute("aria-label", passwordToggle.title);
    });
  }
}

function saveSettingsFromForm() {
  if (!state.admin) return;
  const passwordInput = document.querySelector('[data-setting="common.adminPassword"]');
  if (passwordInput && passwordInput.value.trim() === "") {
    alert("管理者パスワードを空欄にはできません。");
    return;
  }
  document.querySelectorAll("[data-setting]").forEach(input => {
    const path = input.dataset.setting.split(".");
    let target = state.settings;
    while (path.length > 1) target = target[path.shift()];
    const key = path[0];
    if (input.dataset.setting === "common.adminPassword") {
      target[key] = input.value;
    } else if (input.type === "checkbox") {
      target[key] = input.checked;
    } else {
      target[key] = input.tagName === "SELECT" ? input.value : Number(input.value);
    }
  });
  document.querySelectorAll("[data-firebase-setting]").forEach(input => {
    const key = input.dataset.firebaseSetting;
    firebaseSettings[key] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  saveFirebaseSettings();
  saveState("設定変更");
  initFirebaseSync();
  alert("設定を保存しました。");
}

function renderHistory() {
  const list = document.getElementById("historyList");
  list.innerHTML = state.history.length ? "" : `<div class="muted">履歴はありません。</div>`;
  state.history.forEach(item => {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `<div><strong>${item.action}</strong><div class="meta">${DATE_FORMAT.format(new Date(item.at))} ${new Date(item.at).toLocaleTimeString("ja-JP")} / ${item.user}</div></div>`;
    list.append(div);
  });
}

function exportJson() {
  if (!state.admin) return;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `mahjong-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(event) {
  if (!state.admin) return;
  const file = event.target.files[0];
  if (!file) return;
  file.text().then(text => {
    state = normalizeState(JSON.parse(text));
    saveState("JSON復元");
  });
}

function statusClass(status) {
  if (status === "○") return "status-ok";
  if (status === "△") return "status-edit";
  if (status === "×") return "status-error";
  return "muted";
}

function formatNumber(value, unit) {
  if (value === undefined || value === null || value === "") return "";
  const cls = Number(value) < 0 ? "negative" : Number(value) > 0 ? "positive" : "";
  return `<span class="${cls}">${Number(value).toLocaleString()}${unit}</span>`;
}

function formatValue(value, unit = "") {
  if (value === "" || value === undefined || value === null) return "";
  if (typeof value === "number") return formatNumber(value, unit);
  return value;
}

function formatCarryTableFee(value) {
  const amount = Math.abs(Number(value) || 0).toLocaleString();
  return `<span class="carry-table-fee">▼${amount}円</span>`;
}

function average(values) {
  if (!values.length) return "";
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 100) / 100;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
