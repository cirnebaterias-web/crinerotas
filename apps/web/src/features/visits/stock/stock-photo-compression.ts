export const stockPhotoLimits = {
  maxCount: 3,
  maxDimension: 1600,
  targetBytes: 350 * 1024,
  maxBytes: 2 * 1024 * 1024,
} as const;

export interface CompressedStockPhoto {
  blob: Blob;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  checksum: string;
  originalByteSize: number;
}

export function fitStockPhotoDimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Não foi possível identificar as dimensões da foto.');
  }
  const scale = Math.min(1, stockPhotoLimits.maxDimension / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

async function canvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Não foi possível comprimir a foto.')),
    'image/jpeg',
    quality,
  ));
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function compressStockPhoto(file: File): Promise<CompressedStockPhoto> {
  if (!file.type.startsWith('image/')) throw new Error('Selecione somente arquivos de imagem.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('A imagem selecionada não pôde ser lida.');
  }
  try {
    let dimensions = fitStockPhotoDimensions(bitmap.width, bitmap.height);
    let blob: Blob | undefined;
    for (let scaleAttempt = 0; scaleAttempt < 3; scaleAttempt += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('A compressão de imagens não está disponível neste aparelho.');
      context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height);
      for (const quality of [0.82, 0.72, 0.62, 0.52]) {
        blob = await canvasBlob(canvas, quality);
        if (blob.size <= stockPhotoLimits.targetBytes) break;
      }
      if (blob && blob.size <= stockPhotoLimits.targetBytes) break;
      if (scaleAttempt < 2) {
        dimensions = {
          width: Math.max(1, Math.round(dimensions.width * 0.82)),
          height: Math.max(1, Math.round(dimensions.height * 0.82)),
        };
      }
    }
    if (!blob || blob.size > stockPhotoLimits.maxBytes) {
      throw new Error('A foto continua maior que 2 MB após a compressão. Escolha outra imagem.');
    }
    return {
      blob,
      contentType: 'image/jpeg',
      width: dimensions.width,
      height: dimensions.height,
      checksum: await sha256(blob),
      originalByteSize: file.size,
    };
  } finally {
    bitmap.close();
  }
}

export function formatPhotoBytes(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
