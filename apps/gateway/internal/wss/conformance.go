package wss

import (
	"encoding/json"
	"fmt"
	"strings"

	contract "github.com/vodoge/vodoge-cloud/packages/contract"
)

// violations names every field in a payload whose value is outside the enum
// the contract declares for it.
//
// The constraints are generated from the schema rather than written here. The
// hand-written version of this check knew about three fields in one message
// kind, and those three were only discovered after twenty thousand envelopes
// had been stored with values outside the enum. Generating it means a field
// added to the schema is covered without anyone remembering to extend this.
//
// It reports rather than rejects. A non-conformant value is a bug in the
// sender, but dropping the envelope loses a real observation from a device
// that cannot be upgraded on demand, and the projection stores what it is
// given either way. Losing the data as well as the correctness helps nobody.
//
// Absent fields are not violations: the schema makes most of them optional,
// and an older edge simply not sending a field is the expected way to deploy.
func violations(kind contract.MessageKind, payload []byte) []string {
	constraints, ok := contract.PayloadConstraints[kind]
	if !ok || len(constraints) == 0 {
		return nil
	}
	var document any
	if err := json.Unmarshal(payload, &document); err != nil {
		return []string{fmt.Sprintf("%s payload is not valid JSON", kind)}
	}

	var found []string
	for _, constraint := range constraints {
		for _, actual := range valuesAt(document, constraint.Path) {
			if contains(constraint.Enum, actual) {
				continue
			}
			found = append(found, fmt.Sprintf("%s=%q not in {%s}",
				constraint.Path, actual, strings.Join(constraint.Enum, ",")))
		}
	}
	return found
}

// valuesAt returns every string found at a dotted path, following `[]` into
// arrays. A path can match many values — `modems[].state` is one per modem —
// and each is checked, because one bad entry among ten is exactly the case
// that gets missed.
func valuesAt(node any, path string) []string {
	if path == "" {
		if text, ok := node.(string); ok {
			return []string{text}
		}
		return nil
	}

	head, rest, _ := strings.Cut(path, ".")
	if strings.HasSuffix(head, "[]") {
		field := strings.TrimSuffix(head, "[]")
		object, ok := node.(map[string]any)
		if !ok {
			return nil
		}
		items, ok := object[field].([]any)
		if !ok {
			return nil
		}
		var out []string
		for _, item := range items {
			out = append(out, valuesAt(item, rest)...)
		}
		return out
	}

	object, ok := node.(map[string]any)
	if !ok {
		return nil
	}
	child, present := object[head]
	if !present {
		return nil
	}
	return valuesAt(child, rest)
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
