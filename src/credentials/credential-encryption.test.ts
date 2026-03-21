import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeKeyPrefix,
  decryptCredential,
  encryptCredential,
  getEncryptionKey,
} from "./credential-encryption.js";

const VALID_HEX_KEY = crypto.randomBytes(32).toString("hex");

describe("credential-encryption", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_CREDENTIAL_ENCRYPTION_KEY", VALID_HEX_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("getEncryptionKey", () => {
    it("reads and validates the key from environment", () => {
      const key = getEncryptionKey();
      expect(key).toBeInstanceOf(Buffer);
      expect(key.length).toBe(32);
    });

    it("throws if env var is missing", () => {
      vi.stubEnv("OPENCLAW_CREDENTIAL_ENCRYPTION_KEY", "");
      expect(() => getEncryptionKey()).toThrow("Missing OPENCLAW_CREDENTIAL_ENCRYPTION_KEY");
    });

    it("throws if env var is not 64 hex characters", () => {
      vi.stubEnv("OPENCLAW_CREDENTIAL_ENCRYPTION_KEY", "tooshort");
      expect(() => getEncryptionKey()).toThrow("must be a 64-character hex string");
    });

    it("throws if env var contains non-hex characters", () => {
      vi.stubEnv("OPENCLAW_CREDENTIAL_ENCRYPTION_KEY", "z".repeat(64));
      expect(() => getEncryptionKey()).toThrow("must be a 64-character hex string");
    });
  });

  describe("encryptCredential / decryptCredential", () => {
    const key = Buffer.from(VALID_HEX_KEY, "hex");

    it("round-trips: encrypt then decrypt returns original", () => {
      const plaintext = "sk-proj-abc123def456";
      const { ciphertext, iv, authTag } = encryptCredential(plaintext, key);
      const result = decryptCredential(ciphertext, iv, authTag, key);
      expect(result).toBe(plaintext);
    });

    it("produces different ciphertexts for same plaintext (unique IVs)", () => {
      const plaintext = "sk-test-same-key";
      const enc1 = encryptCredential(plaintext, key);
      const enc2 = encryptCredential(plaintext, key);
      expect(enc1.iv).not.toEqual(enc2.iv);
      expect(enc1.ciphertext).not.toEqual(enc2.ciphertext);
    });

    it("throws on tampered ciphertext", () => {
      const { ciphertext, iv, authTag } = encryptCredential("secret-key", key);
      // Flip a byte in the ciphertext.
      const tampered = Buffer.from(ciphertext);
      tampered[0] ^= 0xff;
      expect(() => decryptCredential(tampered, iv, authTag, key)).toThrow();
    });

    it("throws on wrong key", () => {
      const { ciphertext, iv, authTag } = encryptCredential("secret-key", key);
      const wrongKey = crypto.randomBytes(32);
      expect(() => decryptCredential(ciphertext, iv, authTag, wrongKey)).toThrow();
    });

    it("handles empty string", () => {
      const { ciphertext, iv, authTag } = encryptCredential("", key);
      expect(decryptCredential(ciphertext, iv, authTag, key)).toBe("");
    });

    it("handles long keys", () => {
      const longKey = "sk-" + "a".repeat(500);
      const { ciphertext, iv, authTag } = encryptCredential(longKey, key);
      expect(decryptCredential(ciphertext, iv, authTag, key)).toBe(longKey);
    });
  });

  describe("computeKeyPrefix", () => {
    it("returns first 8 characters", () => {
      expect(computeKeyPrefix("sk-proj-abc123def456")).toBe("sk-proj-");
    });

    it("returns full string if shorter than 8 chars", () => {
      expect(computeKeyPrefix("short")).toBe("short");
    });
  });
});
