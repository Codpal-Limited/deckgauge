// Moved to packages/notifications so apps/worker can share the ONE dispatcher
// and its access check instead of keeping a second copy that can drift.
// Re-exported from here to keep every existing importer working.
export { resolveDelivery, type Delivery, type ResolveDeliveryInput } from '@deckgauge/notifications';
