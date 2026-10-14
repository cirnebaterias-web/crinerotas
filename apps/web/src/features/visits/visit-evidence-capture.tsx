'use client';

import { useEffect, useRef, useState } from 'react';
import type { CanonicalRoute, VisitEvidenceIssue } from '@cirne/contracts';
import { compressStockPhoto, type CompressedStockPhoto } from './stock/stock-photo-compression';
import { coordinateDecimal, evidenceIssueLabel, locationAssessment } from './visit-evidence';

export interface VisitEvidenceCaptureValue {
  capturedAt: string;
  photo?: CompressedStockPhoto;
  location?: { latitude: string; longitude: string; accuracyM: string; distanceM?: string };
  issues: VisitEvidenceIssue[];
  justification?: string;
}

interface Props {
  kind: 'checkin' | 'checkout';
  client: CanonicalRoute['stops'][number]['client'];
  busy?: boolean;
  onConfirm: (value: VisitEvidenceCaptureValue) => Promise<void>;
  onCancel: () => void;
}

function decimal(value: number) {
  return String(Math.round(value * 100) / 100);
}

export function VisitEvidenceCapture({ kind, client, busy = false, onConfirm, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [photo, setPhoto] = useState<CompressedStockPhoto>();
  const [preview, setPreview] = useState('');
  const [location, setLocation] = useState<VisitEvidenceCaptureValue['location']>();
  const [issues, setIssues] = useState<VisitEvidenceIssue[]>([]);
  const [justification, setJustification] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const [locating, setLocating] = useState(true);
  const [message, setMessage] = useState('Abrindo a câmera e obtendo a posição…');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const addIssue = (issue: VisitEvidenceIssue) => {
      if (active) setIssues((current) => current.includes(issue) ? current : [...current, issue]);
    };
    void (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('camera');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        });
        if (!active) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraReady(true);
      } catch {
        addIssue('camera_unavailable');
      }
    })();
    if (!navigator.geolocation) {
      addIssue('gps_unavailable');
      setLocating(false);
    } else navigator.geolocation.getCurrentPosition((position) => {
      if (!active) return;
      const assessment = locationAssessment({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: position.coords.accuracy,
        clientLatitude: client.latitude,
        clientLongitude: client.longitude,
      });
      setIssues((current) => [...new Set([...current, ...assessment.issues])]);
      setLocation({
        latitude: coordinateDecimal(position.coords.latitude),
        longitude: coordinateDecimal(position.coords.longitude),
        accuracyM: decimal(position.coords.accuracy),
        ...(assessment.distanceM === undefined ? {} : { distanceM: decimal(assessment.distanceM) }),
      });
      setLocating(false);
    }, () => {
      addIssue('gps_unavailable');
      if (active) setLocating(false);
    }, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
    return () => {
      active = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [client.latitude, client.longitude]);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => {
    if (locating) return;
    setMessage(issues.length ? 'Existe uma exceção que precisa ser justificada.' : 'Posição registrada. Tire a foto da fachada.');
  }, [issues, locating]);

  const capture = async () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d', { alpha: false })?.drawImage(video, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error('capture')),
        'image/jpeg', 0.92,
      ));
      const compressed = await compressStockPhoto(new File([blob], 'fachada-camera.jpg', { type: 'image/jpeg' }));
      if (preview) URL.revokeObjectURL(preview);
      setPhoto(compressed);
      setPreview(URL.createObjectURL(compressed.blob));
      setMessage('Foto tirada pela câmera e comprimida no aparelho.');
    } catch {
      setIssues((current) => current.includes('camera_unavailable') ? current : [...current, 'camera_unavailable']);
      setMessage('A câmera falhou. Informe a justificativa para continuar.');
    }
  };

  const submit = async () => {
    if (saving || busy || locating) return;
    if (!photo && !issues.includes('camera_unavailable')) {
      setMessage('Tire a foto da fachada antes de continuar.');
      return;
    }
    if (issues.length > 0 && justification.trim().length < 10) {
      setMessage('Explique a exceção com pelo menos 10 caracteres.');
      return;
    }
    setSaving(true);
    try {
      await onConfirm({
        capturedAt: new Date().toISOString(),
        ...(photo ? { photo } : {}),
        ...(location ? { location } : {}),
        issues,
        ...(justification.trim() ? { justification: justification.trim() } : {}),
      });
    } catch {
      setMessage('Não foi possível salvar a evidência no aparelho. Tente novamente.');
    } finally {
      setSaving(false);
    }
  };

  return <section className="seller-evidence" role="dialog" aria-modal="true" aria-labelledby="evidence-title">
    <p className="seller-kicker">{kind === 'checkin' ? 'CHECK-IN' : 'CHECKOUT'}</p>
    <h2 id="evidence-title">Foto da fachada e posição</h2>
    <p className="seller-muted">{client.name} · a foto deve ser tirada agora pela câmera. A galeria não está disponível.</p>
    <div className="seller-evidence-camera">
      <video ref={videoRef} playsInline muted aria-label="Visualização da câmera traseira" />
      {preview && <img src={preview} alt="Foto da fachada capturada agora" />}
      {!cameraReady && !issues.includes('camera_unavailable') && <p>Abrindo câmera…</p>}
      {issues.includes('camera_unavailable') && <p>Câmera indisponível neste aparelho.</p>}
    </div>
    {cameraReady && <button className="seller-button seller-primary" type="button" onClick={() => void capture()}>
      {photo ? 'Tirar outra foto' : 'Tirar foto da fachada'}
    </button>}
    <div className="seller-evidence-location" aria-live="polite">
      <strong>{locating ? 'Obtendo GPS…' : location ? `GPS registrado · precisão ${location.accuracyM} m` : 'GPS indisponível'}</strong>
      {location?.distanceM && <span>Distância da loja: {Math.round(Number(location.distanceM))} m</span>}
    </div>
    {issues.length > 0 && <div className="seller-evidence-exception">
      <strong>Revisão necessária</strong>
      <ul>{issues.map((issue) => <li key={issue}>{evidenceIssueLabel(issue)}</li>)}</ul>
      <label htmlFor={`evidence-justification-${kind}`}>Justificativa obrigatória</label>
      <textarea id={`evidence-justification-${kind}`} maxLength={500} value={justification}
        onChange={(event) => setJustification(event.target.value)} />
    </div>}
    <p role="status">{message}</p>
    <div className="seller-evidence-actions">
      <button className="seller-button seller-secondary" type="button" disabled={saving || busy} onClick={onCancel}>Cancelar</button>
      <button className="seller-button seller-primary" type="button" disabled={saving || busy || locating}
        onClick={() => void submit()}>{saving || busy ? 'Salvando…' : kind === 'checkin' ? 'Confirmar e iniciar visita' : 'Confirmar e encerrar visita'}</button>
    </div>
  </section>;
}
