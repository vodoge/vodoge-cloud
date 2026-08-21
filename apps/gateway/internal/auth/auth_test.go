package auth

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type memoryStore struct {
	users    map[string]User
	sessions map[string]Session
	created  int
	deleted  int
}

func newMemoryStore() *memoryStore {
	return &memoryStore{users: map[string]User{}, sessions: map[string]Session{}}
}

func (store *memoryStore) User(_ context.Context, tenantID, email string) (User, bool, error) {
	user, ok := store.users[tenantID+"|"+email]
	return user, ok, nil
}

func (store *memoryStore) Session(_ context.Context, fingerprint []byte) (Session, bool, error) {
	session, ok := store.sessions[string(fingerprint)]
	return session, ok, nil
}

func (store *memoryStore) CreateSession(_ context.Context, fingerprint []byte, session Session) error {
	store.created++
	store.sessions[string(fingerprint)] = session
	return nil
}

func (store *memoryStore) DeleteSession(_ context.Context, fingerprint []byte) error {
	store.deleted++
	delete(store.sessions, string(fingerprint))
	return nil
}

// plainHasher stands in for bcrypt so tests do not pay its cost.
type plainHasher struct{ compares int }

func (hasher *plainHasher) Compare(hash, password string) bool {
	hasher.compares++
	return hash != "" && hash == "hash:"+password
}

func (hasher *plainHasher) Hash(password string) (string, error) {
	return "hash:" + password, nil
}

func TestNewTokenIsOpaqueAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		token, err := NewToken()
		if err != nil {
			t.Fatalf("NewToken: %v", err)
		}
		if len(token) < 40 {
			t.Fatalf("token is too short to carry %d bytes: %q", TokenBytes, token)
		}
		if seen[token] {
			t.Fatalf("token repeated: %q", token)
		}
		seen[token] = true
	}
}

// A stored fingerprint must not be reversible to the token, so nothing that
// reads the table can present a session.
func TestFingerprintDoesNotContainTheToken(t *testing.T) {
	token, err := NewToken()
	if err != nil {
		t.Fatalf("NewToken: %v", err)
	}
	fingerprint := Fingerprint(token)
	if len(fingerprint) != 32 {
		t.Fatalf("fingerprint is %d bytes, want 32", len(fingerprint))
	}
	if strings.Contains(string(fingerprint), token) {
		t.Fatal("fingerprint contains the token")
	}
	if string(Fingerprint(token)) != string(fingerprint) {
		t.Fatal("fingerprint is not stable")
	}
	if string(Fingerprint(token+"x")) == string(fingerprint) {
		t.Fatal("different tokens share a fingerprint")
	}
}

func TestBearerTokenReadsTheScheme(t *testing.T) {
	cases := map[string]string{
		"Bearer abc":    "abc",
		"bearer abc":    "abc",
		"BEARER  abc  ": "abc",
		"":              "",
		"abc":           "",
		"Basic abc":     "",
		"Bearer":        "",
		"Bearer ":       "",
	}
	for header, want := range cases {
		if got := BearerToken(header); got != want {
			t.Fatalf("BearerToken(%q) = %q, want %q", header, got, want)
		}
	}
}

func TestAuthenticateAcceptsAMatchingSession(t *testing.T) {
	store := newMemoryStore()
	now := time.Now()
	token := "token-a"
	store.sessions[string(Fingerprint(token))] = Session{
		UserID:    "user-1",
		TenantID:  "tenant-a",
		ExpiresAt: now.Add(time.Hour),
	}
	session, err := Authenticate(context.Background(), store, "Bearer "+token, "tenant-a", now)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if session.UserID != "user-1" {
		t.Fatalf("user = %q", session.UserID)
	}
}

// The whole point of the change: a valid session for one tenant must not read
// another tenant's data just because the Host header says so.
func TestAuthenticateRejectsASessionFromAnotherTenant(t *testing.T) {
	store := newMemoryStore()
	now := time.Now()
	token := "token-a"
	store.sessions[string(Fingerprint(token))] = Session{
		UserID:    "user-1",
		TenantID:  "tenant-a",
		ExpiresAt: now.Add(time.Hour),
	}
	_, err := Authenticate(context.Background(), store, "Bearer "+token, "tenant-b", now)
	if !errors.Is(err, ErrTenantMismatch) {
		t.Fatalf("err = %v, want ErrTenantMismatch", err)
	}
}

// A host that resolved to no tenant must not fall through to whatever the
// session says; an unknown subdomain has to stay unknown.
func TestAuthenticateRejectsAnUnresolvedHost(t *testing.T) {
	store := newMemoryStore()
	now := time.Now()
	token := "token-a"
	store.sessions[string(Fingerprint(token))] = Session{
		UserID:    "user-1",
		TenantID:  "tenant-a",
		ExpiresAt: now.Add(time.Hour),
	}
	_, err := Authenticate(context.Background(), store, "Bearer "+token, "", now)
	if !errors.Is(err, ErrTenantMismatch) {
		t.Fatalf("err = %v, want ErrTenantMismatch", err)
	}
}

func TestAuthenticateRejectsAnExpiredSession(t *testing.T) {
	store := newMemoryStore()
	now := time.Now()
	token := "token-a"
	store.sessions[string(Fingerprint(token))] = Session{
		UserID:    "user-1",
		TenantID:  "tenant-a",
		ExpiresAt: now.Add(-time.Second),
	}
	_, err := Authenticate(context.Background(), store, "Bearer "+token, "tenant-a", now)
	if !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("err = %v, want ErrInvalidSession", err)
	}
}

func TestAuthenticateWithoutACredentialIsDistinct(t *testing.T) {
	store := newMemoryStore()
	_, err := Authenticate(context.Background(), store, "", "tenant-a", time.Now())
	if !errors.Is(err, ErrNoCredential) {
		t.Fatalf("err = %v, want ErrNoCredential", err)
	}
}

func TestSignInIssuesASessionForTheRightTenant(t *testing.T) {
	store := newMemoryStore()
	hasher := &plainHasher{}
	store.users["tenant-a|ops@example.com"] = User{
		ID:           "user-1",
		TenantID:     "tenant-a",
		Email:        "ops@example.com",
		PasswordHash: "hash:correct-horse",
		Status:       "active",
	}
	now := time.Now()
	token, session, err := SignIn(
		context.Background(), store, store, hasher,
		"tenant-a", "OPS@Example.com", "correct-horse", now, time.Hour,
	)
	if err != nil {
		t.Fatalf("SignIn: %v", err)
	}
	if token == "" {
		t.Fatal("no token issued")
	}
	if session.TenantID != "tenant-a" || session.UserID != "user-1" {
		t.Fatalf("session = %+v", session)
	}
	if !session.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("expiry = %v", session.ExpiresAt)
	}
	// The stored key is the fingerprint, never the token.
	if _, ok := store.sessions[token]; ok {
		t.Fatal("session stored under the raw token")
	}
	if _, ok := store.sessions[string(Fingerprint(token))]; !ok {
		t.Fatal("session not stored under its fingerprint")
	}
}

func TestSignInRejectsAWrongPassword(t *testing.T) {
	store := newMemoryStore()
	hasher := &plainHasher{}
	store.users["tenant-a|ops@example.com"] = User{
		ID: "user-1", TenantID: "tenant-a", Email: "ops@example.com",
		PasswordHash: "hash:correct-horse", Status: "active",
	}
	_, _, err := SignIn(
		context.Background(), store, store, hasher,
		"tenant-a", "ops@example.com", "wrong", time.Now(), time.Hour,
	)
	if !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("err = %v, want ErrBadCredentials", err)
	}
	if store.created != 0 {
		t.Fatal("a session was created for a failed sign-in")
	}
}

// A user of one tenant must not be able to sign in through another tenant's
// host, even with the correct password.
func TestSignInIsScopedToTheTenant(t *testing.T) {
	store := newMemoryStore()
	hasher := &plainHasher{}
	store.users["tenant-a|ops@example.com"] = User{
		ID: "user-1", TenantID: "tenant-a", Email: "ops@example.com",
		PasswordHash: "hash:correct-horse", Status: "active",
	}
	_, _, err := SignIn(
		context.Background(), store, store, hasher,
		"tenant-b", "ops@example.com", "correct-horse", time.Now(), time.Hour,
	)
	if !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("err = %v, want ErrBadCredentials", err)
	}
}

// Returning early for an unknown address makes the response time reveal which
// addresses are registered.
func TestSignInComparesEvenForAnUnknownUser(t *testing.T) {
	store := newMemoryStore()
	hasher := &plainHasher{}
	_, _, err := SignIn(
		context.Background(), store, store, hasher,
		"tenant-a", "nobody@example.com", "whatever", time.Now(), time.Hour,
	)
	if !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("err = %v, want ErrBadCredentials", err)
	}
	if hasher.compares == 0 {
		t.Fatal("no comparison was performed for an unknown address")
	}
}

// The disabled check comes after the password so it cannot be used to probe
// which addresses exist.
func TestSignInRejectsADisabledAccountOnlyAfterThepassword(t *testing.T) {
	store := newMemoryStore()
	hasher := &plainHasher{}
	store.users["tenant-a|ops@example.com"] = User{
		ID: "user-1", TenantID: "tenant-a", Email: "ops@example.com",
		PasswordHash: "hash:correct-horse", Status: "disabled",
	}
	_, _, err := SignIn(
		context.Background(), store, store, hasher,
		"tenant-a", "ops@example.com", "correct-horse", time.Now(), time.Hour,
	)
	if !errors.Is(err, ErrUserDisabled) {
		t.Fatalf("err = %v, want ErrUserDisabled", err)
	}
	_, _, err = SignIn(
		context.Background(), store, store, hasher,
		"tenant-a", "ops@example.com", "wrong", time.Now(), time.Hour,
	)
	if !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("wrong password on a disabled account leaked its status: %v", err)
	}
}

func TestSignInFallsBackToTheDefaultTTL(t *testing.T) {
	store := newMemoryStore()
	hasher := &plainHasher{}
	store.users["tenant-a|ops@example.com"] = User{
		ID: "user-1", TenantID: "tenant-a", Email: "ops@example.com",
		PasswordHash: "hash:correct-horse", Status: "active",
	}
	now := time.Now()
	_, session, err := SignIn(
		context.Background(), store, store, hasher,
		"tenant-a", "ops@example.com", "correct-horse", now, 0,
	)
	if err != nil {
		t.Fatalf("SignIn: %v", err)
	}
	if !session.ExpiresAt.Equal(now.Add(DefaultSessionTTL)) {
		t.Fatalf("expiry = %v", session.ExpiresAt)
	}
}

func TestSignOutRemovesTheSession(t *testing.T) {
	store := newMemoryStore()
	token := "token-a"
	store.sessions[string(Fingerprint(token))] = Session{TenantID: "tenant-a"}
	if err := SignOut(context.Background(), store, "Bearer "+token); err != nil {
		t.Fatalf("SignOut: %v", err)
	}
	if len(store.sessions) != 0 {
		t.Fatal("session survived sign-out")
	}
}

// The caller wanted the session gone and it is; failing here would only make
// sign-out unreliable for an already-expired cookie.
func TestSignOutOfAnUnknownTokenSucceeds(t *testing.T) {
	store := newMemoryStore()
	if err := SignOut(context.Background(), store, "Bearer nope"); err != nil {
		t.Fatalf("SignOut: %v", err)
	}
}
