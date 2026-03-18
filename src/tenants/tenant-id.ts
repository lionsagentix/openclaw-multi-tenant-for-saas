/**
 * Tenant slug validation and normalization.
 *
 * Reuses the same pattern as `src/routing/account-id.ts` for consistency:
 * - Alphanumeric + dashes/underscores
 * - Max 64 characters
 * - Lowercased
 * - Blocked prototype keys rejected
 */

import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Matches a valid tenant slug: starts with alphanumeric, up to 64 chars total. */
const VALID_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Characters not allowed in slugs. */
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;

/** Leading/trailing dashes after sanitization. */
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

/** Minimum slug length after normalization. */
const MIN_SLUG_LENGTH = 3;

/** Maximum slug length. */
const MAX_SLUG_LENGTH = 64;

/** Reserved slugs that cannot be used by tenants. */
const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "www",
  "app",
  "mail",
  "smtp",
  "ftp",
  "ssh",
  "ns1",
  "ns2",
  "cdn",
  "static",
  "assets",
  "status",
  "health",
  "healthz",
  "readyz",
  "metrics",
  "internal",
  "system",
  "platform",
  "control-plane",
  "webhook",
  "webhooks",
  "billing",
  "default",
  "main",
  "root",
  "null",
  "undefined",
]);

export type TenantSlugValidation = { valid: true; slug: string } | { valid: false; error: string };

/**
 * Normalize a raw slug input into a canonical form.
 * Returns undefined if the input cannot be normalized into a valid slug.
 */
function canonicalizeSlug(value: string): string | undefined {
  let slug: string;

  if (VALID_SLUG_RE.test(value)) {
    slug = value.toLowerCase();
  } else {
    slug = value
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, MAX_SLUG_LENGTH);
  }

  if (!slug || slug.length < MIN_SLUG_LENGTH) {
    return undefined;
  }

  if (isBlockedObjectKey(slug)) {
    return undefined;
  }

  return slug;
}

/**
 * Validate and normalize a tenant slug.
 *
 * Rules:
 * - Must be 3-64 characters
 * - Only lowercase alphanumeric, dashes, and underscores
 * - Must start with an alphanumeric character
 * - Must not be a reserved slug
 * - Must not be a prototype pollution key
 */
export function validateTenantSlug(rawSlug: string): TenantSlugValidation {
  const trimmed = rawSlug.trim();

  if (!trimmed) {
    return { valid: false, error: "Slug is required." };
  }

  const slug = canonicalizeSlug(trimmed);

  if (!slug) {
    return {
      valid: false,
      error: `Invalid slug "${trimmed}". Must be ${MIN_SLUG_LENGTH}-${MAX_SLUG_LENGTH} alphanumeric characters, dashes, or underscores.`,
    };
  }

  if (RESERVED_SLUGS.has(slug)) {
    return {
      valid: false,
      error: `Slug "${slug}" is reserved and cannot be used.`,
    };
  }

  return { valid: true, slug };
}

/**
 * Check if a string is a valid tenant slug without normalizing.
 */
export function isValidTenantSlug(slug: string): boolean {
  return validateTenantSlug(slug).valid;
}
