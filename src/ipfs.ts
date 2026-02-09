/**
 * IPFS HTTP API client (add, cat, pin).
 */

const IPFS_API = "http://localhost:5001/api/v0";

export async function add(content: string | Uint8Array | Record<string, any>): Promise<string> {
  let body: Uint8Array;
  if (typeof content === "object" && !(content instanceof Uint8Array)) {
    body = new TextEncoder().encode(JSON.stringify(content));
  } else if (typeof content === "string") {
    body = new TextEncoder().encode(content);
  } else {
    body = content;
  }

  const form = new FormData();
  form.append("file", new Blob([body as BlobPart]), "data");

  const resp = await fetch(`${IPFS_API}/add`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) throw new Error(`IPFS add failed: ${resp.status}`);
  const result = await resp.json() as any;
  return result.Hash;
}

export async function get(cid: string): Promise<Uint8Array> {
  const resp = await fetch(`${IPFS_API}/cat?arg=${encodeURIComponent(cid)}`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) throw new Error(`IPFS cat failed: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

export async function getJson(cid: string): Promise<any> {
  const data = await get(cid);
  return JSON.parse(new TextDecoder().decode(data));
}

export async function pin(cid: string): Promise<boolean> {
  const resp = await fetch(`${IPFS_API}/pin/add?arg=${encodeURIComponent(cid)}`, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
  });
  return resp.ok;
}

export async function isAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${IPFS_API}/id`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}
