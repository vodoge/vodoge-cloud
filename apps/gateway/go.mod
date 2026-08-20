module github.com/vodoge/vodoge-cloud/apps/gateway

go 1.23.0

require (
	github.com/gorilla/websocket v1.5.3
	github.com/vodoge/vodoge-cloud/packages/contract v0.0.0
)

replace github.com/vodoge/vodoge-cloud/packages/contract => ../../packages/contract/go
