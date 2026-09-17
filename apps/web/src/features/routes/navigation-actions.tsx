import { useId, useState } from 'react';
import { buildGoogleMapsUrl, type NavigationDestination } from '@cirne/domain';
import { copyAddress } from '@/lib/copy-address';

export function NavigationActions({ client, offline, busy }: {
  client: NavigationDestination & { name: string };
  offline: boolean;
  busy: boolean;
}) {
  const descriptionId = useId();
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'manual'>('idle');
  const url = buildGoogleMapsUrl(client);
  const disabled = offline || busy || !url;

  async function copy() {
    setCopyState('copying');
    const copied = await copyAddress(client.address, navigator.clipboard);
    setCopyState(copied ? 'copied' : 'manual');
  }

  return <div className="seller-navigation">
    <div className="seller-navigation-buttons">
      {disabled ? <button className="seller-button seller-primary" disabled aria-describedby={descriptionId}>Navegar <span aria-hidden="true">↗</span></button>
        : <a className="seller-button seller-primary" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
          aria-label={`Navegar para ${client.name} no Google Maps (abre fora do aplicativo)`} aria-describedby={descriptionId}>
          Navegar <span aria-hidden="true">↗</span>
        </a>}
      <button className="seller-button seller-secondary" onClick={() => void copy()} disabled={busy || copyState === 'copying'}
        aria-label={`Copiar endereço de ${client.name}`}>{copyState === 'copying' ? 'Copiando…' : 'Copiar endereço'}</button>
    </div>
    <p id={descriptionId} className="seller-navigation-hint">{offline ? 'Sem conexão para abrir o Maps. Você pode copiar o endereço.'
      : !url ? 'Destino indisponível para navegação. Copie o endereço.'
        : 'Abre o Google Maps; não inicia a visita. Se não abrir, copie o endereço.'}</p>
    {copyState === 'copied' && <p role="status">Endereço copiado.</p>}
    {copyState === 'manual' && <div className="seller-manual-copy">
      <p role="status">Não foi possível copiar automaticamente. Selecione o endereço abaixo e use a opção Copiar do seu aparelho.</p>
      <label htmlFor={`${descriptionId}-address`}>Endereço para cópia manual — {client.name}</label>
      <textarea id={`${descriptionId}-address`} readOnly value={client.address} rows={3} onFocus={(event) => event.currentTarget.select()} />
    </div>}
  </div>;
}
