// Command vodoge-admin creates and updates console operators.
//
// The password is read from standard input, never from a flag: an argument
// would land in shell history and in the process list where anyone on the host
// can read it. Nothing here prints the password back.
package main

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/auth"
)

func main() {
	slug := flag.String("tenant", "", "tenant slug, e.g. a")
	email := flag.String("email", "", "operator email")
	disable := flag.Bool("disable", false, "disable the account instead of setting a password")
	flag.Parse()

	if err := run(*slug, *email, *disable); err != nil {
		fmt.Fprintln(os.Stderr, "vodoge-admin:", err)
		os.Exit(1)
	}
}

func run(slug, email string, disable bool) error {
	slug = strings.ToLower(strings.TrimSpace(slug))
	email = strings.ToLower(strings.TrimSpace(email))
	if slug == "" || email == "" {
		return errors.New("both -tenant and -email are required")
	}

	url := strings.TrimSpace(os.Getenv("VODOGE_DATABASE_URL"))
	if url == "" {
		return errors.New("VODOGE_DATABASE_URL is not set")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tenantID, err := tenantIDForSlug(ctx, db, slug)
	if err != nil {
		return err
	}

	if disable {
		return setStatus(ctx, db, tenantID, email, "disabled")
	}

	password, err := readPassword()
	if err != nil {
		return err
	}
	if len(password) < 12 {
		// Short enough to guess offline once a hash leaks.
		return errors.New("password must be at least 12 characters")
	}

	hash, err := auth.Bcrypt{}.Hash(password)
	if err != nil {
		return err
	}
	if err := upsertUser(ctx, db, tenantID, email, hash); err != nil {
		return err
	}
	fmt.Printf("%s is ready for tenant %s\n", email, slug)
	return nil
}

// readPassword takes the password from stdin so it never appears in the
// process list. It is not echoed back anywhere.
func readPassword() (string, error) {
	info, err := os.Stdin.Stat()
	if err == nil && info.Mode()&os.ModeCharDevice != 0 {
		fmt.Fprint(os.Stderr, "password (input is not echoed by your terminal if piped): ")
	}
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no password on standard input")
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// tenantIDForSlug uses the same resolver the gateway does, so a slug that the
// gateway cannot route is also one this tool refuses.
func tenantIDForSlug(ctx context.Context, db *sql.DB, slug string) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT id FROM app.resolve_tenant($1)`, slug).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("no tenant with slug %q", slug)
	}
	return id, err
}

// upsertUser writes inside the tenant's own row-level security context, so a
// mistake here cannot reach across tenants either.
func upsertUser(ctx context.Context, db *sql.DB, tenantID, email, hash string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	_, err = tx.ExecContext(
		ctx,
		// gen_random_uuid keeps this from needing a UUID dependency for one row.
		`INSERT INTO app.users (id, tenant_id, email, password_hash, status)
		 VALUES (gen_random_uuid(), $1, $2, $3, 'active')
		 ON CONFLICT (tenant_id, email)
		 DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active'`,
		tenantID, email, hash,
	)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func setStatus(ctx context.Context, db *sql.DB, tenantID, email, status string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	result, err := tx.ExecContext(
		ctx,
		`UPDATE app.users SET status = $3 WHERE tenant_id = $1 AND email = $2`,
		tenantID, email, status,
	)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("no account %q in this tenant", email)
	}
	// Disabling has to end this account's live sessions in the same
	// transaction. Without it the account keeps working until its existing
	// session expires, which is the opposite of what disabling means.
	if _, err := tx.ExecContext(
		ctx,
		`DELETE FROM app.sessions
		  WHERE tenant_id = $1
		    AND user_id IN (SELECT id FROM app.users WHERE tenant_id = $1 AND email = $2)`,
		tenantID, email,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Printf("%s is now %s, and its sessions were ended\n", email, status)
	return nil
}
