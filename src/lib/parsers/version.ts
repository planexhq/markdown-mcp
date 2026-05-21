/**
 * Parser-output-shape version. Persisted to
 * `index_meta.parser_shape_version` at every {@link IndexHandle.markScanFinalized}
 * and compared against this in-code value at startup via
 * `computePolicyMismatch`; mismatch forces a cold rescan.
 *
 * Bump this integer when ANY parser starts emitting structurally
 * different fragments for the same source bytes — new heading
 * taxonomies, new structural slots, changed fence layouts, removed
 * sections. Bug fixes that don't change output for legal input do
 * NOT need a bump.
 *
 * Why this matters: warm reconcile's `(mtime, size)` skip (see
 * `IndexHandle.isFileUnchanged`) would otherwise leave previously-
 * indexed files frozen at their pre-upgrade fragment shape until each
 * file is touched on disk. The OpenAPI and AsyncAPI synthesizers both
 * changed YAML fragment shape with no corresponding invalidation
 * mechanism — caches without this stamp stayed opaque.
 */
export const PARSER_SHAPE_VERSION = 1;
