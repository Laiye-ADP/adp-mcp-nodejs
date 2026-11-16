import { createDecipheriv } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type CliCredentials = { apiKey: string; baseUrl: string; tenant: string };

const maxConfigBytes = 64 * 1024;
const keyBytes = 32;
const nonceBytes = 12;
const tagBytes = 16;
const decoder = new TextDecoder("utf-8", { fatal: true });

export function readCliCredentials(env: NodeJS.ProcessEnv): CliCredentials | undefined {
  const profileDir = env.USERPROFILE || env.HOME || homedir();
  if (!isAbsolute(profileDir)) throw unreadableCredentials();
  const configDir = join(profileDir, ".adp");

  let configBytes: Buffer;
  try {
    configBytes = readProfileFile(join(configDir, "config.json"), maxConfigBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unreadableCredentials();
  }

  try {
    const config: unknown = JSON.parse(decoder.decode(configBytes));
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw unreadableCredentials();
    const { api_key: encrypted, api_base_url: baseUrl, tenant_name: tenant } = config as Record<string, unknown>;
    if (encrypted === undefined || encrypted === "") return undefined;
    if (typeof encrypted !== "string" || encrypted.length <= 2 * (nonceBytes + tagBytes)
        || encrypted.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(encrypted)
        || typeof baseUrl !== "string" || !baseUrl.trim()
        || (tenant !== undefined && typeof tenant !== "string")) {
      throw unreadableCredentials();
    }

    const key = readProfileFile(join(configDir, "key.enc"), keyBytes);
    try {
      if (key.length !== keyBytes) throw unreadableCredentials();
      const apiKey = decryptKey(encrypted, key).trim();
      if (!apiKey) throw unreadableCredentials();
      return { apiKey, baseUrl: baseUrl.trim(), tenant: tenant || "laiye" };
    } finally {
      key.fill(0);
    }
  } catch {
    throw unreadableCredentials();
  } finally {
    configBytes.fill(0);
  }
}

function decryptKey(encrypted: string, key: Buffer): string {
  // Go CLI seals the API key as nonce || ciphertext || GCM tag, then hex encodes it.
  const sealed = Buffer.from(encrypted, "hex");
  const tagOffset = sealed.length - tagBytes;
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, nonceBytes), { authTagLength: tagBytes });
  decipher.setAuthTag(sealed.subarray(tagOffset));

  // Keep the unauthenticated plaintext out of strings until final() verifies the tag.
  const plaintext = decipher.update(sealed.subarray(nonceBytes, tagOffset));
  try {
    const tail = decipher.final();
    const bytes = Buffer.concat([plaintext, tail]);
    try {
      return decoder.decode(bytes);
    } finally {
      bytes.fill(0);
      tail.fill(0);
    }
  } finally {
    plaintext.fill(0);
    sealed.fill(0);
  }
}

function readProfileFile(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  const buffer = Buffer.alloc(maxBytes + 1);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) throw unreadableCredentials();
    let length = 0;
    while (length <= maxBytes) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) return buffer.subarray(0, length);
      length += count;
    }
    throw unreadableCredentials();
  } catch (error) {
    buffer.fill(0);
    throw error;
  } finally {
    closeSync(fd);
  }
}

function unreadableCredentials(): Error {
  return new Error("Unable to read the ADP CLI credential configuration.");
}
