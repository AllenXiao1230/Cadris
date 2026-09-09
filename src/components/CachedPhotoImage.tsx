import { useEffect, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { acquireThumbnail, readThumbnailSource, rememberThumbnailSource } from "../cache/thumbnailCache";
import type { Photo, ThumbnailVariant } from "../lib/photos";

type CachedPhotoImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { root: string; photo: Photo };

export function CachedPhotoImage({ root, photo, className, onError, ...props }: CachedPhotoImageProps) {
  const variant: ThumbnailVariant = className === "loupe-image" ? "original" : props.style ? "detail" : "grid";
  const profile = window.localStorage.getItem("cadris.preview-profile") === "speed" ? "speed" : window.localStorage.getItem("cadris.preview-profile") === "quality" ? "quality" : "balanced";
  const cacheOnly = variant === "original" && window.localStorage.getItem("cadris.raw-cache-only") === "true";
  const cacheKey = `${root}\u0000${photo.relativePath}\u0000${photo.size}\u0000${photo.modifiedAt}\u0000${profile}\u0000${cacheOnly}`;
  const requestKey = `${variant}\u0000${profile}\u0000${cacheOnly}\u0000${cacheKey}`;
  const [source, setSource] = useState<string | null>(() => readThumbnailSource(variant, cacheKey) ?? null);
  useEffect(() => {
    let mounted = true;
    const cached = readThumbnailSource(variant, cacheKey);
    if (cached) { setSource(cached); return () => { mounted = false; }; }
    setSource(null);
    const request = acquireThumbnail(requestKey, () => invoke<string | null>("thumbnail_for", { root, relativePath: photo.relativePath, variant, profile, cacheOnly }).then((thumbnailSource) => thumbnailSource ?? ""));
    void request.promise.then((nextSource) => {
      rememberThumbnailSource(variant, cacheKey, nextSource);
      if (mounted) setSource(nextSource);
    });
    return () => { mounted = false; request.release(); };
  }, [cacheKey, cacheOnly, photo.relativePath, profile, requestKey, root, variant]);

  function handleError(event: SyntheticEvent<HTMLImageElement, Event>) {
    rememberThumbnailSource(variant, cacheKey, "");
    event.currentTarget.removeAttribute("src");
    onError?.(event);
  }

  return <img {...props} decoding={props.decoding ?? "async"} className={`${className ?? ""}${source ? "" : " is-loading"}`} src={source ?? undefined} onError={handleError} />;
}
