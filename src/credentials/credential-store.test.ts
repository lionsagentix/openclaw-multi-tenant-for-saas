import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the database module.
const mockQuery = vi.fn();

vi.mock("../control-plane/db.js", () => ({
  getDb: () => ({
    query: mockQuery,
  }),
}));

// Mock audit logging.
vi.mock("../tenants/tenant-store.js", () => ({
  writeAuditLog: vi.fn(),
}));

// Mock encryption module.
const MOCK_KEY = Buffer.alloc(32, 1);
const MOCK_CIPHERTEXT = Buffer.from("encrypted");
const MOCK_IV = Buffer.alloc(12, 2);
const MOCK_AUTH_TAG = Buffer.alloc(16, 3);

vi.mock("./credential-encryption.js", () => ({
  getEncryptionKey: () => MOCK_KEY,
  encryptCredential: () => ({
    ciphertext: MOCK_CIPHERTEXT,
    iv: MOCK_IV,
    authTag: MOCK_AUTH_TAG,
  }),
  decryptCredential: () => "sk-decrypted-plaintext",
  computeKeyPrefix: (key: string) => key.slice(0, 8),
}));

const {
  createTenantCredential,
  getTenantCredentials,
  getTenantCredential,
  decryptTenantCredential,
  decryptAllTenantCredentials,
  deleteTenantCredential,
  rotateTenantCredential,
} = await import("./credential-store.js");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CREDENTIAL_ID = "cred-0001-0001-0001-000000000001";
const NOW = new Date("2026-03-20T12:00:00Z");

function makeCredentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    tenant_id: TENANT_ID,
    provider: "openai",
    label: "Production Key",
    key_prefix: "sk-proj-",
    encrypted_key: MOCK_CIPHERTEXT,
    encryption_iv: MOCK_IV,
    auth_tag: MOCK_AUTH_TAG,
    created_at: NOW,
    rotated_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe("credential-store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createTenantCredential", () => {
    it("inserts encrypted credential and returns metadata without plaintext", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeCredentialRow()] });

      const result = await createTenantCredential({
        tenantId: TENANT_ID,
        provider: "openai",
        apiKey: "sk-proj-abc123",
        label: "Production Key",
      });

      expect(result.id).toBe(CREDENTIAL_ID);
      expect(result.tenantId).toBe(TENANT_ID);
      expect(result.provider).toBe("openai");
      expect(result.keyPrefix).toBe("sk-proj-");
      expect(result).not.toHaveProperty("plaintext");
      expect((result as Record<string, unknown>).apiKey).toBeUndefined();

      // Verify INSERT was called with encrypted data.
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO tenant_credentials"),
        expect.arrayContaining([TENANT_ID, "openai", "Production Key", MOCK_CIPHERTEXT]),
      );
    });
  });

  describe("getTenantCredentials", () => {
    it("returns all active credentials for a tenant", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeCredentialRow(),
          makeCredentialRow({ id: "cred-0002", provider: "anthropic", label: "Anthropic Key" }),
        ],
      });

      const results = await getTenantCredentials(TENANT_ID);
      expect(results).toHaveLength(2);
      expect(results[0].provider).toBe("openai");
      expect(results[1].provider).toBe("anthropic");
    });

    it("returns empty array when no credentials exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const results = await getTenantCredentials(TENANT_ID);
      expect(results).toEqual([]);
    });
  });

  describe("getTenantCredential", () => {
    it("returns credential by ID", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeCredentialRow()] });
      const result = await getTenantCredential(CREDENTIAL_ID);
      expect(result?.id).toBe(CREDENTIAL_ID);
    });

    it("returns null when not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getTenantCredential("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("decryptTenantCredential", () => {
    it("fetches and decrypts a credential", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeCredentialRow()] });
      const result = await decryptTenantCredential(CREDENTIAL_ID);
      expect(result).not.toBeNull();
      expect(result!.credential.id).toBe(CREDENTIAL_ID);
      expect(result!.plaintext).toBe("sk-decrypted-plaintext");
    });

    it("returns null for nonexistent credential", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await decryptTenantCredential("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("decryptAllTenantCredentials", () => {
    it("decrypts all active credentials for a tenant", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeCredentialRow(), makeCredentialRow({ id: "cred-0002", provider: "anthropic" })],
      });

      const results = await decryptAllTenantCredentials(TENANT_ID);
      expect(results).toHaveLength(2);
      expect(results[0].plaintext).toBe("sk-decrypted-plaintext");
      expect(results[1].plaintext).toBe("sk-decrypted-plaintext");
    });
  });

  describe("deleteTenantCredential", () => {
    it("soft-deletes credential by setting revoked_at", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeCredentialRow({ revoked_at: NOW })],
      });

      const result = await deleteTenantCredential(CREDENTIAL_ID);
      expect(result).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("SET revoked_at = NOW()"), [
        CREDENTIAL_ID,
      ]);
    });

    it("returns null when credential not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await deleteTenantCredential("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("rotateTenantCredential", () => {
    it("re-encrypts with new key and updates timestamp", async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [makeCredentialRow({ rotated_at: NOW })],
      });

      const result = await rotateTenantCredential({
        credentialId: CREDENTIAL_ID,
        newApiKey: "sk-new-key-456",
      });

      expect(result).not.toBeNull();
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SET encrypted_key"),
        expect.arrayContaining([CREDENTIAL_ID, MOCK_CIPHERTEXT, MOCK_IV, MOCK_AUTH_TAG]),
      );
    });

    it("returns null when credential not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await rotateTenantCredential({
        credentialId: "nonexistent",
        newApiKey: "sk-new",
      });
      expect(result).toBeNull();
    });
  });
});
