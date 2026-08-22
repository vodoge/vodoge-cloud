// Package observe carries the numbers that say whether this gateway is well.
//
// Written against the standard library rather than a metrics client. The set
// of measurements here is small and fixed, the exposition format is a few
// lines of text, and a dependency tree is a real cost on a host with 1.6 GB of
// memory that also has to build nothing and run everything.
package observe

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

// Registry holds every counter and gauge this process reports.
type Registry struct {
	mu       sync.RWMutex
	counters map[string]*counter
	gauges   map[string]*gauge
	// order preserves declaration order so the output is stable, which makes
	// a diff between two scrapes readable by a person.
	order []string
}

type counter struct {
	help   string
	values sync.Map // label string -> *atomic.Int64
}

type gauge struct {
	help  string
	value atomic.Int64
}

// New returns an empty registry.
func New() *Registry {
	return &Registry{
		counters: map[string]*counter{},
		gauges:   map[string]*gauge{},
	}
}

// Count declares a counter. Declaring is separate from incrementing so that a
// metric reads as zero rather than being absent before anything happens —
// an absent series and a zero one look very different on a graph, and only one
// of them is the truth.
func (registry *Registry) Count(name, help string) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.counters[name]; exists {
		return
	}
	registry.counters[name] = &counter{help: help}
	registry.order = append(registry.order, name)
}

// Gauge declares a gauge.
func (registry *Registry) Gauge(name, help string) {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	if _, exists := registry.gauges[name]; exists {
		return
	}
	registry.gauges[name] = &gauge{help: help}
	registry.order = append(registry.order, name)
}

// Add increments a counter for one label combination.
//
// Labels are given as alternating key and value. An unknown metric is ignored
// rather than panicking: a typo in a metric name should not take down the
// thing being measured.
func (registry *Registry) Add(name string, delta int64, labels ...string) {
	registry.mu.RLock()
	target, ok := registry.counters[name]
	registry.mu.RUnlock()
	if !ok {
		return
	}
	key := formatLabels(labels)
	value, _ := target.values.LoadOrStore(key, &atomic.Int64{})
	value.(*atomic.Int64).Add(delta)
}

// Set replaces a gauge's value.
func (registry *Registry) Set(name string, value int64) {
	registry.mu.RLock()
	target, ok := registry.gauges[name]
	registry.mu.RUnlock()
	if ok {
		target.value.Store(value)
	}
}

// AddGauge moves a gauge by delta, for things counted up and down.
func (registry *Registry) AddGauge(name string, delta int64) {
	registry.mu.RLock()
	target, ok := registry.gauges[name]
	registry.mu.RUnlock()
	if ok {
		target.value.Add(delta)
	}
}

// Expose renders the registry in Prometheus text format.
func (registry *Registry) Expose() string {
	registry.mu.RLock()
	defer registry.mu.RUnlock()

	var out strings.Builder
	for _, name := range registry.order {
		if target, ok := registry.counters[name]; ok {
			fmt.Fprintf(&out, "# HELP %s %s\n# TYPE %s counter\n", name, target.help, name)
			var lines []string
			target.values.Range(func(key, value any) bool {
				lines = append(lines, fmt.Sprintf("%s%s %d",
					name, key.(string), value.(*atomic.Int64).Load()))
				return true
			})
			// Sorted so two scrapes of the same state produce the same text.
			sort.Strings(lines)
			if len(lines) == 0 {
				fmt.Fprintf(&out, "%s 0\n", name)
			}
			for _, line := range lines {
				out.WriteString(line + "\n")
			}
			continue
		}
		if target, ok := registry.gauges[name]; ok {
			fmt.Fprintf(&out, "# HELP %s %s\n# TYPE %s gauge\n%s %d\n",
				name, target.help, name, name, target.value.Load())
		}
	}
	return out.String()
}

// formatLabels turns alternating key/value pairs into `{k="v",k2="v2"}`.
//
// Sorted by key so the same labels given in a different order are one series
// rather than two.
func formatLabels(labels []string) string {
	if len(labels) < 2 {
		return ""
	}
	pairs := make([]string, 0, len(labels)/2)
	for i := 0; i+1 < len(labels); i += 2 {
		// Not %q: that applies Go's own quoting on top of the escaping done
		// here, so every backslash and quote came out doubled.
		pairs = append(pairs, fmt.Sprintf(`%s="%s"`, labels[i], escape(labels[i+1])))
	}
	sort.Strings(pairs)
	return "{" + strings.Join(pairs, ",") + "}"
}

// escape keeps a label value from breaking the exposition format. Values here
// come from route patterns and message kinds, but a value that could close the
// quote would corrupt every metric after it.
func escape(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `"`, `\"`)
	return strings.ReplaceAll(value, "\n", `\n`)
}
