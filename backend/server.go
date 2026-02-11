package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

type playerConfig struct {
	Name  string `json:"name"`
	Range string `json:"range"`
}

type runConfig struct {
	Variant             string           `json:"variant"`
	PercentileProfile   string           `json:"percentileProfile,omitempty"`
	IterationCap        int              `json:"iterationCap"`
	Board               string           `json:"board"`
	Dead                string           `json:"dead"`
	Players             []playerConfig   `json:"players"`
	RangeCoverage       []map[string]any `json:"rangeCoverage,omitempty"`
	ConfidenceTargetPct float64          `json:"confidenceTargetPct,omitempty"`
	ConfidenceMinIters  int              `json:"confidenceMinIterations,omitempty"`
	ConfidenceLevel     float64          `json:"confidenceLevel,omitempty"`
}

type runRequest struct {
	Config  runConfig `json:"config"`
	Workers int       `json:"workers,omitempty"`
}

type rawPayload struct {
	Iterations   int64      `json:"iterations"`
	ElapsedMs    float64    `json:"elapsedMs"`
	Wins         []int64    `json:"wins"`
	Ties         []int64    `json:"ties"`
	Losses       []int64    `json:"losses"`
	EquityShares []float64  `json:"equityShares"`
	ComboLists   [][]string `json:"comboLists"`
	ClassCounts  [][]int64  `json:"classCounts"`
}

type runPartResponse struct {
	OK    bool       `json:"ok"`
	Error string     `json:"error,omitempty"`
	Mode  string     `json:"mode"`
	Raw   rawPayload `json:"raw"`
}

type apiResponse struct {
	OK    bool        `json:"ok"`
	Error string      `json:"error,omitempty"`
	Mode  string      `json:"mode,omitempty"`
	Raw   *rawPayload `json:"raw,omitempty"`
}

type previewTagRequest struct {
	BoardText string `json:"boardText"`
	Variant   string `json:"variant"`
	Tag       string `json:"tag"`
}

type previewRangeRequest struct {
	BoardText         string `json:"boardText"`
	Variant           string `json:"variant"`
	RangeText         string `json:"rangeText"`
	PercentileProfile string `json:"percentileProfile,omitempty"`
}

type bridgeResponse struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Body  json.RawMessage `json:"-"`
}

type bridgeClient struct {
	projectRoot string
	bridgePath  string

	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func newBridgeClient(projectRoot, bridgePath string) *bridgeClient {
	return &bridgeClient{
		projectRoot: projectRoot,
		bridgePath:  bridgePath,
	}
}

func (b *bridgeClient) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stopLocked("")
}

func (b *bridgeClient) Call(ctx context.Context, req any, out any) error {
	payload, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if err := b.ensureStartedLocked(); err != nil {
			return err
		}

		if _, err := b.stdin.Write(append(payload, '\n')); err != nil {
			lastErr = fmt.Errorf("bridge write failed: %w", err)
			b.stopLocked("write failed")
			continue
		}

		resp, err := b.readResponseLocked(ctx)
		if err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return err
			}
			lastErr = fmt.Errorf("bridge read failed: %w", err)
			b.stopLocked("read failed")
			continue
		}

		if out == nil {
			return nil
		}
		if err := json.Unmarshal(resp, out); err != nil {
			lastErr = fmt.Errorf("invalid bridge response: %w", err)
			b.stopLocked("invalid response")
			continue
		}
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("bridge call failed")
	}
	return lastErr
}

func (b *bridgeClient) ensureStartedLocked() error {
	if b.cmd != nil {
		return nil
	}

	cmd := exec.Command("node", b.bridgePath)
	cmd.Dir = b.projectRoot
	cmd.Env = append(os.Environ(), "BRIDGE_DAEMON=1")

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("bridge stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("bridge stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return fmt.Errorf("bridge stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		_ = stderr.Close()
		return fmt.Errorf("start bridge: %w", err)
	}

	b.cmd = cmd
	b.stdin = stdin
	b.stdout = bufio.NewReader(stdout)

	go func() {
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			log.Printf("[bridge] %s", line)
		}
		if err := sc.Err(); err != nil {
			log.Printf("[bridge] stderr read error: %v", err)
		}
		_ = stderr.Close()
	}()

	return nil
}

func (b *bridgeClient) readResponseLocked(ctx context.Context) ([]byte, error) {
	type readResult struct {
		line []byte
		err  error
	}
	ch := make(chan readResult, 1)
	go func() {
		line, err := b.stdout.ReadBytes('\n')
		ch <- readResult{line: line, err: err}
	}()

	select {
	case <-ctx.Done():
		b.stopLocked("request canceled")
		return nil, ctx.Err()
	case res := <-ch:
		if res.err != nil {
			return nil, res.err
		}
		line := bytes.TrimSpace(res.line)
		if len(line) == 0 {
			return nil, errors.New("empty bridge response")
		}
		return line, nil
	}
}

func (b *bridgeClient) stopLocked(reason string) {
	if b.cmd == nil {
		return
	}
	if reason != "" {
		log.Printf("[bridge] restarting: %s", reason)
	}
	if b.stdin != nil {
		_ = b.stdin.Close()
	}
	if b.cmd.Process != nil {
		_ = b.cmd.Process.Kill()
	}
	_ = b.cmd.Wait()
	b.cmd = nil
	b.stdin = nil
	b.stdout = nil
}

func main() {
	projectRoot, err := os.Getwd()
	if err != nil {
		log.Fatalf("failed to read cwd: %v", err)
	}
	bridgePath := filepath.Join(projectRoot, "backend", "bridge.mjs")
	if _, err := os.Stat(bridgePath); err != nil {
		log.Fatalf("missing bridge script %s: %v", bridgePath, err)
	}

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "8787"
	}
	bridge := newBridgeClient(projectRoot, bridgePath)
	defer bridge.Close()

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{OK: true})
	})
	mux.HandleFunc("/api/sim/run", makeRunHandler(bridge))
	mux.HandleFunc("/api/sim/preview/tag", makePreviewTagHandler(bridge))
	mux.HandleFunc("/api/sim/preview/range", makePreviewRangeHandler(bridge))
	staticFS := http.FileServer(http.Dir(projectRoot))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Keep frontend assets fresh during active development.
		w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
		w.Header().Set("Pragma", "no-cache")
		w.Header().Set("Expires", "0")
		staticFS.ServeHTTP(w, r)
	}))

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           logMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      0,
		IdleTimeout:       90 * time.Second,
	}

	log.Printf("native backend listening on http://localhost:%s", port)
	log.Printf("serving static files from %s", projectRoot)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Truncate(time.Millisecond))
	})
}

func makeRunHandler(bridge *bridgeClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
			return
		}

		var req runRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: fmt.Sprintf("invalid json: %v", err)})
			return
		}
		cfg := req.Config
		if len(cfg.Players) < 2 || len(cfg.Players) > 6 {
			writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: "players must be between 2 and 6"})
			return
		}

		payload := map[string]any{
			"action": "run-native",
			"config": cfg,
		}
		if req.Workers > 0 {
			payload["workers"] = req.Workers
		}
		var out map[string]any
		bridgeStart := time.Now()
		if err := callBridge(r.Context(), bridge, payload, &out); err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				code = 499
			}
			writeJSON(w, code, apiResponse{OK: false, Error: err.Error()})
			return
		}
		bridgeWallMs := float64(time.Since(bridgeStart)) / float64(time.Millisecond)

		ok, _ := out["ok"].(bool)
		if !ok {
			errMsg, _ := out["error"].(string)
			if errMsg == "" {
				errMsg = "simulation failed"
			}
			writeJSON(w, http.StatusInternalServerError, apiResponse{OK: false, Error: errMsg})
			return
		}
		timings, _ := out["timings"].(map[string]any)
		if timings == nil {
			timings = map[string]any{}
			out["timings"] = timings
		}
		timings["bridgeWallMs"] = bridgeWallMs
		if backendTotal, ok := anyToFloat64(timings["totalMs"]); ok {
			overhead := bridgeWallMs - backendTotal
			if overhead > 0 {
				timings["bridgeOverheadMs"] = overhead
			}
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func makePreviewTagHandler(bridge *bridgeClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
			return
		}
		var req previewTagRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: fmt.Sprintf("invalid json: %v", err)})
			return
		}
		payload := map[string]any{
			"action":    "preview-tag",
			"boardText": req.BoardText,
			"variant":   req.Variant,
			"tag":       req.Tag,
		}
		var out map[string]any
		if err := callBridge(r.Context(), bridge, payload, &out); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{OK: false, Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func makePreviewRangeHandler(bridge *bridgeClient) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
			return
		}
		var req previewRangeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, apiResponse{OK: false, Error: fmt.Sprintf("invalid json: %v", err)})
			return
		}
		payload := map[string]any{
			"action":            "preview-range",
			"boardText":         req.BoardText,
			"variant":           req.Variant,
			"rangeText":         req.RangeText,
			"percentileProfile": req.PercentileProfile,
		}
		var out map[string]any
		if err := callBridge(r.Context(), bridge, payload, &out); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{OK: false, Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func callBridge(ctx context.Context, bridge *bridgeClient, req any, out any) error {
	if bridge == nil {
		return errors.New("bridge unavailable")
	}
	return bridge.Call(ctx, req, out)
}

func anyToFloat64(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case int32:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint64:
		return float64(n), true
	case uint32:
		return float64(n), true
	default:
		return 0, false
	}
}

func chooseWorkerCount(requested, iterCap int, mode string) int {
	workers := runtime.NumCPU()
	if workers < 1 {
		workers = 1
	}
	if requested > 0 && requested < workers {
		workers = requested
	}
	if mode == "exact" {
		if workers > 8 {
			workers = 8
		}
		return maxInt(1, workers)
	}
	if iterCap <= 0 {
		iterCap = 150000
	}
	softByCap := maxInt(1, iterCap/25000)
	if softByCap < workers {
		workers = softByCap
	}
	if workers > 12 {
		workers = 12
	}
	return maxInt(1, workers)
}

func mergeRaw(parts []rawPayload, playerCount int) rawPayload {
	out := rawPayload{
		Wins:         make([]int64, playerCount),
		Ties:         make([]int64, playerCount),
		Losses:       make([]int64, playerCount),
		EquityShares: make([]float64, playerCount),
		ComboLists:   make([][]string, playerCount),
		ClassCounts:  make([][]int64, playerCount),
	}
	for i := range out.ClassCounts {
		out.ClassCounts[i] = make([]int64, 9)
	}
	comboSets := make([]map[string]struct{}, playerCount)
	for i := 0; i < playerCount; i++ {
		comboSets[i] = map[string]struct{}{}
	}

	for _, p := range parts {
		out.Iterations += p.Iterations
		if p.ElapsedMs > out.ElapsedMs {
			out.ElapsedMs = p.ElapsedMs
		}
		for i := 0; i < playerCount; i++ {
			if i < len(p.Wins) {
				out.Wins[i] += p.Wins[i]
			}
			if i < len(p.Ties) {
				out.Ties[i] += p.Ties[i]
			}
			if i < len(p.Losses) {
				out.Losses[i] += p.Losses[i]
			}
			if i < len(p.EquityShares) {
				out.EquityShares[i] += p.EquityShares[i]
			}
			if i < len(p.ClassCounts) {
				row := p.ClassCounts[i]
				for c := 0; c < len(out.ClassCounts[i]) && c < len(row); c++ {
					out.ClassCounts[i][c] += row[c]
				}
			}
			if i < len(p.ComboLists) {
				for _, key := range p.ComboLists[i] {
					comboSets[i][key] = struct{}{}
				}
			}
		}
	}

	for i := 0; i < playerCount; i++ {
		row := make([]string, 0, len(comboSets[i]))
		for key := range comboSets[i] {
			row = append(row, key)
		}
		sort.Strings(row)
		out.ComboLists[i] = row
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func variantHandSize(variant string) int {
	switch strings.ToLower(strings.TrimSpace(variant)) {
	case "holdem":
		return 2
	case "plo4":
		return 4
	case "plo5":
		return 5
	case "plo6":
		return 6
	default:
		return 0
	}
}

func canUseExhaustive(cfg runConfig) bool {
	need := variantHandSize(cfg.Variant)
	if need == 0 {
		return false
	}
	if len(cfg.Players) < 2 || len(cfg.Players) > 6 {
		return false
	}
	for _, p := range cfg.Players {
		if !isExactHandLiteral(strings.TrimSpace(p.Range), need) {
			return false
		}
	}
	return true
}

func isExactHandLiteral(text string, handSize int) bool {
	s := strings.ReplaceAll(strings.TrimSpace(text), " ", "")
	if len(s) != handSize*2 || len(s)%2 != 0 {
		return false
	}
	const ranks = "23456789TJQKA"
	const suits = "cdhs"
	seen := map[string]struct{}{}
	for i := 0; i < len(s); i += 2 {
		r := strings.ToUpper(string(s[i]))
		u := strings.ToLower(string(s[i+1]))
		if !strings.Contains(ranks, r) || !strings.Contains(suits, u) {
			return false
		}
		card := r + u
		if _, exists := seen[card]; exists {
			return false
		}
		seen[card] = struct{}{}
	}
	return true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
