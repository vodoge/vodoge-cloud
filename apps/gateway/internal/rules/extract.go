// Package rules extracts verification codes from SMS bodies.
package rules

import (
	"encoding/json"
	"regexp"
	"strings"
)

var defaultCode = regexp.MustCompile(`(?i)(?:验证码|code|otp)[^\d]{0,8}(\d{4,8})`)
var fallbackDigits = regexp.MustCompile(`\b(\d{4,8})\b`)

// ExtractCode returns the first verification code in body.
func ExtractCode(body string) (string, bool) {
	return ExtractWith(body, nil)
}

// ExtractWith tries tenant-supplied patterns first, then the built-in matchers.
func ExtractWith(body string, extra []*regexp.Regexp) (string, bool) {
	body = strings.TrimSpace(body)
	if body == "" {
		return "", false
	}
	for _, pattern := range extra {
		if pattern == nil {
			continue
		}
		if match := pattern.FindStringSubmatch(body); len(match) >= 2 {
			return match[1], true
		}
	}
	if match := defaultCode.FindStringSubmatch(body); len(match) == 2 {
		return match[1], true
	}
	if match := fallbackDigits.FindStringSubmatch(body); len(match) == 2 {
		return match[1], true
	}
	return "", false
}

// PatternsFrom compiles enabled tenant matcher.body regular expressions.
func PatternsFrom(rules []Rule) []*regexp.Regexp {
	var extras []*regexp.Regexp
	for _, rule := range rules {
		if !rule.Enabled {
			continue
		}
		var matcher struct {
			Body string `json:"body"`
		}
		if err := json.Unmarshal(rule.Matcher, &matcher); err != nil || strings.TrimSpace(matcher.Body) == "" {
			continue
		}
		pattern, err := regexp.Compile(matcher.Body)
		if err != nil {
			continue
		}
		extras = append(extras, pattern)
	}
	return extras
}
