import { AzureDevOpsWorkItem } from './azure-devops-schemas.js';
import { AdoWorkItemRevision } from './ado-work-item-revision.js';

export interface AzureDevOpsPort {
  fetchWorkItems(project: string): Promise<AzureDevOpsWorkItem[]>;

  /**
   * Stream every work item in the project as batches, so a caller can process
   * and release each batch without buffering the whole (potentially 20k+) set
   * in memory. `fetchWorkItems` is the buffered convenience over this.
   */
  streamWorkItems(project: string): AsyncIterable<AzureDevOpsWorkItem[]>;

  /**
   * Stream every work-item *revision* in the project as batches, oldest first,
   * optionally only those changed at/after `since`. Used to reconstruct status
   * transitions for the timesheet. Uses ADO's Reporting Work Item Revisions
   * endpoint, which streams all revisions for the whole project in one cursor
   * pass (no per-item calls).
   */
  streamWorkItemRevisions(
    project: string,
    since?: Date,
  ): AsyncIterable<AdoWorkItemRevision[]>;

  /**
   * Lightweight WIQL query returning only matching work-item IDs for the given
   * project, optionally narrowed by an array of allowed types and/or a raw
   * WIQL WHERE-clause fragment. Passing `[]` for `allowedTypes` skips the
   * `[System.WorkItemType] IN (...)` clause. Passing `null` for `wiqlFilter`
   * skips the extra AND.
   */
  queryMatchingIds(
    project: string,
    allowedTypes: string[],
    wiqlFilter: string | null,
  ): Promise<Set<number>>;

  fetchWorkItemTypes(project: string): Promise<string[]>;
}
