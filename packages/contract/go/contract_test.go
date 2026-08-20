package contract

import "testing"

func TestSequencedKindsMatchCatalog(t *testing.T) {
	t.Parallel()

	if !MessageKindSmsReceived.Sequenced() {
		t.Fatal("SmsReceived must be sequenced")
	}
	if MessageKindResume.Sequenced() {
		t.Fatal("Resume must not be sequenced")
	}
	if ProtocolVersion != 1 {
		t.Fatalf("protocol version = %d, want 1", ProtocolVersion)
	}
	if WebSocketSubprotocol != "vodoge.edge.v1" {
		t.Fatalf("subprotocol = %q", WebSocketSubprotocol)
	}
}
