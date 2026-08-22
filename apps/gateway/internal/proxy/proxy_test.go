package proxy

import (
	"context"
	"strings"
	"testing"
	"time"
)

func timeZero() time.Time { return time.UnixMilli(0) }

const benchIMEI = "867018069514820"

func TestInstanceValidationRefusesWhatCannotListen(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		instance Instance
		wants    string
	}{
		{"no name", Instance{DeviceID: "d", ModemIMEI: benchIMEI, ListenPort: 1080}, "name is required"},
		{"no device", Instance{Name: "n", ModemIMEI: benchIMEI, ListenPort: 1080}, "device_id is required"},
		{"imei that is not one", Instance{Name: "n", DeviceID: "d", ModemIMEI: "86701", ListenPort: 1080},
			"15 digits"},
		{"listen address that is not an address",
			Instance{Name: "n", DeviceID: "d", ModemIMEI: benchIMEI, ListenAddr: "everywhere", ListenPort: 1080},
			"must be an IP address"},
		{"port out of range",
			Instance{Name: "n", DeviceID: "d", ModemIMEI: benchIMEI, ListenPort: 70000},
			"between 1 and 65535"},
		// The edge runs without the privileges a low port needs, so this
		// would bind-fail on the device with a message nobody sees.
		{"privileged port",
			Instance{Name: "n", DeviceID: "d", ModemIMEI: benchIMEI, ListenPort: 80},
			"1024 or above"},
		{"auth with no user",
			Instance{Name: "n", DeviceID: "d", ModemIMEI: benchIMEI, ListenPort: 1080, AuthEnabled: true},
			"username is required"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			instance := testCase.instance
			err := ValidateInstance(&instance)
			if err == nil {
				t.Fatal("expected a rejection")
			}
			if !strings.Contains(err.Error(), testCase.wants) {
				t.Fatalf("error = %q, want it to mention %q", err, testCase.wants)
			}
		})
	}
}

func TestValidationFillsTheDefaultsTheEdgeExpects(t *testing.T) {
	t.Parallel()

	instance := Instance{Name: "lab", DeviceID: "d", ModemIMEI: benchIMEI, ListenPort: 1080}
	if err := ValidateInstance(&instance); err != nil {
		t.Fatal(err)
	}
	if instance.Protocol != "socks5" {
		t.Fatalf("protocol = %q, want socks5", instance.Protocol)
	}
	if instance.ListenAddr != "0.0.0.0" {
		t.Fatalf("listen_addr = %q, want 0.0.0.0", instance.ListenAddr)
	}
}

func TestUpstreamAddressMustBeHostAndPort(t *testing.T) {
	t.Parallel()

	for _, address := range []string{"", "example.com", "example.com:", "example.com:0", "h:99999"} {
		upstream := Upstream{Name: "u", Address: address}
		if err := ValidateUpstream(&upstream); err == nil {
			t.Fatalf("address %q should be refused", address)
		}
	}
	upstream := Upstream{Name: "u", Address: "proxy.example.com:1080"}
	if err := ValidateUpstream(&upstream); err != nil {
		t.Fatal(err)
	}
	if upstream.Protocol != "socks5" {
		t.Fatalf("protocol = %q, want socks5", upstream.Protocol)
	}
}

func TestCountryCodesAreNormalised(t *testing.T) {
	t.Parallel()

	rule := CountryRule{CountryCode: " cn "}
	if err := ValidateCountryRule(&rule); err != nil {
		t.Fatal(err)
	}
	if rule.CountryCode != "CN" {
		t.Fatalf("country_code = %q, want CN", rule.CountryCode)
	}
	for _, code := range []string{"C", "CHN", "C1"} {
		bad := CountryRule{CountryCode: code}
		if err := ValidateCountryRule(&bad); err == nil {
			t.Fatalf("country_code %q should be refused", code)
		}
	}
}

// A stored proxy password must never come back out of the store: the console
// writes it and shows only that one exists.
func TestStoredPasswordsAreNotReadable(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	if _, err := store.SaveUpstream(ctx, "t", Upstream{
		Name: "u", Address: "h:1080", Password: "secret",
	}); err != nil {
		t.Fatal(err)
	}
	list, err := store.Upstreams(ctx, "t")
	if err != nil {
		t.Fatal(err)
	}
	if list[0].Password != "" {
		t.Fatal("the password came back out of the store")
	}
	if !list[0].HasPassword {
		t.Fatal("the console cannot tell that a password is stored")
	}
}

// Saving an edit without a password keeps the stored one, because the console
// never received it and therefore cannot resend it.
func TestAnEditWithoutAPasswordKeepsTheStoredOne(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	id, err := store.SaveUpstream(ctx, "t", Upstream{
		Name: "u", Address: "h:1080", Password: "secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.SaveUpstream(ctx, "t", Upstream{
		ID: id, Name: "renamed", Address: "h:1080",
	}); err != nil {
		t.Fatal(err)
	}
	list, _ := store.Upstreams(ctx, "t")
	if list[0].Name != "renamed" {
		t.Fatalf("name = %q, want renamed", list[0].Name)
	}
	if !list[0].HasPassword {
		t.Fatal("renaming an upstream erased its password")
	}
}

// Two listeners on one port is a configuration that can only ever half work,
// so it is refused where it is written rather than discovered on the device.
func TestOnePortPerDevice(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	first := Instance{Name: "a", DeviceID: "d1", ModemIMEI: benchIMEI, ListenPort: 1080}
	if _, err := store.SaveInstance(ctx, "t", first); err != nil {
		t.Fatal(err)
	}
	second := Instance{Name: "b", DeviceID: "d1", ModemIMEI: benchIMEI, ListenPort: 1080}
	if _, err := store.SaveInstance(ctx, "t", second); err == nil {
		t.Fatal("a duplicate port should be refused")
	}
	// The same port on a different device is fine — different machine.
	other := Instance{Name: "c", DeviceID: "d2", ModemIMEI: benchIMEI, ListenPort: 1080}
	if _, err := store.SaveInstance(ctx, "t", other); err != nil {
		t.Fatalf("same port on another device: %v", err)
	}
}

// The edge reports what it counted since its last report, so a second report
// in the same hour adds to the first. Replacing would erase the part of the
// hour already sent whenever a device reconnects mid-hour.
func TestTrafficAccumulatesWithinAnHour(t *testing.T) {
	t.Parallel()

	store := &Memory{}
	ctx := context.Background()
	hour := int64(1787378400000)
	for i := 0; i < 3; i++ {
		if err := store.AddTraffic(ctx, "t", []TrafficPoint{{
			InstanceID: "i1", Hour: hour + int64(i)*60_000,
			BytesUp: 100, BytesDown: 200, Connections: 1,
		}}); err != nil {
			t.Fatal(err)
		}
	}
	points, err := store.Traffic(ctx, "t", timeZero())
	if err != nil {
		t.Fatal(err)
	}
	if len(points) != 1 {
		t.Fatalf("points = %d, want the three reports folded into one hour", len(points))
	}
	if points[0].BytesUp != 300 || points[0].Connections != 3 {
		t.Fatalf("point = %+v, want the totals added", points[0])
	}
}
