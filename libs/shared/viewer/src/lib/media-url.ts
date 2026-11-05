/** A `<video>` source made from bytes in memory; revoke it when the player goes. */
export interface MediaUrl {
  readonly url: string;
  /** Safe to call twice. */
  revoke(): void;
}

/** The viewer's only object URL for `<video>` (§1.11). */
export function mediaUrl(blob: Blob): MediaUrl {
  let url: string | null = URL.createObjectURL(blob);
  const value = url;
  return {
    url: value,
    revoke(): void {
      if (url) URL.revokeObjectURL(url);
      url = null;
    },
  };
}
