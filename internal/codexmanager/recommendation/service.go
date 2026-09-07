package recommendation

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"abolqasem/internal/codexmanager/account"
	"abolqasem/internal/codexmanager/limits"
)

const (
	staleAfter      = 15 * time.Minute
	veryStaleAfter  = time.Hour
	pacingNearReset = 12 * time.Hour
	pacingBuffer    = 5.0
)

func Select(candidates []Candidate, now time.Time) Selection {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	healthy := 0
	for _, candidate := range candidates {
		if candidate.State == account.StateReady && codexLimit(candidate.Limits) != nil {
			healthy++
		}
	}
	if healthy == 0 {
		healthy = 1
	}
	selection := Selection{Results: make(map[string]Result, len(candidates)), At: now}
	ranked := make([]Result, 0, len(candidates))
	plans := make(map[string]account.Plan, len(candidates))
	for _, candidate := range candidates {
		result := score(candidate, healthy, now)
		selection.Results[candidate.Name] = result
		ranked = append(ranked, result)
		plans[candidate.Name] = candidate.Plan
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		leftPlan, rightPlan := plans[ranked[i].Account], plans[ranked[j].Account]
		if (leftPlan == account.PlanFree) != (rightPlan == account.PlanFree) {
			return leftPlan != account.PlanFree
		}
		if ranked[i].Score != ranked[j].Score {
			return ranked[i].Score > ranked[j].Score
		}
		return strings.ToLower(ranked[i].Account) < strings.ToLower(ranked[j].Account)
	})
	for _, result := range ranked {
		if result.Recommendable {
			copy := result
			copy.Best = true
			copy.Label = Best
			selection.Results[copy.Account] = copy
			selection.Best = &copy
			return selection
		}
	}
	if len(ranked) > 0 && ranked[0].Score > -math.MaxFloat64 {
		copy := ranked[0]
		copy.Best = true
		copy.Label = Risk
		selection.Results[copy.Account] = copy
		selection.Best = &copy
	}
	return selection
}

func score(candidate Candidate, healthyCount int, now time.Time) Result {
	if candidate.State == account.StateNeedsLogin || candidate.State == account.StateError {
		return Result{Account: candidate.Name, Label: Login, Reason: string(candidate.State), Score: -math.MaxFloat64}
	}
	if candidate.State == account.StateStale {
		return Result{Account: candidate.Name, Label: Stale, Reason: "account verification is stale; refresh limits before activation", Score: -math.MaxFloat64}
	}
	limit := codexLimit(candidate.Limits)
	if limit == nil {
		return Result{Account: candidate.Name, Label: Check, Reason: "run Check Now to refresh limits", Score: -math.MaxFloat64}
	}
	age := now.Sub(candidate.Limits.FetchedAt)
	stale := candidate.Limits.FetchedAt.IsZero() || age > staleAfter
	veryStale := candidate.Limits.FetchedAt.IsZero() || age > veryStaleAfter
	if len(limit.Windows) == 0 {
		return Result{Account: candidate.Name, Label: Check, Reason: "missing limit data", Score: -math.MaxFloat64}
	}
	pacing := limit.Windows[0]
	pacingPeriod := windowPeriod(pacing)
	for _, window := range limit.Windows[1:] {
		if period := windowPeriod(window); period > pacingPeriod {
			pacing, pacingPeriod = window, period
		}
	}
	for _, window := range limit.Windows {
		if window.RemainingPercent <= 0 {
			return Result{Account: candidate.Name, Label: Save, Reason: window.Label + " limit reached", Score: -math.MaxFloat64, Remaining: pacing.RemainingPercent, PacingLabel: pacing.Label}
		}
	}
	remainingTime := resetRemaining(pacing, now, pacingPeriod)
	target := targetFor(remainingTime, pacingPeriod, healthyCount, stale)
	health := pacing.RemainingPercent - target
	protected := health < -pacingBuffer && (remainingTime == nil || *remainingTime > pacingNearReset)
	urgency := 0.0
	if remainingTime != nil && pacingPeriod > 0 {
		urgency = 100 * (1 - math.Max(0, math.Min(1, remainingTime.Seconds()/pacingPeriod.Seconds())))
	}
	score := health*3 + pacing.RemainingPercent*.15 + urgency*.35
	if protected {
		score -= 120
	}
	if candidate.State == account.StateStale {
		score -= 30
	}
	if candidate.Limits.FetchedAt.IsZero() {
		score -= 35
	} else if age > staleAfter {
		score -= math.Min(35, (age-staleAfter).Seconds()/180)
	}
	label := OK
	if protected {
		label = Save
	} else if stale {
		label = Stale
	}
	reason := fmt.Sprintf("%s %.0f%% vs target %.0f%% (%+.0f)", pacing.Label, pacing.RemainingPercent, target, health)
	if remainingTime != nil {
		reason += fmt.Sprintf(", %s reset in %s, reset priority %.0f", pacing.Label, remainingTime.Round(time.Minute), urgency)
	}
	if protected {
		reason += ", protect pace"
	} else if stale {
		reason += ", stale sample"
	}
	return Result{Account: candidate.Name, Label: label, Score: score, Reason: reason, Recommendable: !protected && !veryStale, Remaining: pacing.RemainingPercent, Target: target, Health: health, PacingLabel: pacing.Label}
}

// EmptySnapshot makes it explicit that recommendation must never consult
// historical samples after a failed or missing live verification.
func EmptySnapshot(accountName string) limits.Snapshot { return limits.Snapshot{Account: accountName} }

func codexLimit(snapshot limits.Snapshot) *limits.Limit {
	for index := range snapshot.Limits {
		if snapshot.Limits[index].ID == "codex" {
			return &snapshot.Limits[index]
		}
	}
	if len(snapshot.Limits) > 0 {
		return &snapshot.Limits[0]
	}
	return nil
}

func windowPeriod(window limits.Window) time.Duration {
	if window.WindowMinutes == nil || *window.WindowMinutes <= 0 {
		return 7 * 24 * time.Hour
	}
	return time.Duration(*window.WindowMinutes) * time.Minute
}

func resetRemaining(window limits.Window, now time.Time, period time.Duration) *time.Duration {
	if window.ResetAt == nil {
		return nil
	}
	remaining := window.ResetAt.Sub(now)
	if remaining < 0 {
		remaining = 0
	}
	if remaining > period {
		remaining = period
	}
	return &remaining
}

func targetFor(remaining *time.Duration, period time.Duration, healthy int, stale bool) float64 {
	if remaining == nil || period <= 0 {
		return 50
	}
	target := 100 * math.Max(0, math.Min(1, remaining.Seconds()/period.Seconds()))
	safety := 8.0
	if healthy <= 2 {
		safety = 14
	} else if healthy <= 4 {
		safety = 10
	}
	if stale {
		safety += 3
	}
	return math.Min(100, target+safety)
}
