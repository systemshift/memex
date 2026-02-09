/**
 * Ed25519 keypair, DID encode/decode, sign/verify.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import bs58 from "bs58";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// noble/ed25519 v2 requires sha512 configuration
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const DAGIT_DIR = join(homedir(), ".dagit");
const IDENTITY_FILE = join(DAGIT_DIR, "identity.json");

// Multicodec prefix for Ed25519 public key (0xed01)
const ED25519_MULTICODEC = new Uint8Array([0xed, 0x01]);

export interface Identity {
  did: string;
  public_key: string; // base64
  private_key: string; // base64
}

export function encodeDid(publicKey: Uint8Array): string {
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed.set(ED25519_MULTICODEC);
  prefixed.set(publicKey, 2);
  return `did:key:z${bs58.encode(prefixed)}`;
}

export function decodeDid(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) {
    throw new Error(`Invalid did:key format: ${did}`);
  }
  const encoded = did.slice(9); // Remove "did:key:z"
  const prefixed = bs58.decode(encoded);

  if (prefixed[0] !== 0xed || prefixed[1] !== 0x01) {
    throw new Error("Invalid multicodec prefix for Ed25519 key");
  }

  return prefixed.slice(2);
}

export async function createIdentity(): Promise<Identity> {
  mkdirSync(DAGIT_DIR, { recursive: true });

  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  const identity: Identity = {
    did: encodeDid(publicKey),
    public_key: Buffer.from(publicKey).toString("base64"),
    private_key: Buffer.from(privateKey).toString("base64"),
  };

  await Bun.write(IDENTITY_FILE, JSON.stringify(identity, null, 2));
  return identity;
}

export async function loadIdentity(): Promise<Identity | null> {
  if (!existsSync(IDENTITY_FILE)) return null;
  const data = JSON.parse(await Bun.file(IDENTITY_FILE).text());
  return data as Identity;
}

export async function getPrivateKey(): Promise<Uint8Array> {
  const identity = await loadIdentity();
  if (!identity) throw new Error("No identity found. Run memex first to create one.");
  return Buffer.from(identity.private_key, "base64");
}

export async function sign(message: Uint8Array): Promise<Uint8Array> {
  const privateKey = await getPrivateKey();
  return await ed.signAsync(message, privateKey);
}

export async function verify(
  message: Uint8Array,
  signature: Uint8Array,
  did: string,
): Promise<boolean> {
  try {
    const publicKey = decodeDid(did);
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}
