package ingress

import (
	"bytes"
	"encoding/json"
	"strings"
)

// nulEscape is how a NUL code point reaches us: JSON has no other legal
// spelling for it, and a raw 0x00 byte inside a string is not valid JSON at
// all — Accept rejects that before we are called.
const nulEscape = `\u0000`

// stripNulls removes U+0000 from every string in a JSON payload, reporting
// whether it had to.
//
// PostgreSQL's jsonb has no representation for a NUL code point. Offered one it
// rejects the entire document with 22P05, "unsupported Unicode escape
// sequence" — a data exception, so mapSQLError classifies it ErrMalformed and
// the record is dropped. Three SMS bodies from one device carried a NUL and
// were dropped on every reconnect, forever, because a dropped record never
// consumes its sequence: the device replayed the same three, the window never
// advanced past them, and nothing queued behind them ever arrived.
//
// The NUL is padding, not content. A GSM-7 body cannot contain one — septet
// zero is '@' — but a UCS-2 body padded out to a whole number of octets does,
// and so does anything read from a fixed-size buffer that was not filled.
// Dropping the code point keeps the message; dropping the message to preserve
// the code point does not.
//
// The payload is decoded and re-encoded rather than patched byte-wise because
// the escape and a backslash followed by the five ordinary characters "u0000"
// look identical to a substring scan, and the second must survive untouched.
// Numbers decode through json.Number so a 64-bit epoch re-encodes as itself
// instead of through float64. Key order is not preserved, which costs nothing:
// jsonb does not preserve it either.
func stripNulls(payload []byte) ([]byte, bool) {
	if !bytes.Contains(payload, []byte(nulEscape)) {
		return payload, false
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	var document any
	if err := decoder.Decode(&document); err != nil {
		return payload, false
	}
	cleaned, changed := scrubValue(document)
	if !changed {
		// An escaped backslash before "u0000" lands here: it matched the byte
		// scan but decoded to no NUL. Return the original and re-encode nothing.
		return payload, false
	}
	encoded, err := json.Marshal(cleaned)
	if err != nil {
		return payload, false
	}
	return encoded, true
}

func scrubValue(value any) (any, bool) {
	switch typed := value.(type) {
	case string:
		if !strings.ContainsRune(typed, 0) {
			return typed, false
		}
		return strings.ReplaceAll(typed, "\x00", ""), true

	case []any:
		changed := false
		for index, item := range typed {
			cleaned, itemChanged := scrubValue(item)
			if itemChanged {
				typed[index] = cleaned
				changed = true
			}
		}
		return typed, changed

	case map[string]any:
		// A fresh map rather than an in-place edit: renaming a key means
		// deleting and inserting mid-range, and Go does not define whether the
		// inserted key is visited by the same loop.
		changed := false
		result := make(map[string]any, len(typed))
		for key, item := range typed {
			cleanKey := key
			if strings.ContainsRune(key, 0) {
				cleanKey = strings.ReplaceAll(key, "\x00", "")
				changed = true
			}
			cleanItem, itemChanged := scrubValue(item)
			if itemChanged {
				changed = true
			}
			result[cleanKey] = cleanItem
		}
		return result, changed
	}
	return value, false
}
