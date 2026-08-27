// Moved to packages/shared so the worker can reach the SAME descriptor map — the
// notification dispatcher's reverse access check reads it, and apps/worker has no
// dependency on apps/api. Re-exported from here so every existing importer, and
// the comment trail that points at this path, keep working.
export {
  ACCESS_ENTITIES,
  type AccessEntityDescriptor,
} from '@deckgauge/shared';
