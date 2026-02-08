import { runSimulation } from "./engine.js";

const state = {
  players: [
    { name: "P1", range: "*" },
    { name: "P2", range: "*" }
  ],
  focusedPlayer: 0,
  lastResult: null,
  isRunning: false
};

let runAbortController = null;

const el = {
  method: document.querySelector("#method"),
  variant: document.querySelector("#variant"),
  iterationCap: document.querySelector("#iterationCap"),
  board: document.querySelector("#board"),
  dead: document.querySelector("#dead"),
  addPlayer: document.querySelector("#addPlayer"),
  removePlayer: document.querySelector("#removePlayer"),
  players: document.querySelector("#players"),
  run: document.querySelector("#run"),
  stop: document.querySelector("#stop"),
  status: document.querySelector("#status"),
  runSummary: document.querySelector("#runSummary"),
  helpOpen: document.querySelector("#helpOpen"),
  helpClose: document.querySelector("#helpClose"),
  helpModal: document.querySelector("#helpModal"),
  exportSetup: document.querySelector("#exportSetup"),
  importSetup: document.querySelector("#importSetup"),
  importFile: document.querySelector("#importFile"),
  rangePicks: document.querySelector("#rangePicks")
};

const quickPicks = [
  { label: "Set", token: "@set" },
  { label: "2 Pair", token: "@2p" },
  { label: "Flush Draw", token: "@fd" },
  { label: "Flush", token: "@flush" },
  { label: "Straight", token: "@straight" },
  { label: "Top Pair+", token: "@tpplus" },
  { label: "Overpair", token: "@overpair" },
  { label: "Double Suited", token: "$ds" },
  { label: "Single Suited", token: "$ss" },
  { label: "No Pair", token: "$np" }
];

function saveLocal() {
  localStorage.setItem("poker-odds-lab-state", JSON.stringify({
    method: el.method.value,
    variant: el.variant.value,
    iterationCap: el.iterationCap.value,
    board: el.board.value,
    dead: el.dead.value,
    players: state.players
  }));
}

function loadLocal() {
  try {
    const raw = localStorage.getItem("poker-odds-lab-state");
    if (!raw) return;
    const s = JSON.parse(raw);
    el.method.value = s.method || "monte";
    el.variant.value = s.variant || "holdem";
    el.iterationCap.value = s.iterationCap || "150000";
    el.board.value = s.board || "";
    el.dead.value = s.dead || "";
    if (Array.isArray(s.players) && s.players.length >= 2) {
      state.players = s.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: p.range || "*"
      }));
    }
  } catch {
    // ignore corrupt local storage
  }
}

function renderQuickPicks() {
  el.rangePicks.innerHTML = "";
  for (const p of quickPicks) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.addEventListener("click", () => applyQuickPick(p.token));
    el.rangePicks.appendChild(b);
  }
}

function applyQuickPick(token) {
  const idx = Math.max(0, Math.min(state.players.length - 1, state.focusedPlayer));
  const player = state.players[idx];
  if (!player) return;
  if (!player.range || player.range.trim() === "*") player.range = token;
  else player.range = `${player.range}:${token}`;
  renderPlayers();
  saveLocal();
}

function openHelp() {
  el.helpModal.classList.remove("hidden");
}

function closeHelp() {
  el.helpModal.classList.add("hidden");
}

function setStatus(msg) {
  el.status.textContent = msg;
}

function renderSummary(result) {
  if (!result || !result.players?.length) {
    el.runSummary.textContent = "";
    return;
  }
  el.runSummary.textContent = `${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s • ${result.variant.toUpperCase()}`;
}

function playerOutputRow(row) {
  const wrap = document.createElement("div");
  wrap.className = "player-output";

  if (!row) {
    wrap.textContent = "No result yet.";
    return wrap;
  }

  wrap.innerHTML = `<span><strong>Eq</strong> ${row.equity}</span>
    <span><strong>W</strong> ${row.win}</span>
    <span><strong>T</strong> ${row.tie}</span>
    <span><strong>L</strong> ${row.loss}</span>
    <span><strong>Combos</strong> ${row.combos}</span>`;

  const classes = document.createElement("div");
  classes.className = "player-classes";
  classes.textContent = row.classes || "";
  wrap.appendChild(classes);
  return wrap;
}

function renderPlayers() {
  el.players.innerHTML = "";
  const results = state.lastResult?.players || [];

  state.players.forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "player-row";

    const main = document.createElement("div");
    main.className = "player-main";

    const tag = document.createElement("span");
    tag.className = "player-tag";
    tag.textContent = `P${i + 1}`;

    const range = document.createElement("input");
    range.className = "player-range-input";
    range.type = "text";
    range.value = p.range;
    range.placeholder = "Range syntax (PPT-style), e.g. AA,AK$s,15%";
    range.addEventListener("focus", () => {
      state.focusedPlayer = i;
    });
    range.addEventListener("input", () => {
      p.range = range.value;
      saveLocal();
    });

    main.appendChild(tag);
    main.appendChild(range);
    row.appendChild(main);
    row.appendChild(playerOutputRow(results[i]));
    el.players.appendChild(row);
  });
}

function currentConfig() {
  return {
    method: el.method.value,
    variant: el.variant.value,
    iterationCap: Number(el.iterationCap.value || 150000),
    board: el.board.value.trim(),
    dead: el.dead.value.trim(),
    players: state.players.map((p, i) => ({
      name: p.name?.trim() || `P${i + 1}`,
      range: p.range?.trim() || "*"
    }))
  };
}

function syncMethodUI() {
  const exact = el.method.value === "exact";
  el.iterationCap.disabled = exact;
  el.iterationCap.title = exact ? "Not used in exhaustive mode." : "";
}

async function run() {
  if (state.isRunning) return;
  const config = currentConfig();
  runAbortController = new AbortController();
  state.isRunning = true;
  setStatus("Running simulation...");
  el.run.disabled = true;
  el.stop.disabled = false;

  try {
    const controller = runAbortController;
    const result = await runSimulation(config, (p) => {
      setStatus(`Iterations: ${p.iterations.toLocaleString()} | ${Math.round(p.ips).toLocaleString()} it/s | ${p.elapsed.toFixed(2)}s`);
    }, controller.signal);
    state.lastResult = result;
    renderSummary(result);
    renderPlayers();
    if (result.aborted || controller.signal.aborted) {
      setStatus(`Stopped at ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s.`);
    } else {
      setStatus(`Done. ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s.`);
    }
  } catch (err) {
    setStatus(`Error: ${err.message || String(err)}`);
  } finally {
    state.isRunning = false;
    runAbortController = null;
    el.run.disabled = false;
    el.stop.disabled = true;
  }
}

function stopRun() {
  if (!state.isRunning || !runAbortController) return;
  runAbortController.abort();
  setStatus("Stopping...");
}

function exportSetup() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    setup: currentConfig(),
    result: state.lastResult
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `poker-odds-lab-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importSetup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result || "{}"));
      const setup = payload.setup || payload;
      if (!setup.players || setup.players.length < 2) throw new Error("Invalid setup file");

      el.variant.value = setup.variant || "holdem";
      el.method.value = setup.method || "monte";
      el.iterationCap.value = setup.iterationCap || 150000;
      el.board.value = setup.board || "";
      el.dead.value = setup.dead || "";
      state.players = setup.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: p.range || "*"
      }));

      state.lastResult = payload.result || null;
      syncMethodUI();
      renderSummary(state.lastResult);
      renderPlayers();
      saveLocal();
      setStatus("Setup imported.");
    } catch (err) {
      setStatus(`Import failed: ${err.message || String(err)}`);
    }
  };
  reader.readAsText(file);
}

function wire() {
  el.addPlayer.addEventListener("click", () => {
    if (state.isRunning) return;
    if (state.players.length >= 6) {
      setStatus("Max 6 players.");
      return;
    }
    state.players.push({ name: `P${state.players.length + 1}`, range: "*" });
    renderPlayers();
    saveLocal();
  });

  el.removePlayer.addEventListener("click", () => {
    if (state.isRunning) return;
    if (state.players.length <= 2) {
      setStatus("Minimum 2 players.");
      return;
    }
    state.players.pop();
    renderPlayers();
    saveLocal();
  });

  el.run.addEventListener("click", run);
  el.stop.addEventListener("click", stopRun);
  el.helpOpen.addEventListener("click", openHelp);
  el.helpClose.addEventListener("click", closeHelp);
  el.helpModal.addEventListener("click", (event) => {
    if (event.target === el.helpModal) closeHelp();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !el.helpModal.classList.contains("hidden")) closeHelp();
  });

  el.exportSetup.addEventListener("click", exportSetup);
  el.importSetup.addEventListener("click", () => el.importFile.click());
  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files?.[0];
    if (file) importSetup(file);
    el.importFile.value = "";
  });

  [el.method, el.variant, el.iterationCap, el.board, el.dead].forEach((node) => {
    node.addEventListener("input", saveLocal);
  });
  el.method.addEventListener("change", syncMethodUI);
}

loadLocal();
syncMethodUI();
renderQuickPicks();
renderSummary(state.lastResult);
renderPlayers();
wire();
el.stop.disabled = true;
setStatus("Idle.");
