import { runSimulation } from "./engine.js";
import { previewTagCoreCombos, previewTagCoverage, previewRangeCoverage } from "./sim-core.js";

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
  { label: "Straight Draw", token: "@sd" },
  { label: "SD 8+ Outs", token: "@sd8" },
  { label: "SD 12+ Outs", token: "@sd12" },
  { label: "Flush", token: "@flush" },
  { label: "Straight", token: "@straight" },
  { label: "Top Pair+", token: "@tpplus" },
  { label: "Overpair", token: "@overpair" },
  { label: "Double Suited", token: "$ds" },
  { label: "Single Suited", token: "$ss" },
  { label: "No Pair", token: "$np" }
];

const TAG_HINTS = {
  "@set": "Set/Trips made now. Hold'em: trips from hole+board. Omaha: must be formed with exactly 2 hole + 3 board.",
  "@2p": "Exactly two pair made now.",
  "@fd": "Flush draw (4 to a flush, not yet made). Omaha requires 2 suited hole cards + 2 suited board cards.",
  "@sd": "Straight draw with 1+ outs (includes rare <4 out cases). Uses street-correct rules.",
  "@sd4": "Straight draw with 4+ outs.",
  "@sd8": "Straight draw with 8 outs or more.",
  "@sd12": "Straight draw with 12 outs or more.",
  "@sd13": "Legacy alias for @sd12 (12+ outs).",
  "@flush": "Made flush now. Omaha requires exactly 2 hole + 3 board.",
  "@straight": "Made straight now only. Hold'em can use any 5-card combo; Omaha uses exactly 2 hole + 3 board.",
  "@tpplus": "Pair or better made now (pair/two-pair/trips/straight/flush/full-house/quads/straight-flush).",
  "@overpair": "Hold'em only: pocket pair higher than top board rank."
};

function rangeTagHints(rangeText, variant) {
  const tags = String(rangeText || "").toLowerCase().match(/@[a-z0-9_]+/g) || [];
  const uniq = [...new Set(tags)].filter((t) => TAG_HINTS[t]);
  if (!uniq.length) return "";
  const gameRule = variant === "holdem"
    ? "Game rule: Hold'em hand evaluation can use any 5-card combination."
    : "Game rule: Omaha hand evaluation always uses exactly 2 hole cards + 3 board cards.";
  const lines = uniq.map((t) => `${t}: ${TAG_HINTS[t]}`);
  return `${lines.join("\n")}\n${gameRule}`;
}

function atTagsInRange(rangeText) {
  const tags = String(rangeText || "").toLowerCase().match(/@[a-z0-9_]+/g) || [];
  return [...new Set(tags)];
}

function atTagAndClausesInRange(rangeText) {
  const cleaned = String(rangeText || "").replace(/\s+/g, "").toLowerCase();
  const raw = cleaned.match(/@[a-z0-9_]+(?::@[a-z0-9_]+)+/g) || [];
  const uniq = [...new Set(raw)];
  return uniq.filter((expr) => {
    const tags = expr.match(/@[a-z0-9_]+/g) || [];
    return tags.length >= 2 && tags.every((t) => TAG_HINTS[t]);
  });
}

function coverageText(cov) {
  if (!cov || cov.total <= 0) return "";
  if (cov.approx) {
    const pct = `~${cov.pct.toFixed(1)}%`;
    if (Number.isFinite(cov.estimatedMatched) && Number.isFinite(cov.population) && cov.population > 0) {
      return `${pct}, ~${cov.estimatedMatched.toLocaleString()}/${cov.population.toLocaleString()} combos`;
    }
    return `${pct}, ${cov.matched.toLocaleString()}/${cov.total.toLocaleString()} samples`;
  }
  return `${cov.pct.toFixed(1)}%, ${cov.matched.toLocaleString()}/${cov.total.toLocaleString()} combos`;
}

function atTagLiveInfo(rangeText) {
  const tags = atTagsInRange(rangeText).filter((t) => TAG_HINTS[t]);
  const andClauses = atTagAndClausesInRange(rangeText);
  if (!tags.length) return "";
  const boardText = el.board.value.trim();
  const boardCards = Math.floor(boardText.length / 2);
  const isHoldem = el.variant.value === "holdem";
  const parts = [];

  for (const tag of tags) {
    if (tag === "@overpair") {
      if (!isHoldem) {
        parts.push("@overpair: Hold'em only.");
      } else if (boardCards < 3) {
        parts.push("@overpair: needs flop+.");
      } else {
        const combos = previewTagCoreCombos(boardText, "holdem", tag);
        const cov = previewTagCoverage(boardText, "holdem", tag);
        const stat = coverageText(cov);
        parts.push(`@overpair: ${combos.length ? combos.join(",") : "-"} (${stat})`);
      }
      continue;
    }

    if (boardCards < 3) {
      parts.push(`${tag}: needs flop+.`);
    } else {
      try {
        const combos = previewTagCoreCombos(boardText, el.variant.value, tag);
        const cov = previewTagCoverage(boardText, el.variant.value, tag);
        const stat = coverageText(cov);
        let extra = "";
        if (!isHoldem && tag === "@sd") {
          const c4 = previewTagCoverage(boardText, el.variant.value, "@sd4");
          if (cov.pct > c4.pct + 0.2) {
            extra = " + blocker-only <4 out draws";
          }
        }
        parts.push(`${tag}: ${combos.length ? combos.join(",") : "-"} (${stat})${extra}`);
      } catch {
        parts.push(`${tag}: invalid board input`);
      }
    }
  }

  if (boardCards >= 3) {
    for (const expr of andClauses) {
      try {
        const cov = previewRangeCoverage(boardText, el.variant.value, expr);
        const stat = coverageText(cov);
        parts.push(`${expr}: ${stat}`);
      } catch {
        parts.push(`${expr}: invalid expression`);
      }
    }
  } else if (andClauses.length) {
    for (const expr of andClauses) parts.push(`${expr}: needs flop+.`);
  }
  return parts.join(" | ");
}

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
  const engine = result.backend ? "NATIVE BACKEND" : "BROWSER";
  const total = (result.elapsedMs / 1000).toFixed(2);
  let extra = "";
  if (result.backend && result.timings) {
    const prep = Number(result.timings.prepareMs || 0);
    const sim = Number(result.timings.nativeMs || result.backendComputeMs || 0);
    if (prep > 0 || sim > 0) {
      extra = ` • prep ${(prep / 1000).toFixed(2)}s • sim ${(sim / 1000).toFixed(2)}s`;
    }
  }
  el.runSummary.textContent = `${result.iterations.toLocaleString()} iterations in ${total}s • ${result.variant.toUpperCase()} • ${String(result.method || "monte").toUpperCase()} • ${engine}${extra}`;
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

    main.appendChild(tag);
    main.appendChild(range);
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "tag-hint";
    hint.textContent = "?";
    hint.setAttribute("aria-expanded", "false");
    hint.addEventListener("click", (event) => {
      event.stopPropagation();
      const existing = row.querySelector(".tag-hint-popover");
      document.querySelectorAll(".tag-hint-popover").forEach((n) => n.remove());
      document.querySelectorAll(".tag-hint[aria-expanded='true']").forEach((n) => n.setAttribute("aria-expanded", "false"));
      if (existing) return;
      const help = rangeTagHints(p.range, el.variant.value);

      const pop = document.createElement("div");
      pop.className = "tag-hint-popover";
      pop.textContent = help || "No @tag used in this range.";
      pop.addEventListener("click", (e) => e.stopPropagation());
      row.appendChild(pop);
      hint.setAttribute("aria-expanded", "true");
    });
    main.appendChild(hint);
    row.appendChild(main);
    const info = document.createElement("div");
    info.className = "player-live-note";
    row.appendChild(info);
    const refreshDerived = () => {
      const h = rangeTagHints(p.range, el.variant.value);
      hint.classList.toggle("is-empty", !h);
      const live = atTagLiveInfo(p.range);
      info.textContent = live;
      info.style.display = live ? "" : "none";
    };
    range.addEventListener("input", () => {
      p.range = range.value;
      saveLocal();
      refreshDerived();
    });
    refreshDerived();
    row.appendChild(playerOutputRow(results[i]));
    el.players.appendChild(row);
  });
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
    const controller = runAbortController;
    const result = await runSimulation(config, (p) => {
      const ips = Number(p.ips);
      if (Number.isFinite(ips) && ips > 0 && Number(p.iterations) > 0) {
        setStatus(`Iterations: ${p.iterations.toLocaleString()} | ${Math.round(ips).toLocaleString()} it/s | ${p.elapsed.toFixed(2)}s`);
      } else {
        setStatus(`Running... preparing/evaluating ranges | ${p.elapsed.toFixed(2)}s`);
      }
    }, controller.signal);
    state.lastResult = result;
    renderSummary(result);
    renderPlayers();
    const avgIps = result.iterations / Math.max(0.001, result.elapsedMs / 1000);
    if (result.aborted || controller.signal.aborted) {
      setStatus(`Stopped at ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s (${Math.round(avgIps).toLocaleString()} it/s avg).`);
    } else {
      setStatus(`Done. ${result.iterations.toLocaleString()} iterations in ${(result.elapsedMs / 1000).toFixed(2)}s (${Math.round(avgIps).toLocaleString()} it/s avg).`);
    }
  } catch (err) {
    if (runAbortController?.signal?.aborted || err?.name === "AbortError") setStatus("Stopped.");
    else setStatus(`Error: ${err.message || String(err)}`);
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

      state.lastResult = payload.result || null;
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
  document.addEventListener("click", () => {
    document.querySelectorAll(".tag-hint-popover").forEach((n) => n.remove());
    document.querySelectorAll(".tag-hint[aria-expanded='true']").forEach((n) => n.setAttribute("aria-expanded", "false"));
  });

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

  [el.variant, el.iterationCap, el.board, el.dead].forEach((node) => {
    node.addEventListener("input", saveLocal);
  });
  el.variant.addEventListener("change", () => {
    saveLocal();
    renderPlayers();
  });
  el.board.addEventListener("input", renderPlayers);
}

loadLocal();
renderQuickPicks();
renderSummary(state.lastResult);
renderPlayers();
wire();
el.stop.disabled = true;
setStatus("Idle.");
