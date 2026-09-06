package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	if err := runCommand(ctx, os.Stdin, os.Stdout, newModalAPI, time.Now); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
