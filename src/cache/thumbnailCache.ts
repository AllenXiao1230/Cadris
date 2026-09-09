import type { ThumbnailVariant } from "../lib/photos";

const thumbnailSources: Record<ThumbnailVariant, Map<string, string>> = { grid: new Map(), detail: new Map(), original: new Map() };
const thumbnailSourceLimits: Record<ThumbnailVariant, number> = { grid: 96, detail: 12, original: 2 };
type ThumbnailTask = { consumers: number; started: boolean; timer: number | null; promise: Promise<string>; resolve: (source: string) => void };
const thumbnailRequests = new Map<string, ThumbnailTask>();

export function readThumbnailSource(variant: ThumbnailVariant, key: string) {
  const sources = thumbnailSources[variant];
  const source = sources.get(key);
  if (source) { sources.delete(key); sources.set(key, source); }
  return source;
}

export function rememberThumbnailSource(variant: ThumbnailVariant, key: string, source: string) {
  if (!source) return;
  const sources = thumbnailSources[variant];
  sources.delete(key);
  sources.set(key, source);
  while (sources.size > thumbnailSourceLimits[variant]) sources.delete(sources.keys().next().value!);
}

export function acquireThumbnail(requestKey: string, load: () => Promise<string>) {
  let task = thumbnailRequests.get(requestKey);
  if (!task) {
    let resolvePromise: (source: string) => void = () => undefined;
    const promise = new Promise<string>((resolve) => { resolvePromise = resolve; });
    task = { consumers: 0, started: false, timer: null, promise, resolve: resolvePromise };
    const nextTask = task;
    task.timer = window.setTimeout(() => {
      nextTask.started = true;
      nextTask.timer = null;
      void load().catch(() => "").then((source) => {
        thumbnailRequests.delete(requestKey);
        nextTask.resolve(source);
      });
    }, 0);
    thumbnailRequests.set(requestKey, task);
  }
  task.consumers += 1;
  return {
    promise: task.promise,
    release: () => {
      const current = thumbnailRequests.get(requestKey);
      if (!current) return;
      current.consumers -= 1;
      if (!current.started && current.consumers <= 0) {
        if (current.timer !== null) window.clearTimeout(current.timer);
        thumbnailRequests.delete(requestKey);
        current.resolve("");
      }
    },
  };
}

export function clearThumbnailRequests() {
  thumbnailRequests.forEach((task) => {
    if (!task.started && task.timer !== null) window.clearTimeout(task.timer);
    task.resolve("");
  });
  thumbnailRequests.clear();
}

export function clearThumbnailCache() {
  clearThumbnailRequests();
  Object.values(thumbnailSources).forEach((sources) => sources.clear());
}
