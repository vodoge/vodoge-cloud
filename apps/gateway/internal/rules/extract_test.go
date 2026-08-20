package rules

import "testing"

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
