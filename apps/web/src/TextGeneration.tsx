import { createContext, useContext, type ReactNode } from "react";
import type { Job } from "./api";

export const AI_TEXT = "AI生成中...";
export const TEXT_JOB_EVENT = "shortfilm:text-job-accepted";
const pending = new Set([
  "queued",
  "running",
  "waiting_provider",
  "waiting_dependency",
]);
const Context = createContext<{ pid: string; jobs: Job[] }>({
  pid: "",
  jobs: [],
});
export type GenerationTarget = {
  kind: string | string[];
  itemId?: string;
  versionId?: string;
  sourceVersionId?: string;
  targetRevision?: number;
};
export function findTextJob(
  jobs: Job[],
  pid: string,
  target: GenerationTarget,
) {
  const kinds = Array.isArray(target.kind) ? target.kind : [target.kind];
  return jobs.find((job) => {
    if (
      job.project_id !== pid ||
      !pending.has(job.state) ||
      !kinds.includes(job.kind)
    )
      return false;
    const s = job.snapshot;
    if (target.itemId !== undefined && s.item_id !== target.itemId)
      return false;
    if (
      target.versionId !== undefined &&
      s.base_version_id !== target.versionId
    )
      return false;
    if (
      target.sourceVersionId !== undefined &&
      (s.idea_version_id ?? s.source_version_id) !== target.sourceVersionId
    )
      return false;
    if (
      target.targetRevision !== undefined &&
      s.target_revision !== target.targetRevision
    )
      return false;
    return true;
  });
}
export function TextGenerationProvider({
  pid,
  jobs,
  children,
}: {
  pid: string;
  jobs: Job[];
  children: ReactNode;
}) {
  return <Context.Provider value={{ pid, jobs }}>{children}</Context.Provider>;
}
export function useTextGeneration(target: GenerationTarget) {
  const { pid, jobs } = useContext(Context);
  return findTextJob(jobs, pid, target);
}
export function notifyTextJob(job: Job) {
  window.dispatchEvent(new CustomEvent(TEXT_JOB_EVENT, { detail: job }));
}
export function GenerationOutput({ label, job }: { label: string; job?: Job }) {
  if (!job) return null;
  return (
    <label className="field ai-generation-output">
      {label}
      <textarea
        aria-label={label}
        aria-busy="true"
        readOnly
        value={AI_TEXT}
        rows={3}
      />
    </label>
  );
}
