// Prints every command kind the catalogue can build, one per line.
//
// Exists for the CI check that compares them against `app.command_kind`. A
// command whose enum value is missing is refused by PostgreSQL at INSERT --
// after the catalogue built a valid payload and the gateway validated it --
// and no Go test can see that, because the catalogue's tests build payloads
// and never store one. Migrations 0052 and 0054 are both that gap shipping.
package main

import (
	"fmt"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
)

func main() {
	for _, kind := range commands.Kinds() {
		fmt.Println(kind)
	}
}
