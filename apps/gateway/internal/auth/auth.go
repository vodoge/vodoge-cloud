// Package auth turns a console credential into a tenant-scoped identity.
//
// The gateway used to take the tenant from the Host header alone, so anything
// that could reach its HTTP port could speak for any tenant; only the port
// being bound to localhost stood in the way, and that is a deployment detail
// rather than a boundary. Tenant identity now comes from a session, and Host
// is checked against it rather than believed.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"
	"time"
)

var (
	// ErrNoCredential means the request carried nothing to authenticate.
	ErrNoCredential = errors.New("no session credential")
	// ErrInvalidSession covers an unknown, expired or malformed token. The
	// cases are not distinguished on purpose: telling a caller which one it
	// was tells them whether a token exists.
	ErrInvalidSession = errors.New("session is not valid")
	// ErrTenantMismatch means a valid session was presented against a host
	// belonging to a different tenant.
	ErrTenantMismatch = errors.New("session does not belong to this tenant")
	// ErrBadCredentials covers an unknown user and a wrong password alike.
	ErrBadCredentials = errors.New("email or password is incorrect")
	// ErrUserDisabled means the account exists but may not sign in.
	ErrUserDisabled = errors.New("account is disabled")
	// ErrWeakPassword covers a new password that is too short, and one that
	// is the same as the password being replaced.
	ErrWeakPassword = errors.New("choose a different password of at least 12 characters")
)

// TokenBytes is the entropy in a session token. 32 bytes is well past what a
// remote attacker can search, and the token is opaque so it never needs to
// carry anything.
const TokenBytes = 32

// DefaultSessionTTL is how long a console session stays valid.
const DefaultSessionTTL = 12 * time.Hour

// Session is a validated credential.
type Session struct {
	UserID    string
	TenantID  string
	ExpiresAt time.Time
}

// User is a console operator as stored.
type User struct {
	ID           string
	TenantID     string
	Email        string
	PasswordHash string
	Status       string
}

// Active reports whether this account may sign in.
func (user User) Active() bool {
	return user.Status == "active"
}

// NewToken returns an opaque session token.
func NewToken() (string, error) {
	buffer := make([]byte, TokenBytes)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buffer), nil
}

// Fingerprint is what gets stored for a token.
//
// Storing the token itself would mean a database dump handed over live
// sessions. A hash makes a dump only as useful as the sessions it can no
// longer forge.
func Fingerprint(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// BearerToken extracts the token from an Authorization header value.
func BearerToken(header string) string {
	const prefix = "bearer "
	trimmed := strings.TrimSpace(header)
	if len(trimmed) <= len(prefix) {
		return ""
	}
	if !strings.EqualFold(trimmed[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(trimmed[len(prefix):])
}

// SessionStore reads and writes sessions.
type SessionStore interface {
	Session(ctx context.Context, fingerprint []byte) (Session, bool, error)
	CreateSession(ctx context.Context, fingerprint []byte, session Session) error
	DeleteSession(ctx context.Context, fingerprint []byte) error
}

// UserStore reads console operators.
type UserStore interface {
	User(ctx context.Context, tenantID, email string) (User, bool, error)
}

// PasswordHasher compares a candidate against a stored hash.
//
// An interface so the comparison can be exercised without paying bcrypt's cost
// in every test, and so the cost factor is a deployment decision.
type PasswordHasher interface {
	Compare(hash, password string) bool
	Hash(password string) (string, error)
}

// Authenticate validates a bearer token and confirms it belongs to the tenant
// the request was addressed to.
//
// Both halves matter. Without the token there is no identity at all; without
// the host check a valid session for one tenant reads another tenant's data
// just by changing the Host header.
func Authenticate(
	ctx context.Context,
	store SessionStore,
	authorization string,
	hostTenantID string,
	now time.Time,
) (Session, error) {
	token := BearerToken(authorization)
	if token == "" {
		return Session{}, ErrNoCredential
	}
	if store == nil {
		return Session{}, ErrInvalidSession
	}
	session, found, err := store.Session(ctx, Fingerprint(token))
	if err != nil {
		return Session{}, err
	}
	if !found {
		return Session{}, ErrInvalidSession
	}
	// The store filters expired rows, but a store is a moving part and this
	// check costs nothing.
	if !session.ExpiresAt.After(now) {
		return Session{}, ErrInvalidSession
	}
	if hostTenantID == "" {
		return Session{}, ErrTenantMismatch
	}
	if subtle.ConstantTimeCompare([]byte(session.TenantID), []byte(hostTenantID)) != 1 {
		return Session{}, ErrTenantMismatch
	}
	return session, nil
}

// SignIn verifies a credential and issues a session.
//
// The tenant comes from the caller, which resolved it from the Host. That
// scopes the attempt rather than granting anything: the password still has to
// match a user inside that tenant.
func SignIn(
	ctx context.Context,
	users UserStore,
	sessions SessionStore,
	hasher PasswordHasher,
	tenantID, email, password string,
	now time.Time,
	ttl time.Duration,
) (string, Session, error) {
	if users == nil || sessions == nil || hasher == nil {
		return "", Session{}, ErrBadCredentials
	}
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" || password == "" {
		return "", Session{}, ErrBadCredentials
	}
	user, found, err := users.User(ctx, tenantID, email)
	if err != nil {
		return "", Session{}, err
	}
	if !found {
		// Compare against nothing anyway. Returning early for an unknown
		// address makes the response time say whether the account exists.
		hasher.Compare("", password)
		return "", Session{}, ErrBadCredentials
	}
	if !hasher.Compare(user.PasswordHash, password) {
		return "", Session{}, ErrBadCredentials
	}
	// Checked after the password so a disabled account cannot be used to probe
	// which addresses are registered.
	if !user.Active() {
		return "", Session{}, ErrUserDisabled
	}
	token, err := NewToken()
	if err != nil {
		return "", Session{}, err
	}
	if ttl <= 0 {
		ttl = DefaultSessionTTL
	}
	session := Session{
		UserID:    user.ID,
		TenantID:  user.TenantID,
		ExpiresAt: now.Add(ttl),
	}
	if err := sessions.CreateSession(ctx, Fingerprint(token), session); err != nil {
		return "", Session{}, err
	}
	return token, session, nil
}

// SignOut removes a session. An unknown token is not an error: the caller
// wanted the session gone and it is.
func SignOut(ctx context.Context, sessions SessionStore, authorization string) error {
	token := BearerToken(authorization)
	if token == "" || sessions == nil {
		return nil
	}
	return sessions.DeleteSession(ctx, Fingerprint(token))
}

// MinPasswordLength is the shortest password a console operator may choose.
//
// Twelve, matching what vodoge-admin has always enforced when creating an
// account. A shorter minimum on the self-service path would mean the policy
// depends on which door the password came through.
const MinPasswordLength = 12

// PasswordChanger updates a stored credential.
type PasswordChanger interface {
	// keepFingerprint is the caller's own session, which survives; every other
	// session the account holds is ended.
	SetPassword(ctx context.Context, tenantID, userID, hash string, keepFingerprint []byte) error
	UserByID(ctx context.Context, tenantID, userID string) (User, bool, error)
}

// ChangePassword replaces a signed-in operator's password.
//
// The current password is required even though the caller already holds a
// valid session: a session can be a borrowed laptop, and a password change is
// what an attacker with one would reach for first.
func ChangePassword(
	ctx context.Context,
	store PasswordChanger,
	hasher PasswordHasher,
	session Session,
	current, next string,
	keepFingerprint []byte,
) error {
	if store == nil || hasher == nil {
		return ErrBadCredentials
	}
	user, found, err := store.UserByID(ctx, session.TenantID, session.UserID)
	if err != nil {
		return err
	}
	if !found {
		return ErrBadCredentials
	}
	if !hasher.Compare(user.PasswordHash, current) {
		return ErrBadCredentials
	}
	if len(next) < MinPasswordLength {
		return ErrWeakPassword
	}
	// Refusing a no-op change: it reads as success while leaving the
	// credential the operator was trying to retire in place.
	if hasher.Compare(user.PasswordHash, next) {
		return ErrWeakPassword
	}
	hash, err := hasher.Hash(next)
	if err != nil {
		return err
	}
	return store.SetPassword(ctx, session.TenantID, session.UserID, hash, keepFingerprint)
}
