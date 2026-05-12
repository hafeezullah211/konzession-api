import { randomUUID } from "node:crypto";
import * as Minio from "minio";

import type { Config } from "../config.js";

const DEFAULT_BUCKET = "konzession";

function pathContainsBucket(pathname: string, bucket: string): boolean {
  const lowerPath = pathname.toLowerCase();
  const b = bucket.toLowerCase();
  return lowerPath.includes(`/${b}/`) || lowerPath.endsWith(`/${b}`);
}

/**
 * Browsers cannot resolve the Docker service hostname `minio`. Map `http://minio:9000/…`
 * (and `127.0.0.1`/`localhost` on container port 9000) to the host-published port (default 9010).
 */
function rewriteInternalMinioHostForBrowser(urlStr: string, bucket: string): string {
  if (process.env.MINIO_REWRITE_INTERNAL_MINIO === "false") return urlStr;
  const b = bucket || DEFAULT_BUCKET;
  try {
    const u = new URL(urlStr);
    if (!pathContainsBucket(u.pathname, b)) return urlStr;

    const browserHost = (process.env.MINIO_BROWSER_PUBLIC_HOST ?? "127.0.0.1").replace(
      /^\[|\]$/g,
      ""
    );
    const browserPort = process.env.MINIO_BROWSER_PUBLIC_PORT ?? "9010";

    if (u.hostname === "minio" && u.port === "9000") {
      u.hostname = browserHost;
      u.port = browserPort;
      return u.toString();
    }
    if (
      (u.hostname === "127.0.0.1" ||
        u.hostname === "localhost" ||
        u.hostname === "::1") &&
      u.port === "9000"
    ) {
      u.hostname = "127.0.0.1";
      u.port = browserPort;
      return u.toString();
    }
    return urlStr;
  } catch {
    return urlStr;
  }
}

/**
 * Mongo may store a URL that worked inside Docker (e.g. `http://minio:9000/bucket/key`) while
 * browsers must use `MINIO_PUBLIC_BASE_URL`. Rebuilds `…/bucket/<objectKey>` under the public base.
 * When `MINIO_PUBLIC_BASE_URL` is unset, still rewrites internal `minio:9000` URLs for local dev.
 * Bucket matching in the path is case-insensitive.
 */
export function normalizeLicenseImageUrlForBrowser(cfg: Config, stored: string | null | undefined): string | null {
  if (!stored?.trim()) return null;
  const s = stored.trim();
  const bucket = (cfg.MINIO_BUCKET?.trim() || DEFAULT_BUCKET).replace(/\/$/, "") || DEFAULT_BUCKET;
  const publicBase = cfg.MINIO_PUBLIC_BASE_URL?.replace(/\/$/, "");

  let out = s;
  if (publicBase) {
    try {
      const parsed = new URL(s);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const bi = parts.findIndex((p) => p.toLowerCase() === bucket.toLowerCase());
      if (bi >= 0) {
        const objectKey = parts.slice(bi + 1).join("/");
        if (objectKey) out = `${publicBase}/${objectKey}`;
      }
    } catch {
      /* keep out = s */
    }
  }

  out = rewriteInternalMinioHostForBrowser(out, bucket);
  return out;
}

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function licenseImageExtension(mimetype: string): string | null {
  return ALLOWED_TYPES[mimetype] ?? null;
}

export type LicenseImageUploader = {
  upload(params: {
    sellerId: string;
    buffer: Buffer;
    contentType: string;
    extension: string;
  }): Promise<{ objectKey: string; publicUrl: string }>;
};

export function createLicenseImageUploader(cfg: Config): LicenseImageUploader | null {
  if (
    !cfg.MINIO_ENDPOINT ||
    !cfg.MINIO_ACCESS_KEY ||
    !cfg.MINIO_SECRET_KEY ||
    !cfg.MINIO_BUCKET ||
    !cfg.MINIO_PUBLIC_BASE_URL
  ) {
    return null;
  }

  const port = cfg.MINIO_PORT ?? (cfg.MINIO_USE_SSL ? 443 : 9000);
  const client = new Minio.Client({
    endPoint: cfg.MINIO_ENDPOINT,
    port,
    useSSL: Boolean(cfg.MINIO_USE_SSL),
    accessKey: cfg.MINIO_ACCESS_KEY,
    secretKey: cfg.MINIO_SECRET_KEY,
  });

  const bucket = cfg.MINIO_BUCKET;
  const publicBase = cfg.MINIO_PUBLIC_BASE_URL.replace(/\/$/, "");

  return {
    async upload({ sellerId, buffer, contentType, extension }) {
      const safeSeller = sellerId.replace(/[^a-f0-9]/gi, "");
      const name = `${randomUUID()}.${extension}`;
      const objectKey = `Licenses/${safeSeller}/${name}`;
      const exists = await client.bucketExists(bucket);
      if (!exists) {
        await client.makeBucket(bucket, "us-east-1");
      }
      await client.putObject(bucket, objectKey, buffer, buffer.length, {
        "Content-Type": contentType,
      });
      const publicUrl = `${publicBase}/${objectKey}`;
      return { objectKey, publicUrl };
    },
  };
}
