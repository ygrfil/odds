package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type playerConfig struct {
	Name  string `json:"name"`
	Range string `json:"range"`
}

type runConfig struct {
	Variant               string         `json:"variant"`
	IterationCap          int            `json:"iterationCap"`
	Board                 string         `json:"board"`
	Dead                  string         `json:"dead"`
	Players               []playerConfig `json:"players"`
	ConfidenceTargetPct   float64        `json:"confidenceTargetPct,omitempty"`
	ConfidenceMinIters    int            `json:"confidenceMinIterations,omitempty"`
	ConfidenceLevel       float64        `json:"confidenceLevel,omitempty"`
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
	BoardText string `json:"boardText"`
	Variant   string `json:"variant"`
	RangeText string `json:"rangeText"`
}

type bridgeResponse struct {
	OK    bool            `json:"ok"`
	Error string          `json:"error,omitempty"`
	Body  json.RawMessage `json:"-"`
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

	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, apiResponse{OK: false, Error: "method not allowed"})
			return
		}
		writeJSON(w, http.StatusOK, apiResponse{OK: true})
	})
	mux.HandleFunc("/api/sim/run", makeRunHandler(projectRoot, bridgePath))
	mux.HandleFunc("/api/sim/preview/tag", makePreviewTagHandler(projectRoot, bridgePath))
	mux.HandleFunc("/api/sim/preview/range", makePreviewRangeHandler(projectRoot, bridgePath))
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

func makeRunHandler(projectRoot, bridgePath string) http.HandlerFunc {
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
			"action":  "run-native",
			"config":  cfg,
			"workers": req.Workers,
		}
		var out map[string]any
		if err := callBridge(r.Context(), projectRoot, bridgePath, payload, &out); err != nil {
			code := http.StatusInternalServerError
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				code = 499
			}
			writeJSON(w, code, apiResponse{OK: false, Error: err.Error()})
			return
		}

		ok, _ := out["ok"].(bool)
		if !ok {
			errMsg, _ := out["error"].(string)
			if errMsg == "" {
				errMsg = "simulation failed"
			}
			writeJSON(w, http.StatusInternalServerError, apiResponse{OK: false, Error: errMsg})
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func makePreviewTagHandler(projectRoot, bridgePath string) http.HandlerFunc {
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
		if err := callBridge(r.Context(), projectRoot, bridgePath, payload, &out); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{OK: false, Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func makePreviewRangeHandler(projectRoot, bridgePath string) http.HandlerFunc {
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
			"action":    "preview-range",
			"boardText": req.BoardText,
			"variant":   req.Variant,
			"rangeText": req.RangeText,
		}
		var out map[string]any
		if err := callBridge(r.Context(), projectRoot, bridgePath, payload, &out); err != nil {
			writeJSON(w, http.StatusInternalServerError, apiResponse{OK: false, Error: err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func callBridge(ctx context.Context, projectRoot, bridgePath string, req any, out any) error {
	payload, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("marshal request: %w", err)
	}

	cmd := exec.CommandContext(ctx, "node", bridgePath)
	cmd.Dir = projectRoot
	cmd.Stdin = bytes.NewReader(payload)
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = strings.TrimSpace(stdout.String())
		}
		if msg == "" {
			msg = err.Error()
		}
		return fmt.Errorf("bridge failed: %s", msg)
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(stdout.Bytes(), out); err != nil {
		return fmt.Errorf("invalid bridge response: %w", err)
	}
	return nil
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
