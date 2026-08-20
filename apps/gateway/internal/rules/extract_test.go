package rules

import (
	"regexp"
	"testing"
)

func TestExtractCode(t *testing.T) {
	t.Parallel()

	code, ok := ExtractCode("【银行】验证码 123456，5分钟内有效")
	if !ok || code != "123456" {
		t.Fatalf("got %q %v", code, ok)
	}
	code, ok = ExtractCode("Your code is 9988")
	if !ok || code != "9988" {
		t.Fatalf("got %q %v", code, ok)
	}
	if _, ok := ExtractCode("no digits here"); ok {
		t.Fatal("expected no code")
	}
}

func TestExtractWithPrefersTenantPatterns(t *testing.T) {
	t.Parallel()

	custom := regexp.MustCompile(`PIN[:\s]+(\d{4})`)
	code, ok := ExtractWith("PIN: 4321 extra 999999", []*regexp.Regexp{custom})
	if !ok || code != "4321" {
		t.Fatalf("got %q %v", code, ok)
	}
}
