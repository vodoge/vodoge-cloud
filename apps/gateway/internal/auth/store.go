package auth

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// SQL reads users and sessions through the SECURITY DEFINER resolvers.
//
// These go through functions rather than the tables directly because both
// lookups happen before a tenant context exists: a session is what says which
// tenant the caller belongs to, and a sign-in has only a Host to go on. Direct
// reads of app.users and app.sessions stay inside row-level security.
type SQL struct {
	DB *sql.DB
}

// User returns the operator with email inside tenantID.
func (store SQL) User(ctx context.Context, tenantID, email string) (User, bool, error) {
	if store.DB == nil {
		return User{}, false, nil
	}
	row := store.DB.QueryRowContext(
		ctx,
		`SELECT id, tenant_id, email, password_hash, status FROM app.resolve_user($1, $2)`,
		tenantID, email,
	)
	var user User
	switch err := row.Scan(
		&user.ID, &user.TenantID, &user.Email, &user.PasswordHash, &user.Status,
	); {
	case errors.Is(err, sql.ErrNoRows):
		return User{}, false, nil
	case err != nil:
		return User{}, false, err
	}
	return user, true, nil
}

// Session returns the live session for a fingerprint. Expired rows are already
// filtered by the resolver.
func (store SQL) Session(ctx context.Context, fingerprint []byte) (Session, bool, error) {
	if store.DB == nil {
		return Session{}, false, nil
	}
	row := store.DB.QueryRowContext(
		ctx,
		`SELECT user_id, tenant_id, expires_at FROM app.resolve_session($1)`,
		fingerprint,
	)
	var session Session
	switch err := row.Scan(&session.UserID, &session.TenantID, &session.ExpiresAt); {
	case errors.Is(err, sql.ErrNoRows):
		return Session{}, false, nil
	case err != nil:
		return Session{}, false, err
	}
	return session, true, nil
}

func (store SQL) CreateSession(ctx context.Context, fingerprint []byte, session Session) error {
	if store.DB == nil {
		return errors.New("auth store has no database")
	}
	_, err := store.DB.ExecContext(
		ctx,
		`SELECT app.create_session($1, $2, $3, $4)`,
		fingerprint, session.UserID, session.TenantID, session.ExpiresAt,
	)
	return err
}

func (store SQL) DeleteSession(ctx context.Context, fingerprint []byte) error {
	if store.DB == nil {
		return nil
	}
	_, err := store.DB.ExecContext(ctx, `SELECT app.delete_session($1)`, fingerprint)
	return err
}

// PurgeExpired removes sessions that are already past their expiry.
//
// resolve_session ignores them, so this is housekeeping rather than a boundary;
// without it the table only ever grows.
func (store SQL) PurgeExpired(ctx context.Context) (int64, error) {
	if store.DB == nil {
		return 0, nil
	}
	var removed int64
	err := store.DB.QueryRowContext(ctx, `SELECT app.purge_expired_sessions()`).Scan(&removed)
	return removed, err
}

// Bcrypt is the password hasher used in production.
type Bcrypt struct {
	// Cost defaults to bcrypt.DefaultCost when zero.
	Cost int
}

// Compare reports whether password matches hash.
//
// A wrong password and a malformed hash are the same answer on purpose: the
// caller must not be able to tell a corrupt record from a bad guess.
func (hasher Bcrypt) Compare(hash, password string) bool {
	if hash == "" {
		// Still spend the work. An early return here makes the response time
		// say that no such user exists.
		_, _ = bcrypt.GenerateFromPassword([]byte(password), hasher.cost())
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// Hash produces a stored password hash.
func (hasher Bcrypt) Hash(password string) (string, error) {
	out, err := bcrypt.GenerateFromPassword([]byte(password), hasher.cost())
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func (hasher Bcrypt) cost() int {
	if hasher.Cost <= 0 {
		return bcrypt.DefaultCost
	}
	return hasher.Cost
}

// StartSessionPurge removes expired sessions periodically until ctx is done.
func StartSessionPurge(ctx context.Context, store SQL, every time.Duration, onError func(error)) {
	if store.DB == nil || every <= 0 {
		return
	}
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := store.PurgeExpired(ctx); err != nil && onError != nil {
					onError(err)
				}
			}
		}
	}()
}
