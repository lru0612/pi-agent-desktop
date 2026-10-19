"use client";

// Fork-owned: state and actions behind the worktree pages of the project "…"
// menu (components/ProjectContextMenu.tsx) — fetch remote branches, create and
// remove worktrees. SessionSidebar (upstream-owned) supplies what happens to
// the sidebar afterwards through the callbacks.

import { useCallback, useRef, useState } from "react";
import {
  createProjectWorktree,
  fetchRemoteBranches,
  removeProjectWorktree,
  type WorktreeRemoval,
} from "@/components/ProjectContextMenu";

interface ProjectWorktreeCallbacks {
  /** A fetch landed; merge the fresh branch lists into the menu. */
  onBranchesFetched: (projectRoot: string, lists: { branches: string[]; remoteBranches: string[] }) => void;
  /** A worktree was created at `path`; select it and refresh. */
  onWorktreeCreated: (projectRoot: string, path: string, branch: string) => void;
  /** A worktree checkout was removed; leave it if it was selected and refresh. */
  onWorktreeRemoved: (projectRoot: string, path: string) => void;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useProjectWorktreeActions({ onBranchesFetched, onWorktreeCreated, onWorktreeRemoved }: ProjectWorktreeCallbacks, request: typeof fetch = fetch) {
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<WorktreeRemoval | null>(null);
  const [newBranch, setNewBranchValue] = useState("");
  const generation = useRef(0);

  /** Clears everything a closed or re-opened menu must not carry over. */
  const reset = useCallback(() => {
    generation.current++;
    setBusy(false);
    setFetching(false);
    setError(null);
    setConfirmRemove(null);
    setNewBranchValue("");
  }, []);

  const setNewBranch = useCallback((value: string) => {
    setNewBranchValue(value);
    setError(null);
  }, []);

  const requestRemove = useCallback((path: string) => {
    setError(null);
    setConfirmRemove({ path, force: false });
  }, []);

  const cancelRemove = useCallback(() => setConfirmRemove(null), []);

  const fetchBranches = useCallback(async (projectRoot: string) => {
    if (fetching) return;
    const operation = generation.current;
    setFetching(true);
    setError(null);
    try {
      const lists = await fetchRemoteBranches(projectRoot, request);
      if (operation === generation.current) onBranchesFetched(projectRoot, lists);
    } catch (e) {
      if (operation === generation.current) setError(message(e));
    } finally {
      if (operation === generation.current) setFetching(false);
    }
  }, [fetching, onBranchesFetched, request]);

  const create = useCallback(async (projectRoot: string) => {
    const branch = newBranch.trim();
    if (!branch || busy) return;
    const operation = generation.current;
    setBusy(true);
    setError(null);
    try {
      const created = await createProjectWorktree(projectRoot, branch, request);
      if (operation !== generation.current) return;
      setNewBranchValue("");
      onWorktreeCreated(projectRoot, created.path, created.branch);
    } catch (e) {
      if (operation === generation.current) setError(message(e));
    } finally {
      if (operation === generation.current) setBusy(false);
    }
  }, [busy, newBranch, onWorktreeCreated, request]);

  const remove = useCallback(async (projectRoot: string, removal: WorktreeRemoval) => {
    if (busy) return;
    const operation = generation.current;
    setBusy(true);
    setError(null);
    try {
      const result = await removeProjectWorktree(projectRoot, removal.path, removal.force, request);
      if (operation !== generation.current) return;
      if (result === "needs-force") {
        // Dirty or has submodules: ask again, this time for a forced removal.
        setConfirmRemove({ path: removal.path, force: true });
        return;
      }
      setConfirmRemove(null);
      onWorktreeRemoved(projectRoot, removal.path);
    } catch (e) {
      if (operation === generation.current) setError(message(e));
    } finally {
      if (operation === generation.current) setBusy(false);
    }
  }, [busy, onWorktreeRemoved, request]);

  return {
    busy,
    fetching,
    error,
    setError,
    confirmRemove,
    newBranch,
    setNewBranch,
    reset,
    requestRemove,
    cancelRemove,
    fetchBranches,
    create,
    remove,
  };
}
