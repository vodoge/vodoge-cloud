// Package rules extracts verification codes from SMS bodies.
package rules

import (
	"regexp"
	"strings"
)

var defaultCode = regexp.MustCompile(`(?i)(?:验证码|code|otp)[^\d]{0,8}(\d{4,8})`)
var fallbackDigits = regexp.MustCompile(`\b(\d{4,8})\b`)

// ExtractCode returns the first verification code in body.
func ExtractCode(body string) (string, bool) {
	body = strings.TrimSpace(body)
	if body == "" {
		return "", false
	}
	if match := defaultCode.FindStringSubmatch(body); len(match) == 2 {
		return match[1], true
	}
	if match := fallbackDigits.FindStringSubmatch(body); len(match) == 2 {
		return match[1], true
	}
	return "", false
}
