/**
 * Side-effect import (fork-owned): installs the remote request router before
 * any component issues its first /api request. AppShell imports this first.
 */
import { installRemoteRouter } from "./client";

installRemoteRouter();
