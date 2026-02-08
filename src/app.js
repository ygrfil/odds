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
  results: document.querySelector("#results"),
  exportSetup: document.querySelector("#exportSetup"),
  importSetup: document.querySelector("#importSetup"),
  importFile: document.querySelector("#importFile"),
  rangePicks: document.querySelector("#rangePicks")
};

const quickPicks = [
  { label: "Set", token: "@set" },
  { label: "2 Pair+", token: "@2p" },
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
  if (!player.range || player.range.trim() === "*") {
    player.range = token;
  } else {
    player.range = `${player.range}:${token}`;
  }
  renderPlayers();
  saveLocal();
}

function renderPlayers() {
  el.players.innerHTML = "";
  state.players.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "player-card";

    const head = document.createElement("div");
    head.className = "player-head";

    const nameInput = document.createElement("input");
    nameInput.value = p.name;
    nameInput.placeholder = `P${i + 1}`;
    nameInput.style.maxWidth = "160px";
    nameInput.addEventListener("input", () => {
      p.name = nameInput.value;
      saveLocal();
    });

    const short = document.createElement("span");
    short.className = "small";
    short.textContent = `Player ${i + 1}`;

    head.appendChild(nameInput);
    head.appendChild(short);

    const range = document.createElement("textarea");
    range.className = "player-range";
    range.rows = 2;
    range.value = p.range;
    range.placeholder = "Range syntax (PPT-style), e.g. AA,AK$s,15%";
    range.addEventListener("focus", () => {
      state.focusedPlayer = i;
    });
    range.addEventListener("input", () => {
      p.range = range.value;
      saveLocal();
    });

    card.appendChild(head);
    card.appendChild(range);
    el.players.appendChild(card);
  });
}

function setStatus(msg) {
  el.status.textContent = msg;
}

function renderResults(result) {
  if (!result || !result.players?.length) {
    el.results.innerHTML = "<p>No results yet.</p>";
    return;
  }

  const html = [];
  html.push(`<p><strong>${result.iterations.toLocaleString()}</strong> iterations in <strong>${(result.elapsedMs / 1000).toFixed(2)}s</strong>. Variant: <strong>${result.variant}</strong>.</p>`);
  html.push('<div class="table-wrap"><table><thead><tr><th>Player</th><th>Range</th><th>Equity</th><th>Win</th><th>Tie</th><th>Loss</th><th>Combos</th><th>Hand Classes</th></tr></thead><tbody>');

  for (const row of result.players) {
    html.push(`<tr>
      <td>${escapeHtml(row.player)}</td>
      <td>${escapeHtml(row.range)}</td>
      <td><strong>${row.equity}</strong></td>
      <td>${row.win}</td>
      <td>${row.tie}</td>
      <td>${row.loss}</td>
      <td>${row.combos}</td>
      <td>${escapeHtml(row.classes)}</td>
    </tr>`);
  }

  html.push("</tbody></table></div>");
  el.results.innerHTML = html.join("");
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function currentConfig() {
  return {
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

async function run() {
  if (state.isRunning) return;
  const config = currentConfig();
  runAbortController = new AbortController();
  state.isRunning = true;
  setStatus("Running simulation...");
  el.run.disabled = true;
  el.stop.disabled = false;
  try {
    const result = await runSimulation(config, (p) => {
      setStatus(`Iterations: ${p.iterations.toLocaleString()} | ${Math.round(p.ips).toLocaleString()} it/s | elapsed: ${p.elapsed.toFixed(2)}s | board: ${p.boardClass}`);
    }, runAbortController.signal);
    state.lastResult = result;
    renderResults(result);
    setStatus(`Done. ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s.`);
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
      el.iterationCap.value = setup.iterationCap || 150000;
      el.board.value = setup.board || "";
      el.dead.value = setup.dead || "";
      state.players = setup.players.slice(0, 6).map((p, i) => ({
        name: p.name || `P${i + 1}`,
        range: p.range || "*"
      }));

      if (payload.result) {
        state.lastResult = payload.result;
        renderResults(payload.result);
      }

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
  el.exportSetup.addEventListener("click", exportSetup);
  el.importSetup.addEventListener("click", () => el.importFile.click());
  el.importFile.addEventListener("change", () => {
    const file = el.importFile.files?.[0];
    if (file) importSetup(file);
    el.importFile.value = "";
  });

  [el.variant, el.iterationCap, el.board, el.dead].forEach((node) => {
    node.addEventListener("input", saveLocal);
  });
}

loadLocal();
renderQuickPicks();
renderPlayers();
renderResults(null);
wire();
el.stop.disabled = true;
setStatus("Idle.");
