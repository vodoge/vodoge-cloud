package directory

import (
	"net/http"
	"testing"
)

func TestSlugFromHost(t *testing.T) {
	t.Parallel()

	cases := []struct {
		host string
		base string
		slug string
		ok   bool
	}{
		{host: "a.vodoge.com", slug: "a", ok: true},
		{host: "A.VoDoge.COM", slug: "a", ok: true},
		{host: "a.vodoge.com:443", slug: "a", ok: true},
		{host: "b.vodoge.com", slug: "b", ok: true},
		{host: "vodoge.com", ok: false},
		{host: "www.vodoge.com", ok: false},
		{host: "foo.bar.vodoge.com", ok: false},
		{host: "a.example.com", ok: false},
		{host: "a.vodoge.com.evil.com", ok: false},
		{host: "", ok: false},
	}
	for _, tc := range cases {
		slug, ok := SlugFromHost(tc.host, tc.base)
		if ok != tc.ok || slug != tc.slug {
			t.Errorf("SlugFromHost(%q) = %q, %v; want %q, %v", tc.host, slug, ok, tc.slug, tc.ok)
		}
	}
}

func TestRequestHostPrefersForwardedHost(t *testing.T) {
	t.Parallel()

	request := &http.Request{Host: "127.0.0.1:18080", Header: http.Header{}}
	request.Header.Set("X-Forwarded-Host", "a.vodoge.com, localhost")
	if got := requestHost(request); got != "a.vodoge.com" {
		t.Fatalf("requestHost = %q", got)
	}
}
