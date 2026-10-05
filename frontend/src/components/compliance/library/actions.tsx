import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../../lib/api";
import { useCompliance } from "../../../lib/ComplianceContext";
import type { ComplianceDef } from "../../../lib/compliance";
import { toastError } from "../common";
import { useConfirm } from "./confirm";

export type LifecycleAction = "pause" | "resume" | "close" | "archive";

/** Which lifecycle buttons make sense for this compliance right now (the server still has the final say). */
export function availableActions(def: ComplianceDef, can: (r: string, a: string) => boolean) {
  const canEdit = Boolean(def.can?.edit) || (def.status === "closed" && can("compliance", "edit"));
  return {
    edit: Boolean(def.can?.edit),
    pause: canEdit && def.status === "published",
    resume: canEdit && def.status === "paused",
    close: canEdit && (def.status === "published" || def.status === "paused"),
    archive: canEdit && (def.status === "closed" || def.status === "draft"),
    publish: Boolean(def.can?.assign) && def.status === "draft",
    resync: Boolean(def.can?.assign) && def.status === "published",
    clone: can("compliance", "create"),
    remove: Boolean(def.can?.delete) && def.status === "draft",
  };
}

const DONE: Record<LifecycleAction, string> = {
  pause: "Paused",
  resume: "Resumed",
  close: "Closed",
  archive: "Archived",
};

/**
 * Lifecycle actions on one compliance, with confirmation for the ones that can't be undone, a busy
 * flag, toasts and a callback to refetch.
 */
export function useDefinitionActions(onChanged: () => void) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { reload } = useCompliance();
  const [busy, setBusy] = useState<string | null>(null);

  async function run<T>(key: string, fn: () => Promise<T>, failTitle: string): Promise<T | undefined> {
    setBusy(key);
    try {
      return await fn();
    } catch (e) {
      toastError(failTitle, e);
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(def: ComplianceDef, action: LifecycleAction) {
    const r = await run(action, () => api.post<ComplianceDef>(`/compliance/definitions/${def.id}/${action}`), `Couldn't ${action} “${def.name}”`);
    if (r) {
      toast.success(`${DONE[action]} “${def.name}”`);
      onChanged();
    }
  }

  const status = (def: ComplianceDef, action: LifecycleAction) => {
    if (action === "close") {
      confirm({
        title: `Close “${def.name}”?`,
        description: "Closing stops reminders and cancels everything people haven't finished. It can't be reopened, but its history stays.",
        confirm: "Close compliance",
        tone: "danger",
        onConfirm: async () => {
          await api.post(`/compliance/definitions/${def.id}/close`);
          toast.success(`Closed “${def.name}”`);
          onChanged();
        },
      });
    } else if (action === "archive") {
      confirm({
        title: `Archive “${def.name}”?`,
        description: "Archived compliance is hidden from day-to-day lists but kept for the record. It can't be edited or restored.",
        confirm: "Archive",
        tone: "danger",
        onConfirm: async () => {
          await api.post(`/compliance/definitions/${def.id}/archive`);
          toast.success(`Archived “${def.name}”`);
          onChanged();
        },
      });
    } else {
      void setStatus(def, action);
    }
  };

  /** Duplicates it as a new draft and opens that draft for editing. */
  const clone = async (def: ComplianceDef) => {
    const copy = await run("clone", () => api.post<ComplianceDef>(`/compliance/definitions/${def.id}/clone`), `Couldn't copy “${def.name}”`);
    if (copy) {
      toast.success("Copied as a draft", { description: copy.name });
      navigate(`/compliance/library/${copy.id}/edit`);
    }
  };

  const remove = (def: ComplianceDef, after?: () => void) =>
    confirm({
      title: `Delete the draft “${def.name}”?`,
      description: "This permanently removes the draft. Nobody has been assigned to it yet.",
      confirm: "Delete draft",
      tone: "danger",
      onConfirm: async () => {
        await api.delete(`/compliance/definitions/${def.id}`);
        toast.success(`Deleted “${def.name}”`);
        void reload();
        if (after) after();
        else onChanged();
      },
    });

  /** Publishes a draft and says how many people it reached. Resolves true on success. */
  const publish = async (def: ComplianceDef): Promise<boolean> => {
    const r = await run(
      "publish",
      () => api.post<{ result: { added: number; total?: number }; compliance: ComplianceDef }>(`/compliance/definitions/${def.id}/publish`),
      `Couldn't publish “${def.name}”`
    );
    if (!r) return false;
    const n = r.result.total ?? r.result.added;
    toast.success(`Published to ${n} ${n === 1 ? "person" : "people"}`, { description: def.name });
    onChanged();
    return true;
  };

  const resync = async (def: ComplianceDef) => {
    const r = await run(
      "resync",
      () => api.post<{ added: number; cancelled: number; updated: number; total: number }>(`/compliance/definitions/${def.id}/resync`),
      "Couldn't refresh the audience"
    );
    if (r) {
      toast.success("Audience refreshed", {
        description:
          r.added || r.cancelled ? `${r.added} added, ${r.cancelled} removed. ${r.total} in the audience now.` : `No changes. ${r.total} in the audience.`,
      });
      onChanged();
    }
  };

  return { busy, status, clone, remove, publish, resync };
}
