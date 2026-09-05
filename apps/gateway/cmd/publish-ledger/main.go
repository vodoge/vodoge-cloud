// Command publish-ledger renders the support ledger into a capability matrix
// and queues it for every device, without going through the HTTP handler.
//
// The handler is the normal way in and stays the normal way in: publishing is
// a deliberate act and the console asks a question that states the
// consequence before it happens. This exists because that route needs a
// console session, and a session comes from a password -- which is not
// something to type into a shell to get a deployment done.
//
// It is not a second implementation. `ledger.Document`, `matrix.Parse` and
// `matrix.CommandPayload` are the same functions the handler calls, in the
// same order, so the document and its digest are byte-for-byte what the
// console would have produced. A hand-rolled copy would work until the day
// the two disagreed, and then a device would reject the push for a digest
// mismatch that pointed at nothing.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/catalog"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ledger"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/matrix"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "publish-ledger: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	url := os.Getenv("VODOGE_DATABASE_URL")
	if url == "" {
		return fmt.Errorf("VODOGE_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping: %w", err)
	}

	// Taken as an argument, because nothing can look it up from here.
	// `app.tenants` carries FORCE row-level security and isolates on
	// `id = app.current_tenant_id()`, so the gateway's own login sees no rows
	// at all until a tenant context is already set -- which is the thing being
	// established. Reading it as a superuser instead would work and is exactly
	// the shortcut that makes a tool stop resembling the code path it stands
	// in for.
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: publish-ledger <tenant-id>")
	}
	tenantID := os.Args[1]

	entries, err := ledger.SQL{DB: db}.List(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("ledger: %w", err)
	}
	if len(entries) == 0 {
		// Same refusal the handler makes: an empty ledger means nothing is
		// supported, which is a thing to say deliberately and not by running
		// a tool against a tenant that has not been measured yet.
		return fmt.Errorf("the ledger is empty; nothing would be supported")
	}

	version := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	// 和 HTTP 那条一样：读不出来就整次作废，不当成空的继续。
	// ⚠️ 变量名不能叫 devices —— 这个文件下面已经有一个，指的是机队里的
	// 边缘机（catalog.Device）。同一个词在这个代码库里指两样东西。
	supported, err := ledger.SQLDevices{DB: db}.ListSupportedDevices(ctx)
	if err != nil {
		return fmt.Errorf("supported devices: %w", err)
	}
	rendered, err := json.Marshal(ledger.Document(version, entries, supported))
	if err != nil {
		return fmt.Errorf("render: %w", err)
	}
	overlay, err := matrix.Parse(rendered)
	if err != nil {
		return fmt.Errorf("parse: %w", err)
	}
	if err := (matrix.SQL{DB: db}).Put(ctx, tenantID, overlay); err != nil {
		return fmt.Errorf("store: %w", err)
	}

	devices, err := (catalog.SQL{DB: db}).ListDevices(ctx, tenantID)
	if err != nil {
		return fmt.Errorf("devices: %w", err)
	}
	payload, err := matrix.CommandPayload(overlay)
	if err != nil {
		return fmt.Errorf("payload: %w", err)
	}

	queue := commands.SQL{DB: db}
	sent := 0
	for _, device := range devices {
		if _, err := queue.Enqueue(ctx, commands.Item{
			TenantID: tenantID,
			DeviceID: device.ID,
			Kind:     commands.MatrixKind,
			// Derived from the device, the version and the payload, so
			// publishing an unchanged ledger collapses onto the same row
			// instead of queueing a second delivery of the same document.
			IdempotencyKey: commands.MatrixKey(device.ID, overlay.Version, payload),
			Payload:        payload,
			ExpiresAt:      time.Now().Add(commands.MatrixTTL),
		}); err != nil {
			fmt.Fprintf(os.Stderr, "queue %s: %v\n", device.ID, err)
			continue
		}
		sent++
	}

	fmt.Printf("version=%s sha256=%s rules=%d devices=%d\n",
		overlay.Version, overlay.SHA256, len(entries), sent)
	for _, entry := range entries {
		fmt.Printf("  %s on %s\n", entry.ModemFamily, entry.Carrier)
	}
	return nil
}
