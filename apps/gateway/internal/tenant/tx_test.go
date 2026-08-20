package tenant

import (
	"context"
	"strings"
	"testing"
)

func TestBindSQLIsTransactionLocal(t *testing.T) {
	t.Parallel()

	if BindSQL != "SELECT set_config('app.tenant_id', $1, true)" {
		t.Fatalf("BindSQL = %q; is_local must be true so a pooled connection cannot leak tenant_id", BindSQL)
	}
	if strings.Contains(BindSQL, ", false)") {
		t.Fatal("session-level SET would survive COMMIT and leak across pool reuse")
	}
}

func TestTransactRejectsEmptyTenant(t *testing.T) {
	t.Parallel()

	err := Transact(context.Background(), nil, "", nil)
	if err != ErrMissingTenant {
		t.Fatalf("empty tenant err = %v, want ErrMissingTenant", err)
	}
	err = Transact(context.Background(), nil, "   ", nil)
	if err != ErrMissingTenant {
		t.Fatalf("blank tenant err = %v, want ErrMissingTenant", err)
	}
}
