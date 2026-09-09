import { useEffect, useState, type ImgHTMLAttributes, type SyntheticEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { acquireThumbnail, readThumbnailSource, rememberThumbnailSource } from "../cache/thumbnailCache";
import type { Photo, ThumbnailVariant } from "../lib/photos";

type CachedPhotoImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { root: string; photo: Photo };

export function CachedPhotoImage({ root, photo, className, onError, ...props }: CachedPhotoImageProps) {
  const variant: ThumbnailVariant = className === "loupe-image" ? "original" : props.style ? "detail" : "grid";
  const cacheKey = `${root}\u0000${photo.relativePath}\u0000${photo.size}\u0000${photo.modifiedAt}`;
  const requestKey = `${variant}\u0000${cacheKey}`;
  const [source, setSource] = useState<string | null>(() => readThumbnailSource(variant, cacheKey) ?? null);
  useEffect(() => {
    let mounted = true;
    const cached = readThumbnailSource(variant, cacheKey);
    if (cached) { setSource(cached); return () => { mounted = false; }; }
    setSource(null);
    const request = acquireThumbnail(requestKey, () => invoke<string | null>("thumbnail_for", { root, relativePath: photo.relativePath, variant }).then((thumbnailSource) => thumbnailSource ?? ""));
    void request.promise.then((nextSource) => {
      rememberThumbnailSource(variant, cacheKey, nextSource);
      if (mounted) setSource(nextSource);
    });
    return () => { mounted = false; request.release(); };
  }, [cacheKey, photo.relativePath, requestKey, root, variant]);

  function handleError(event: SyntheticEvent<HTMLImageElement, Event>) {
    rememberThumbnailSource(variant, cacheKey, "");
    event.currentTarget.removeAttribute("src");
    onError?.(event);
  }

  return <img {...props} decoding={props.decoding ?? "async"} className={`${className ?? ""}${source ? "" : " is-loading"}`} src={source ?? undefined} onError={handleError} />;
}
