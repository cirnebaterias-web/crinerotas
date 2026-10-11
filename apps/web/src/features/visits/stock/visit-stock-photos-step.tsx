'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { LocalAttachment } from '@cirne/contracts';
import { compressStockPhoto, formatPhotoBytes, stockPhotoLimits } from './stock-photo-compression';

interface Props {
  attachments: LocalAttachment[];
  onAdd: (photo: ReturnType<typeof compressStockPhoto> extends Promise<infer T> ? T : never, fileName: string) => Promise<void>;
  onRemove: (offlineId: string) => Promise<void>;
  onDone: () => void;
}

export function VisitStockPhotosStep({ attachments, onAdd, onRemove, onDone }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [urls, setUrls] = useState<Record<string, string>>({});

  useEffect(() => { titleRef.current?.focus(); }, []);

  useEffect(() => {
    const next = Object.fromEntries(attachments.map((attachment) => [
      attachment.offlineId, URL.createObjectURL(attachment.blob),
    ]));
    setUrls(next);
    return () => Object.values(next).forEach((url) => URL.revokeObjectURL(url));
  }, [attachments]);

  const selectFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = '';
    if (!files.length) return;
    if (files.length > stockPhotoLimits.maxCount - attachments.length) {
      setError(`Você pode anexar no máximo ${stockPhotoLimits.maxCount} fotos.`);
      return;
    }
    if (files.some((file) => !file.type.startsWith('image/'))) {
      setError('Selecione somente arquivos de imagem.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      for (const file of files) await onAdd(await compressStockPhoto(file), file.name);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível salvar a foto.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (offlineId: string) => {
    setBusy(true);
    setError('');
    try { await onRemove(offlineId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Não foi possível remover a foto.'); }
    finally { setBusy(false); }
  };

  return <section className="seller-stock-card seller-stock-photos" aria-labelledby="stock-photos-title">
    <p className="seller-kicker">ETAPA FINAL · ESTOQUE</p>
    <h2 id="stock-photos-title" ref={titleRef} tabIndex={-1}>Fotos do estoque</h2>
    <p className="seller-muted">Opcional. Adicione até 3 fotos; elas serão comprimidas antes de serem salvas no aparelho.</p>
    <p className="seller-photo-counter" aria-live="polite"><strong>{attachments.length}/3</strong> fotos adicionadas</p>

    {attachments.length > 0 && <ul className="seller-photo-grid" aria-label="Fotos do estoque salvas">
      {attachments.map((attachment, index) => <li key={attachment.offlineId}>
        {/* The object URL is local and revoked whenever the attachment list changes. */}
        <img src={urls[attachment.offlineId]} alt={`Foto ${index + 1} do estoque`} />
        <span>{formatPhotoBytes(attachment.byteSize)}</span>
        <button type="button" disabled={busy} onClick={() => void remove(attachment.offlineId)}
          aria-label={`Remover foto ${index + 1}`}>Remover</button>
      </li>)}
    </ul>}

    {error && <p className="seller-field-error" role="alert">{error}</p>}
    <input ref={inputRef} className="seller-visually-hidden" type="file" accept="image/*"
      capture="environment" multiple onChange={(event) => void selectFiles(event)} />
    <button className="seller-button seller-secondary" type="button" disabled={busy || attachments.length >= 3}
      onClick={() => inputRef.current?.click()}>{busy ? 'Comprimindo…' : 'Adicionar fotos'}</button>{' '}
    <button className="seller-button seller-primary" type="button" disabled={busy} onClick={onDone}>
      Concluir coleta de estoque
    </button>
  </section>;
}
