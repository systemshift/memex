/**
 * dagit post schema, canonical JSON, sign/verify posts.
 */

import * as identity from "./identity";
import * as ipfs from "./ipfs";

const MESSAGE_VERSION = 2;

export interface Post {
  v: number;
  type: string;
  content: string;
  author: string;
  refs: string[];
  tags: string[];
  timestamp: string;
  signature?: string;
}

export async function createPost(
  content: string,
  refs?: string[],
  tags?: string[],
  postType = "post",
): Promise<Post> {
  const ident = await identity.loadIdentity();
  if (!ident) throw new Error("No identity found. Run memex first to create one.");

  return {
    v: MESSAGE_VERSION,
    type: postType,
    content,
    author: ident.did,
    refs: refs ?? [],
    tags: tags ?? [],
    timestamp: new Date().toISOString(),
  };
}

function signingPayload(post: Post): Uint8Array {
  // Exclude signature, sort keys, compact JSON
  const obj: Record<string, any> = {};
  for (const key of Object.keys(post).sort()) {
    if (key !== "signature") {
      obj[key] = (post as any)[key];
    }
  }
  return new TextEncoder().encode(JSON.stringify(obj));
}

export async function signPost(post: Post): Promise<Post> {
  const payload = signingPayload(post);
  const signature = await identity.sign(payload);
  return { ...post, signature: Buffer.from(signature).toString("base64") };
}

export async function verifyPost(post: Post): Promise<boolean> {
  if (!post.signature) return false;
  try {
    const signature = Buffer.from(post.signature, "base64");
    const payload = signingPayload(post);
    return await identity.verify(payload, new Uint8Array(signature), post.author);
  } catch {
    return false;
  }
}

export function serialize(post: Post): string {
  return JSON.stringify(post);
}

export function deserialize(data: string | Uint8Array): Post {
  const str = typeof data === "string" ? data : new TextDecoder().decode(data);
  return JSON.parse(str);
}

export async function publish(
  content: string,
  refs?: string[],
  tags?: string[],
): Promise<string> {
  const post = await createPost(content, refs, tags);
  const signed = await signPost(post);
  const cid = await ipfs.add(signed);
  await ipfs.pin(cid);
  return cid;
}

export async function fetchPost(cid: string): Promise<[Post, boolean]> {
  const data = await ipfs.get(cid);
  const post = deserialize(data);
  const verified = await verifyPost(post);
  return [post, verified];
}
