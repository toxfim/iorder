/** What saving needs from the browser; injected so the helper can be tested without one. */
export interface SaveFileEnv {
  readonly document: Document;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** Defers the revoke, so the browser has started reading the blob first. */
  readonly defer: (run: () => void) => void;
}

const browserEnv = (): SaveFileEnv => ({
  document,
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  defer: (run) => void setTimeout(run, 0),
});

/**
 * Hands a downloaded blob to the browser as a file with this name (a temporary `<a download>`).
 * The object URL is revoked right after, so the blob does not stay in memory.
 */
export function saveFile(blob: Blob, fileName: string, env: SaveFileEnv = browserEnv()): void {
  const url = env.createObjectURL(blob);
  const link = env.document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  env.document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    env.defer(() => env.revokeObjectURL(url));
  }
}
