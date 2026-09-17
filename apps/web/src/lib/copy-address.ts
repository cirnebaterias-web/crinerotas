type ClipboardWriter = Pick<Clipboard, 'writeText'>;

/** A denied/unavailable clipboard never claims success; the UI offers manual copy. */
export async function copyAddress(address: string, clipboard: ClipboardWriter | undefined): Promise<boolean> {
  if (!clipboard || !address.trim()) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      clipboard.writeText(address).then(() => true),
      new Promise<false>((resolve) => { timeout = setTimeout(() => resolve(false), 3_000); }),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
